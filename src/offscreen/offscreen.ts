// ============================================================
// AheadSub — Offscreen Document Script
// Runs in an offscreen document context with DOM access.
// Has full host_permissions (no CORS issues).
// Spawns Web Workers for Whisper AI inference.
// Orchestrates audio extraction, WebCodecs decoding, and transcription.
// ============================================================

import { MessageType } from '../core/messages';
import type {
  ExtensionMessage,
  TranscribeChunkPayload,
  TranscriptionResultPayload,
} from '../core/messages';
import { WHISPER_MODELS, WHISPER_SAMPLE_RATE } from '../core/constants';
import { AudioExtractor } from '../core/audio/audio-extractor';
import { PipelineState, ProcessingMode, AudioAccessMethod } from '../core/types';
import type { SubtitleCue, AheadSubSettings, MediaInfo, PipelineProgress } from '../core/types';

// --- State ---

let transcriptionWorker: Worker | null = null;
let audioContext: AudioContext | null = null;
let isModelLoaded = false;
let lastRequestedTabId = 0;

interface TabPipelineState {
  abort: boolean;
  extractor: AudioExtractor;
  onChunk?: (chunk: any) => Promise<void>;
}

const activePipelines = new Map<number, TabPipelineState>();
const pendingChunks = new Map<number, (res: TranscriptionResultPayload) => void>();
const tabLanguages = new Map<number, string>();

function sendToTabViaBackground(tabId: number, message: any): void {
  chrome.runtime.sendMessage({
    type: 'FORWARD_TO_TAB',
    payload: {
      tabId,
      message,
    },
  }).catch(() => {});
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true;
});

async function handleMessage(
  message: ExtensionMessage,
  sendResponse: (r: any) => void
): Promise<void> {
  try {
    switch (message.type) {
      case MessageType.OFFSCREEN_LOAD_MODEL:
        await handleLoadModel(message.payload as any);
        sendResponse({ success: true });
        break;

      case MessageType.START_OFFSCREEN_PIPELINE:
        handleStartOffscreenPipeline(message.payload as any);
        sendResponse({ success: true });
        break;

      case MessageType.STOP_OFFSCREEN_PIPELINE: {
        const targetTabId = (message.payload as any)?.tabId;
        if (targetTabId) {
          sendToTabViaBackground(targetTabId, { type: 'AHEADSUB_STOP_STREAM_CAPTURE' });
        }
        if (targetTabId && activePipelines.has(targetTabId)) {
          const p = activePipelines.get(targetTabId)!;
          p.abort = true;
          p.extractor.destroy();
          activePipelines.delete(targetTabId);
        } else {
          for (const p of activePipelines.values()) {
            p.abort = true;
            p.extractor.destroy();
          }
          activePipelines.clear();
        }
        sendResponse({ success: true });
        break;
      }

      case 'OFFSCREEN_PROCESS_LIVE_CHUNK' as any: {
        const p = message.payload as any;
        const targetTabId = p.tabId || lastRequestedTabId || Array.from(activePipelines.keys())[0] || 0;
        const liveLanguage = tabLanguages.get(targetTabId) || tabLanguages.get(lastRequestedTabId) || 'auto';
        
        if (p.pcmData && p.pcmData.length > 0) {
          const pcm = new Float32Array(p.pcmData);
          try {
            const res = await transcribeChunkOffscreen(
              pcm,
              p.chunkIndex,
              p.startTime,
              liveLanguage
            );

            // Forward transcription result tagged with targetTabId
            chrome.runtime.sendMessage({
              type: MessageType.OFFSCREEN_TRANSCRIPTION_RESULT,
              payload: {
                tabId: targetTabId,
                cues: res.cues,
                chunkStartTime: p.startTime,
                chunkIndex: p.chunkIndex,
                detectedLanguage: res.detectedLanguage,
                processingTimeMs: res.processingTimeMs,
              },
            });

            // Update progress bar state immediately
            chrome.runtime.sendMessage({
              type: MessageType.PIPELINE_PROGRESS,
              payload: {
                tabId: targetTabId,
                state: PipelineState.TRANSCRIBING,
                mode: ProcessingMode.REALTIME,
                processedDuration: p.endTime,
                totalDuration: Math.max(p.endTime, p.endTime + 30),
                currentChunkStart: p.startTime,
                currentChunkEnd: p.endTime,
                cuesGenerated: res.cues ? res.cues.length : 0,
                safePlaybackThrough: p.startTime,
              } as any,
            });
          } catch (tErr) {
            console.error('[AheadSub Offscreen] Live chunk transcription error:', tErr);
          }
        }
        sendResponse({ success: true });
        break;
      }

      case MessageType.OFFSCREEN_TRANSCRIBE_CHUNK:
        await handleTranscribeChunk(message.payload as TranscribeChunkPayload);
        sendResponse({ success: true });
        break;

      case MessageType.OFFSCREEN_DECODE_AUDIO:
        await handleDecodeAudio(message.payload as any);
        sendResponse({ success: true });
        break;

      case MessageType.OFFSCREEN_DETECT_HARDWARE:
        await handleDetectHardware(sendResponse);
        break;

      default:
        sendResponse({ ignored: true });
    }
  } catch (error) {
    console.error('[AheadSub Offscreen] Error:', error);
    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_ERROR,
      payload: { error: String(error) },
    });
    sendResponse({ error: String(error) });
  }
}

