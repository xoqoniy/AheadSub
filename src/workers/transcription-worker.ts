// @ts-nocheck — Worker context, Transformers.js dynamic imports
// ============================================================
// AheadSub — Transcription Worker
// Runs Whisper inference via Transformers.js in a dedicated
// Web Worker. Supports WebGPU and WASM backends.
// ============================================================

import {
  stripNoiseAnnotations,
  isNoiseOrBlankText,
  calculateAudioRMS,
} from '../core/transcription/noise-filter';

let pipeline: any = null;
let transcriber: any = null;
let currentModelId: string | null = null;

// --- Message Handler ---

self.onmessage = async (event: MessageEvent) => {
  const { type, payload } = event.data;

  try {
    switch (type) {
      case 'load_model':
        await loadModel(payload);
        break;

      case 'transcribe':
        await transcribe(payload);
        break;

      case 'unload_model':
        unloadModel();
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }
  } catch (error: any) {
    self.postMessage({
      type: 'error',
      payload: { error: error.message || String(error) },
    });
  }
};

// --- Model Loading ---

async function loadModel(payload: {
  modelId: string;
  language: string;
  useWebGPU: boolean;
}): Promise<void> {
  const { modelId, useWebGPU } = payload;

  // Skip if same model already loaded
  if (currentModelId === modelId && transcriber) {
    self.postMessage({
      type: 'model_loaded',
      payload: { modelId },
    });
    return;
  }

  // Dynamically import Transformers.js
  const { pipeline: createPipeline, env } = await import('@huggingface/transformers');

  // Configure environment for Chrome Extension
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  
  // CRITICAL: Configure ONNX Runtime for Chrome Extension environment
  // Chrome's CSP blocks loading the .mjs proxy worker from CDN.
  // Fix: disable multi-threading (which requires the proxy worker) and
  // point WASM file paths to locally bundled copies.
  const onnxWasmDir = (self.location.origin || '') + '/onnx/';
  
  // Configure via transformers.js env
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = onnxWasmDir;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }
  
  // Also configure directly via onnxruntime-web
  try {
    const ort = await import('onnxruntime-web');
    if (ort.env?.wasm) {
      ort.env.wasm.wasmPaths = onnxWasmDir;
      ort.env.wasm.numThreads = 1;  // Single-threaded to avoid proxy worker CSP issue
      ort.env.wasm.proxy = false;   // Disable proxy worker entirely
    }
  } catch (e) {
    console.warn('[AheadSub Worker] Could not configure ort.env directly:', e);
  }
  
  console.log('[AheadSub Worker] ONNX WASM paths set to:', onnxWasmDir);

  // Determine device
  let device: string = 'wasm';
  if (useWebGPU) {
    try {
      if ('gpu' in self.navigator) {
        const adapter = await (self.navigator as any).gpu?.requestAdapter();
        if (adapter) {
          device = 'webgpu';
          console.log('[AheadSub Worker] Using WebGPU');
        }
      }
    } catch {
      console.log('[AheadSub Worker] WebGPU not available, falling back to WASM');
    }
  }

  self.postMessage({
    type: 'model_progress',
    payload: { status: 'downloading', modelId, device },
  });

  const fileProgress = new Map<string, number>();

  const makeProgressCallback = () => (progress: any) => {
    const fileKey = progress.file || 'model';
    let filePct = 0;
    if (progress.status === 'done') {
      filePct = 100;
    } else if (typeof progress.progress === 'number' && progress.progress > 0) {
      filePct = progress.progress <= 1 ? progress.progress * 100 : progress.progress;
    } else if (progress.total && progress.loaded) {
      filePct = Math.min(100, (progress.loaded / progress.total) * 100);
    }
    fileProgress.set(fileKey, filePct);

    let sum = 0;
    let count = 0;
    for (const p of fileProgress.values()) {
      sum += p;
      count++;
    }
    const overallProgress = count > 0 ? Math.round(sum / count) : 0;

    self.postMessage({
      type: 'model_progress',
      payload: {
        status: progress.status,
        progress: overallProgress,
        file: progress.file,
        loaded: progress.loaded,
        total: progress.total,
        modelId,
      },
    });
  };

  try {
    transcriber = await createPipeline(
      'automatic-speech-recognition',
      modelId,
      {
        device,
        progress_callback: makeProgressCallback(),
      }
    );
  } catch (err: any) {
    if (device === 'webgpu') {
      console.warn('[AheadSub Worker] WebGPU initialization failed, falling back to WASM:', err);
      device = 'wasm';
      transcriber = await createPipeline(
        'automatic-speech-recognition',
        modelId,
        {
          device: 'wasm',
          progress_callback: makeProgressCallback(),
        }
      );
    } else {
      throw err;
    }
  }

  currentModelId = modelId;

  self.postMessage({
    type: 'model_loaded',
    payload: { modelId, device },
  });
}