// --- Model Loading ---

async function handleLoadModel(payload: {
  modelId: string;
  language: string;
  useWebGPU: boolean;
  tabId?: number;
}): Promise<void> {
  lastRequestedTabId = payload.tabId ?? 0;
  if (payload.language) {
    tabLanguages.set(lastRequestedTabId, payload.language);
  }
  console.log(`[AheadSub Offscreen] Loading model: ${payload.modelId} (Tab: ${lastRequestedTabId}, Lang: ${payload.language})`);

  // Notify background that model is loading
  chrome.runtime.sendMessage({
    type: MessageType.OFFSCREEN_MODEL_PROGRESS,
    payload: { status: 'loading', modelId: payload.modelId, tabId: lastRequestedTabId },
  });

  // Create or re-use the transcription worker
  if (!transcriptionWorker) {
    transcriptionWorker = new Worker(
      new URL('../workers/transcription-worker.ts', import.meta.url),
      { type: 'module' }
    );

    transcriptionWorker.onmessage = handleWorkerMessage;
    transcriptionWorker.onerror = (e) => {
      console.error('[AheadSub Offscreen] Worker error:', e);
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_ERROR,
        payload: { error: e.message, tabId: lastRequestedTabId },
      });
    };
  }

  const modelConfig = WHISPER_MODELS[payload.modelId];
  if (!modelConfig) {
    throw new Error(`Unknown model: ${payload.modelId}`);
  }

  // Send load command to worker
  transcriptionWorker.postMessage({
    type: 'load_model',
    payload: {
      modelId: modelConfig.onnxModelId,
      language: payload.language,
      useWebGPU: payload.useWebGPU,
    },
  });
}

// --- Offscreen Pipeline Orchestration ---

async function handleStartOffscreenPipeline(payload: {
  videoInfo: MediaInfo;
  settings: AheadSubSettings;
  tabId?: number;
}): Promise<void> {
  const tabId = payload.tabId ?? 0;
  const extractor = new AudioExtractor();
  const pipelineState: TabPipelineState = { abort: false, extractor };
  activePipelines.set(tabId, pipelineState);

  const { videoInfo, settings } = payload;
  if (settings.spokenLanguage) {
    tabLanguages.set(tabId, settings.spokenLanguage);
  }

  let totalDuration = (videoInfo.duration && isFinite(videoInfo.duration)) ? videoInfo.duration : 0;
  const allCues: SubtitleCue[] = [];
  let processedDuration = 0;
  // Per-pipeline resolved language — starts from user-set value, can be auto-locked after first chunk detection
  // NOTE: we use a LOCAL copy so we never mutate the shared settings object passed by reference
  let resolvedLanguage: string = settings.spokenLanguage || 'auto';

  console.log(`[AheadSub Offscreen] Starting audio pipeline for Tab ${tabId}:`, videoInfo.title || 'video', {
    manifestUrl: videoInfo.manifestUrl,
    sourceUrl: videoInfo.sourceUrl,
    method: videoInfo.audioAccessMethod,
    totalDuration,
  });

  const onChunk = async (chunk: {
    pcmData: Float32Array;
    sampleRate: number;
    startTime: number;
    endTime: number;
    chunkIndex: number;
  }) => {
    if (pipelineState.abort) return;

    console.log(
      `[AheadSub Offscreen] [Tab ${tabId}] Transcribing chunk ${chunk.chunkIndex} (${chunk.startTime.toFixed(1)}s - ${chunk.endTime.toFixed(1)}s)...`
    );

    try {
      // Resolve language: check explicit setting or detect from Cyrillic context
      // Use local resolvedLanguage — never mutate shared settings object
      let targetLanguage = resolvedLanguage;
      if (!targetLanguage || targetLanguage === 'auto') {
        const titleText = (videoInfo.title || '') + ' ' + (videoInfo.sourceUrl || '') + ' ' + (videoInfo.manifestUrl || '') + ' ' + (videoInfo.pageUrl || '');
        const hasCyrillic = /[а-яА-ЯёЁ]/.test(titleText);
        if (hasCyrillic) {
          targetLanguage = 'ru';
        } else {
          targetLanguage = 'auto';
        }
      }

      const result = await transcribeChunkOffscreen(
        chunk.pcmData,
        chunk.chunkIndex,
        chunk.startTime,
        targetLanguage
      );

      // If language was 'auto' and Whisper detected language, lock onto it for THIS pipeline only
      // NEVER mutate the shared settings object — that would bleed into future sessions
      if (result.detectedLanguage && result.detectedLanguage !== 'unknown' && resolvedLanguage === 'auto') {
        resolvedLanguage = result.detectedLanguage;
      }

      const newMergedCues = mergeCuesWithoutDuplicates(allCues, result.cues);
      processedDuration = Math.max(processedDuration, chunk.endTime);

      // Send result to background tagged with tabId
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_TRANSCRIPTION_RESULT,
        payload: {
          tabId,
          cues: newMergedCues,
          chunkStartTime: chunk.startTime,
          chunkIndex: chunk.chunkIndex,
          detectedLanguage: result.detectedLanguage,
          processingTimeMs: result.processingTimeMs,
        },
      });

      // Update progress tagged with tabId
      chrome.runtime.sendMessage({
        type: MessageType.PIPELINE_PROGRESS,
        payload: {
          tabId,
          state: PipelineState.TRANSCRIBING,
          mode: settings.processingMode || ProcessingMode.FULL_PRE_GENERATION,
          processedDuration,
          totalDuration: Math.max(totalDuration, processedDuration),
          currentChunkStart: chunk.startTime,
          currentChunkEnd: chunk.endTime,
          cuesGenerated: allCues.length,
          safePlaybackThrough: chunk.startTime,
        } as any,
      });
    } catch (err) {
      console.warn(`[AheadSub Offscreen] [Tab ${tabId}] Chunk ${chunk.chunkIndex} transcription error:`, err);
    }
  };

  const onProgress = (segIdx: number, totalSegs: number, manifestDuration?: number) => {
    if (pipelineState.abort) return;
    if (manifestDuration && (totalDuration <= 0 || !isFinite(totalDuration))) {
      totalDuration = manifestDuration;
    }
    const safeTotal = totalDuration > 0 ? totalDuration : (manifestDuration || (totalSegs > 0 ? totalSegs * 4 : 0));
    const approxDuration = safeTotal > 0 && totalSegs > 0 ? (segIdx / totalSegs) * safeTotal : 0;

    chrome.runtime.sendMessage({
      type: MessageType.PIPELINE_PROGRESS,
      payload: {
        tabId,
        state: PipelineState.TRANSCRIBING,
        mode: settings.processingMode || ProcessingMode.FULL_PRE_GENERATION,
        processedDuration: Math.max(processedDuration, approxDuration),
        totalDuration: safeTotal,
        currentChunkStart: approxDuration,
        currentChunkEnd: approxDuration + 30,
        cuesGenerated: allCues.length,
        safePlaybackThrough: processedDuration,
      } as any,
    });
  };

  try {
    pipelineState.onChunk = onChunk;
    let manifest = videoInfo.manifestUrl;

    // Poll background if manifest or direct HTTP audio URL is missing
    if (!manifest && (!videoInfo.sourceUrl || !videoInfo.sourceUrl.startsWith('http'))) {
      console.log(`[AheadSub Offscreen] [Tab ${tabId}] Manifest/Audio URL missing, polling background...`);
      for (let i = 0; i < 6; i++) {
        if (pipelineState.abort) break;
        await new Promise((r) => setTimeout(r, 400));
        try {
          const bgState: any = await chrome.runtime.sendMessage({
            type: MessageType.GET_VIDEO_INFO,
            payload: { tabId },
          });
          if (bgState?.info?.manifestUrl) {
            manifest = bgState.info.manifestUrl;
            console.log(`[AheadSub Offscreen] [Tab ${tabId}] Retrieved late manifest:`, manifest);
            break;
          }
          if (bgState?.info?.sourceUrl && bgState.info.sourceUrl.startsWith('http')) {
            videoInfo.sourceUrl = bgState.info.sourceUrl;
            console.log(`[AheadSub Offscreen] [Tab ${tabId}] Retrieved audio stream URL:`, videoInfo.sourceUrl);
            break;
          }
        } catch {}
      }
    }

    if (manifest) {
      console.log(`[AheadSub Offscreen] [Tab ${tabId}] Extracting from HLS manifest:`, manifest);
      try {
        await extractor.extractFromHLS(manifest, onChunk, onProgress);
      } catch (hlsErr: any) {
        console.warn(`[AheadSub Offscreen] [Tab ${tabId}] HLS extraction failed (${hlsErr.message}), falling back to live audio capture from player...`);
        chrome.runtime.sendMessage({
          type: MessageType.PIPELINE_PROGRESS,
          payload: {
            tabId,
            state: PipelineState.TRANSCRIBING,
            mode: ProcessingMode.REALTIME,
            processedDuration: 0,
            totalDuration: totalDuration || 0,
            currentChunkStart: 0,
            currentChunkEnd: 15,
            cuesGenerated: allCues.length,
            safePlaybackThrough: 0,
          } as any,
        });
        sendToTabViaBackground(tabId, {
          type: 'AHEADSUB_START_STREAM_CAPTURE',
          payload: { tabId }
        });
        return;
      }
    } else if (videoInfo.sourceUrl && videoInfo.sourceUrl.startsWith('http')) {
      console.log(`[AheadSub Offscreen] [Tab ${tabId}] Extracting from direct URL:`, videoInfo.sourceUrl);
      try {
        await extractor.extractFromURL(videoInfo.sourceUrl, onChunk);
      } catch (urlErr: any) {
        console.warn(`[AheadSub Offscreen] [Tab ${tabId}] URL extraction failed (${urlErr.message}), falling back to live audio capture...`);
        sendToTabViaBackground(tabId, {
          type: 'AHEADSUB_START_STREAM_CAPTURE',
          payload: { tabId }
        });
        return;
      }
    } else {
      console.log(`[AheadSub Offscreen] [Tab ${tabId}] Activating live audio capture from page...`);
      sendToTabViaBackground(tabId, {
        type: 'AHEADSUB_START_STREAM_CAPTURE',
        payload: { tabId }
      });
      return;
    }

    if (!pipelineState.abort) {
      if (allCues.length === 0) {
        console.log(`[AheadSub Offscreen] [Tab ${tabId}] 0 cues from pre-extraction, activating live audio capture...`);
        sendToTabViaBackground(tabId, {
          type: 'AHEADSUB_START_STREAM_CAPTURE',
          payload: { tabId }
        });
        return;
      }
      console.log(`[AheadSub Offscreen] [Tab ${tabId}] Pipeline complete! Generated ${allCues.length} cues.`);
      chrome.runtime.sendMessage({
        type: MessageType.GENERATION_COMPLETE,
        payload: {
          tabId,
          cues: allCues,
        },
      });
    }
  } catch (error: any) {
    if (!pipelineState.abort) {
      console.error(`[AheadSub Offscreen] [Tab ${tabId}] Pipeline failed:`, error);
      chrome.runtime.sendMessage({
        type: MessageType.GENERATION_ERROR,
        payload: {
          tabId,
          error: String(error?.message || error),
        },
      });
    }
  } finally {
    extractor.destroy();
    activePipelines.delete(tabId);
  }
}