// --- Transcription ---

async function transcribe(payload: {
  audioData: ArrayBuffer;
  sampleRate: number;
  chunkIndex: number;
  chunkStartTime: number;
  language: string;
}): Promise<void> {
  if (!transcriber) {
    throw new Error('Model not loaded');
  }

  const startTime = performance.now();

  const { audioData, chunkIndex, chunkStartTime, language } = payload;

  // Convert ArrayBuffer to Float32Array
  const audioFloat32 = new Float32Array(audioData);

  // Compute RMS audio volume energy to detect silence / low-energy static
  const rms = calculateAudioRMS(audioFloat32);
  if (rms < 0.003) {
    console.log(`[AheadSub Worker] Low energy/silence detected (RMS: ${rms.toFixed(5)}), skipping chunk ${chunkIndex}`);
    self.postMessage({
      type: 'transcription_result',
      payload: {
        chunkIndex,
        chunkStartTime,
        cues: [],
        detectedLanguage: null,
        processingTimeMs: performance.now() - startTime,
      },
    });
    return;
  }

  // Map 2-letter ISO codes to Transformers.js / Whisper language names
  const WHISPER_LANG_NAMES: Record<string, string> = {
    en: 'english',
    ru: 'russian',
    uz: 'uzbek',
    ja: 'japanese',
    ko: 'korean',
    zh: 'chinese',
    de: 'german',
    fr: 'french',
    es: 'spanish',
    pt: 'portuguese',
    it: 'italian',
    ar: 'arabic',
    hi: 'hindi',
    uk: 'ukrainian',
    pl: 'polish',
    tr: 'turkish',
    nl: 'dutch',
    sv: 'swedish',
    cs: 'czech',
    th: 'thai',
  };

  // If explicit language is provided and not 'auto', resolve full language name
  const rawLang = (language && language !== 'auto') ? language.toLowerCase() : undefined;
  const explicitLang = rawLang ? (WHISPER_LANG_NAMES[rawLang] || rawLang) : undefined;

  // Run transcription with native segment timestamps
  const options: any = {
    return_timestamps: true,
    temperature: 0.0,
    task: 'transcribe',
    condition_on_previous_text: false,
    no_speech_threshold: 0.6,
  };

  if (explicitLang) {
    options.language = explicitLang;
    options.generate_kwargs = {
      language: explicitLang,
      task: 'transcribe',
    };
  }

  const result = await transcriber(audioFloat32, options);

  const processingTimeMs = performance.now() - startTime;

  // Convert Whisper output to our SubtitleCue format
  const cues = buildCuesFromWhisperOutput(result, chunkStartTime);

  self.postMessage({
    type: 'transcription_result',
    payload: {
      chunkIndex,
      chunkStartTime,
      cues,
      detectedLanguage: result.language || null,
      processingTimeMs,
    },
  });
}

// --- Cue Building ---

interface WhisperChunk {
  text: string;
  timestamp: [number, number] | null;
}

function buildCuesFromWhisperOutput(
  result: any,
  chunkStartTime: number
): any[] {
  const cues: any[] = [];

  if (!result.chunks || result.chunks.length === 0) {
    // Fallback: single cue from full text
    if (result.text && result.text.trim()) {
      const cleanFullText = stripNoiseAnnotations(result.text.trim());
      if (cleanFullText && !isNoiseOrBlankText(cleanFullText)) {
        cues.push({
          id: `cue-${chunkStartTime}-0`,
          startTime: chunkStartTime,
          endTime: chunkStartTime + 5,
          text: formatCueText(cleanFullText, 42),
          words: [],
        });
      }
    }
    return cues;
  }

  const MAX_CHARS = 42;
  const MAX_LINES = 2;
  const MIN_CUE_DURATION = 0.8;
  const MAX_CUE_DURATION = 7.0;

  let cueIndex = 0;

  for (let i = 0; i < result.chunks.length; i++) {
    const chunk = result.chunks[i];
    let rawChunkText = chunk.text?.trim();
    if (!rawChunkText || isNoiseOrBlankText(rawChunkText)) continue;

    const text = stripNoiseAnnotations(rawChunkText);
    if (!text || isNoiseOrBlankText(text)) continue;

    // Handle timestamps safely — never drop text due to null timestamps
    let [rawStart, rawEnd] = chunk.timestamp || [null, null];
    if (rawStart === null || rawStart === undefined) {
      rawStart = i > 0 ? (result.chunks[i - 1].timestamp?.[1] ?? 0) : 0;
    }
    if (rawEnd === null || rawEnd === undefined) {
      const nextStart = result.chunks[i + 1]?.timestamp?.[0];
      if (nextStart !== null && nextStart !== undefined && nextStart > rawStart) {
        rawEnd = nextStart;
      } else {
        rawEnd = Math.min(rawStart + Math.max(MIN_CUE_DURATION, Math.min(MAX_CUE_DURATION, text.length * 0.08)), 30.0);
      }
    }

    if (rawEnd <= rawStart) {
      rawEnd = Math.min(rawStart + MIN_CUE_DURATION, 30.0);
    }

    const absStart = chunkStartTime + rawStart;
    const absEnd = Math.max(chunkStartTime + rawEnd, absStart + MIN_CUE_DURATION);

    if (text.length <= MAX_CHARS * MAX_LINES) {
      cues.push({
        id: `cue-${chunkStartTime}-${cueIndex++}`,
        startTime: absStart,
        endTime: absEnd,
        text: formatCueText(text, MAX_CHARS),
        words: [],
      });
    } else {
      // Split long sentences at word boundaries
      const parts = splitLongText(text, MAX_CHARS * MAX_LINES);
      const partDuration = (absEnd - absStart) / parts.length;
      for (let p = 0; p < parts.length; p++) {
        const pStart = absStart + p * partDuration;
        const pEnd = pStart + partDuration;
        cues.push({
          id: `cue-${chunkStartTime}-${cueIndex++}`,
          startTime: pStart,
          endTime: pEnd,
          text: formatCueText(parts[p]!, MAX_CHARS),
          words: [],
        });
      }
    }
  }

  return cues;
}