function transcribeChunkOffscreen(
  pcmData: Float32Array,
  chunkIndex: number,
  startTime: number,
  language: string
): Promise<TranscriptionResultPayload> {
  return new Promise((resolve, reject) => {
    if (!transcriptionWorker) {
      return reject(new Error('Transcription worker not ready'));
    }

    const timeout = setTimeout(() => {
      pendingChunks.delete(chunkIndex);
      reject(new Error(`Transcription timeout for chunk ${chunkIndex}`));
    }, 120000);

    pendingChunks.set(chunkIndex, (res) => {
      clearTimeout(timeout);
      resolve(res);
    });

    const buffer = pcmData.buffer.slice(0);
    transcriptionWorker.postMessage(
      {
        type: 'transcribe',
        payload: {
          audioData: buffer,
          sampleRate: WHISPER_SAMPLE_RATE,
          chunkIndex,
          chunkStartTime: startTime,
          language,
        },
      },
      [buffer]
    );
  });
}

// --- Transcription via Message ---

async function handleTranscribeChunk(payload: TranscribeChunkPayload): Promise<void> {
  if (!transcriptionWorker) {
    throw new Error('Transcription worker not initialized');
  }

  const float32Array = new Float32Array(payload.audioData as any);
  const buffer = float32Array.buffer;

  transcriptionWorker.postMessage(
    {
      type: 'transcribe',
      payload: {
        audioData: buffer,
        sampleRate: payload.sampleRate,
        chunkIndex: payload.chunkIndex,
        chunkStartTime: payload.chunkStartTime,
        language: payload.language,
      },
    },
    [buffer]
  );
}

// --- Audio Decoding ---

async function handleDecodeAudio(payload: {
  audioData: ArrayBuffer;
  targetSampleRate: number;
  startTime: number;
  chunkIndex: number;
}): Promise<void> {
  if (!audioContext) {
    audioContext = new AudioContext({ sampleRate: payload.targetSampleRate || WHISPER_SAMPLE_RATE });
  }

  try {
    const audioBuffer = await audioContext.decodeAudioData(payload.audioData.slice(0));

    const monoData = mixToMono(audioBuffer);

    let pcmData: Float32Array;
    if (audioBuffer.sampleRate !== WHISPER_SAMPLE_RATE) {
      pcmData = resample(monoData, audioBuffer.sampleRate, WHISPER_SAMPLE_RATE);
    } else {
      pcmData = monoData;
    }

    chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_AUDIO_DECODED,
      payload: {
        pcmData: Array.from(pcmData),
        sampleRate: WHISPER_SAMPLE_RATE,
        duration: pcmData.length / WHISPER_SAMPLE_RATE,
        chunkIndex: payload.chunkIndex,
        startTime: payload.startTime,
      },
    });
  } catch (error) {
    throw new Error(`Audio decode failed: ${error}`);
  }
}

// --- Hardware Detection ---

async function handleDetectHardware(sendResponse: (r: any) => void): Promise<void> {
  const info: any = {
    webgpu: false,
    wasm: typeof WebAssembly !== 'undefined',
    simd: false,
    threads: typeof SharedArrayBuffer !== 'undefined',
    estimatedCores: navigator.hardwareConcurrency || 4,
    estimatedMemoryGB: (navigator as any).deviceMemory || 4,
  };

  try {
    if ('gpu' in navigator) {
      const adapter = await (navigator as any).gpu.requestAdapter();
      if (adapter) {
        info.webgpu = true;
        info.webgpuAdapter = adapter.name || 'Unknown GPU';
      }
    }
  } catch {}

  try {
    info.simd = WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ])
    );
  } catch {
    info.simd = false;
  }

  sendResponse({
    type: MessageType.OFFSCREEN_HARDWARE_INFO,
    payload: info,
  });
}