function splitLongText(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  const words = text.split(/\s+/);
  let current = '';

  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxLen && current.length > 0) {
      parts.push(current.trim());
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts.length > 0 ? parts : [text];
}

function formatCueText(text: string, maxChars: number): string {
  if (!text) return '';

  // 0. Strip noise annotations like [BLANK_AUDIO] or (music)
  text = stripNoiseAnnotations(text);
  if (!text) return '';

  // 1. Normalize spaces
  text = text.trim().replace(/\s+/g, ' ');

  // 2. Fix punctuation spacing (no space before punctuation, ensure single space after)
  text = text.replace(/\s+([.,!?:;…])/g, '$1');
  text = text.replace(/([.,!?:;…])([^\s0-9.,!?:;…"'\)\]»])/g, '$1 $2');

  // 3. Dialogue dash formatting
  text = text.replace(/(^|\s)--(\s|$)/g, '$1—$2');
  text = text.replace(/^-\s*/g, '— ');

  // 4. Ensure start of sentences and lines are capitalized (handles Latin and Cyrillic)
  text = text.replace(/(^|[.!?…]\s+)([a-zа-яё])/g, (_, p1, p2) => p1 + p2.toUpperCase());

  // 5. Common acronyms in Russian and English
  const ACRONYMS: Record<string, string> = {
    'сша': 'США',
    'рф': 'РФ',
    'ссср': 'СССР',
    'фсб': 'ФСБ',
    'мвд': 'МВД',
    'мгу': 'МГУ',
    'нато': 'НАТО',
    'оон': 'ООН',
    'usa': 'USA',
    'uk': 'UK',
    'fbi': 'FBI',
    'cia': 'CIA',
    'nato': 'NATO',
    'un': 'UN',
    'ai': 'AI',
    'tv': 'TV',
    'id': 'ID',
  };
  text = text.replace(/\b([a-zа-яё]+)\b/gi, (word) => {
    const lower = word.toLowerCase();
    return ACRONYMS[lower] || word;
  });

  // If fits on one line, return as-is
  if (text.length <= maxChars) return text;

  // Split into two lines at a natural break point (punctuation preferred, then space)
  const midpoint = Math.floor(text.length / 2);
  let splitIndex = -1;

  // Check for punctuation near midpoint
  for (let offset = 0; offset < midpoint; offset++) {
    const right = midpoint + offset;
    const left = midpoint - offset;
    if (right < text.length && /[,;—]\s/.test(text.substring(right - 1, right + 1))) {
      splitIndex = right;
      break;
    }
    if (left > 0 && /[,;—]\s/.test(text.substring(left - 1, left + 1))) {
      splitIndex = left;
      break;
    }
  }

  // Fallback: look for a space near the midpoint
  if (splitIndex < 0) {
    for (let offset = 0; offset < midpoint; offset++) {
      if (text[midpoint + offset] === ' ') {
        splitIndex = midpoint + offset;
        break;
      }
      if (text[midpoint - offset] === ' ') {
        splitIndex = midpoint - offset;
        break;
      }
    }
  }

  if (splitIndex < 0) return text;

  return text.substring(0, splitIndex).trim() + '\n' + text.substring(splitIndex).trim();
}

function unloadModel(): void {
  transcriber = null;
  currentModelId = null;
}