// --- Worker Message Handler ---

function handleWorkerMessage(event: MessageEvent): void {
  const { type, payload } = event.data;

  switch (type) {
    case 'model_loaded':
      isModelLoaded = true;
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_MODEL_READY,
        payload: { modelId: payload.modelId, tabId: lastRequestedTabId },
      });
      break;

    case 'model_progress':
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_MODEL_PROGRESS,
        payload: { ...payload, tabId: lastRequestedTabId },
      });
      break;

    case 'transcription_result': {
      const resolver = pendingChunks.get(payload.chunkIndex);
      if (resolver) {
        pendingChunks.delete(payload.chunkIndex);
        resolver(payload as TranscriptionResultPayload);
      }
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_TRANSCRIPTION_RESULT,
        payload: payload as TranscriptionResultPayload,
      });
      break;
    }

    case 'error': {
      for (const [, resolver] of pendingChunks.entries()) {
        resolver({ cues: [], chunkIndex: 0, chunkStartTime: 0, processingTimeMs: 0 });
      }
      pendingChunks.clear();
      chrome.runtime.sendMessage({
        type: MessageType.OFFSCREEN_ERROR,
        payload: { error: payload.error },
      });
      break;
    }
  }
}

// --- Audio Utilities ---

function mixToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }

  const length = buffer.length;
  const mono = new Float32Array(length);
  const channels = buffer.numberOfChannels;

  for (let ch = 0; ch < channels; ch++) {
    const channelData = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      mono[i] += channelData[i]! / channels;
    }
  }

  return mono;
}

function resample(data: Float32Array, fromRate: number, toRate: number): Float32Array {
  const ratio = fromRate / toRate;
  const newLength = Math.round(data.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const low = Math.floor(srcIndex);
    const high = Math.min(low + 1, data.length - 1);
    const frac = srcIndex - low;
    result[i] = data[low]! * (1 - frac) + data[high]! * frac;
  }

  return result;
}

function mergeCuesWithoutDuplicates(
  existingCues: SubtitleCue[],
  newCues: SubtitleCue[]
): SubtitleCue[] {
  if (existingCues.length === 0) {
    existingCues.push(...newCues);
    return newCues;
  }
  if (newCues.length === 0) return [];

  const added: SubtitleCue[] = [];

  for (const cue of newCues) {
    const lastExisting = existingCues[existingCues.length - 1];

    if (lastExisting) {
      // If new cue is completely inside or ends well before the last existing cue, skip duplicate
      if (cue.endTime <= lastExisting.endTime - 0.2) {
        continue;
      }

      // If new cue starts close to last cue and matches text prefix:
      // replace truncated last cue with complete sentence
      const timeDiff = Math.abs(cue.startTime - lastExisting.startTime);
      const textMatches =
        cue.text.toLowerCase().startsWith(lastExisting.text.toLowerCase().slice(0, 8)) ||
        lastExisting.text.toLowerCase().startsWith(cue.text.toLowerCase().slice(0, 8));

      if ((timeDiff < 1.8 || cue.startTime < lastExisting.endTime) && textMatches) {
        if (cue.text.length > lastExisting.text.length) {
          existingCues[existingCues.length - 1] = cue;
          added.push(cue);
        }
        continue;
      }
    }

    existingCues.push(cue);
    added.push(cue);
  }

  return added;
}

console.log('[AheadSub] Offscreen document initialized');
