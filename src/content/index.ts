// ============================================================
// AheadSub — Content Script Entry Point
// Initializes media detection, subtitle overlay, and sync
// engine on every page. Communicates with background.
// ============================================================

import { MediaDetector } from './media-detector';
import { SubtitleOverlay } from './subtitle-overlay';
import { SyncEngine } from './sync-engine';
import { parseVTT, parseSRT } from './vtt-parser';
import { AheadPipeline } from '../core/pipeline/ahead-pipeline';
import { ProcessingMode, AudioAccessMethod } from '../core/types';
import type { MediaInfo, SubtitleCue, AheadSubSettings } from '../core/types';
import { MessageType } from '../core/messages';
import type { ExtensionMessage, InjectSubtitlesPayload, UpdateSubtitlesPayload } from '../core/messages';

class AheadSubContent {
  private detector: MediaDetector;
  private overlay: SubtitleOverlay;
  private sync: SyncEngine;
  private pipeline: AheadPipeline | null = null;
  private activeVideo: HTMLVideoElement | null = null;
  private currentMediaInfo: MediaInfo | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.detector = new MediaDetector();
    this.overlay = new SubtitleOverlay();
    this.sync = new SyncEngine();
  }

  init(): void {
    console.log('[AheadSub] Content script initialized');

    // Start detecting videos
    this.detector.start(
      (info) => this.onVideoFound(info),
      (video) => this.onVideoLost(video),
    );

    // Load initial settings for overlay
    chrome.storage.local.get(['settings'], (res) => {
      if (res.settings) {
        this.overlay.updateSettings(res.settings);
      }
    });

    // Listen for setting updates
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings?.newValue) {
        this.overlay.updateSettings(changes.settings.newValue);
      }
    });

    // Listen for messages from background/popup
    chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
      this.handleMessage(message, sendResponse);
      return true; // async response
    });
  }

  private onVideoFound(info: MediaInfo): void {
    if (!this.currentMediaInfo) {
      console.log(`[AheadSub] Video detected: "${info.title}" (${info.sourceType})`, info);
    }

    this.currentMediaInfo = info;

    if (info.videoElement && !this.activeVideo) {
      this.activeVideo = info.videoElement;
      this.sync.attach(info.videoElement);
    }

    // Send video info immediately to background so it's always up to date
    this.sendVideoInfo();

    // Start heartbeat if not already running
    if (!this.heartbeatInterval) {
      this.heartbeatInterval = setInterval(() => this.sendVideoInfo(), 2000);
    }
  }

  private sendVideoInfo(): void {
    if (!this.currentMediaInfo) return;
    
    // Refresh info before sending heartbeat
    if (this.activeVideo) {
      this.currentMediaInfo.currentTime = this.activeVideo.currentTime;
      this.currentMediaInfo.isPlaying = !this.activeVideo.paused && !this.activeVideo.ended;
    }

    try {
      chrome.runtime.sendMessage({
        type: MessageType.VIDEO_DETECTED,
        payload: {
          title: this.currentMediaInfo.title,
          duration: this.currentMediaInfo.duration,
          sourceUrl: this.currentMediaInfo.sourceUrl,
          sourceType: this.currentMediaInfo.sourceType,
          audioAccessMethod: this.currentMediaInfo.audioAccessMethod,
          manifestUrl: this.currentMediaInfo.manifestUrl,
          pageUrl: this.currentMediaInfo.pageUrl,
          dimensions: this.currentMediaInfo.dimensions,
          isPlaying: this.currentMediaInfo.isPlaying,
          currentTime: this.currentMediaInfo.currentTime,
        },
      });
    } catch {
      // Extension context may be invalidated
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    }
  }

  private onVideoLost(video: HTMLVideoElement): void {
    console.log('[AheadSub] Video lost');

    if (video === this.activeVideo) {
      this.overlay.detach();
      this.sync.detach();
      this.activeVideo = null;
      this.currentMediaInfo = null;
      
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
        this.heartbeatInterval = null;
      }
    }

    try {
      chrome.runtime.sendMessage({ type: MessageType.VIDEO_LOST });
    } catch {
      // Extension context may be invalidated
    }
  }

  private handleMessage(message: ExtensionMessage, sendResponse: (response: any) => void): void {
    switch (message.type) {
      case MessageType.DETECT_VIDEO:
        this.handleDetectVideo(sendResponse);
        break;

      case MessageType.START_PIPELINE:
        this.handleStartPipeline(message.payload as any);
        sendResponse({ success: true });
        break;

      case MessageType.INJECT_SUBTITLES:
        this.handleInjectSubtitles(message.payload as InjectSubtitlesPayload);
        sendResponse({ success: true });
        break;

      case MessageType.UPDATE_SUBTITLES:
        this.handleUpdateSubtitles(message.payload as UpdateSubtitlesPayload);
        sendResponse({ success: true });
        break;

      case MessageType.SHOW_OVERLAY:
        this.overlay.show();
        sendResponse({ success: true });
        break;

      case MessageType.HIDE_OVERLAY:
        this.overlay.hide();
        sendResponse({ success: true });
        break;

      case MessageType.SET_OFFSET:
        this.handleSetOffset(message.payload as number);
        sendResponse({ success: true });
        break;

      case MessageType.LOAD_VTT_FILE:
        this.handleLoadVTT(message.payload as { vttContent: string });
        sendResponse({ success: true });
        break;

      case MessageType.SAVE_SETTINGS:
        if (message.payload) {
          this.overlay.updateSettings(message.payload as Partial<AheadSubSettings>);
        }
        sendResponse({ success: true });
        break;

      case 'AHEADSUB_CHECK_NATIVE_CAPTIONS' as any:
        this.handleCheckNativeCaptions(message.payload, sendResponse);
        break;

      case 'AHEADSUB_START_STREAM_CAPTURE' as any:
        this.startLiveAudioCapture((message.payload as any)?.tabId);
        sendResponse({ success: true });
        break;

      case 'AHEADSUB_STOP_STREAM_CAPTURE' as any:
        this.stopLiveAudioCapture();
        sendResponse({ success: true });
        break;

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  }

  private handleDetectVideo(sendResponse: (response: any) => void): void {
    // Force a fresh scan
    const info = this.detector.getActiveVideo();

    if (info) {
      this.currentMediaInfo = info;
      if (info.videoElement && info.videoElement !== this.activeVideo) {
        this.activeVideo = info.videoElement;
        this.sync.attach(info.videoElement);
        if (this.overlay.isAttached()) {
          this.overlay.attach(info.videoElement);
        }
      }
    }

    sendResponse({
      found: !!info,
      info: info ? {
        title: info.title,
        duration: info.duration,
        sourceUrl: info.sourceUrl,
        sourceType: info.sourceType,
        audioAccessMethod: info.audioAccessMethod,
        manifestUrl: info.manifestUrl,
        pageUrl: info.pageUrl,
        dimensions: info.dimensions,
        isPlaying: info.isPlaying,
        currentTime: info.currentTime,
      } : undefined,
    });
  }

  private handleInjectSubtitles(payload: InjectSubtitlesPayload): void {
    if (!this.activeVideo) {
      console.warn('[AheadSub] No active video for subtitle injection');
      return;
    }

    this.overlay.attach(this.activeVideo, payload.settings);
    this.overlay.setCues(payload.cues);

    // Connect sync engine offset to overlay
    this.sync.on('timeupdate', (state) => {
      this.overlay.setOffset(state.offset + state.driftCorrection);
    });

    console.log(`[AheadSub] Injected ${payload.cues.length} subtitle cues`);
  }

  private handleUpdateSubtitles(payload: UpdateSubtitlesPayload): void {
    if (!this.activeVideo) {
      const freshInfo = this.detector.getActiveVideo();
      if (freshInfo?.videoElement) {
        this.activeVideo = freshInfo.videoElement;
        this.currentMediaInfo = freshInfo;
        this.sync.attach(freshInfo.videoElement);
      }
    }

    if (this.activeVideo) {
      if (!this.overlay.isAttached()) {
        this.overlay.attach(this.activeVideo);
      }
      this.overlay.addCues(payload.newCues);
      console.log(`[AheadSub] Added ${payload.newCues.length} new cues (through ${payload.processedThrough}s)`);
    }
  }

  private handleSetOffset(offsetMs: number): void {
    this.sync.setOffset(offsetMs);
    this.overlay.setOffset(offsetMs);
  }

  private async handleStartPipeline(payload: { settings: any }): Promise<void> {
    if (!this.activeVideo) {
      const freshInfo = this.detector.getActiveVideo();
      if (freshInfo?.videoElement) {
        this.activeVideo = freshInfo.videoElement;
        this.currentMediaInfo = freshInfo;
        this.sync.attach(freshInfo.videoElement);
      }
    }

    if (this.activeVideo) {
      this.overlay.attach(this.activeVideo, payload.settings);
      console.log('[AheadSub] Overlay attached to video, awaiting streaming cues from engine');
    }
  }

  // Wait up to `timeoutMs` for an intercepted HLS/DASH manifest
  private waitForManifest(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      // Check if we already have one
      const existing = this.detector.getRecentManifest();
      if (existing) {
        resolve(existing);
        return;
      }

      const handler = (event: MessageEvent) => {
        if (event.data?.type === 'AHEADSUB_MANIFEST_DETECTED' && event.data.url) {
          window.removeEventListener('message', handler);
          clearTimeout(timer);
          resolve(event.data.url as string);
        }
      };
      window.addEventListener('message', handler);

      const timer = setTimeout(() => {
        window.removeEventListener('message', handler);
        resolve(null);
      }, timeoutMs);
    });
  }

  private handleLoadVTT(payload: { vttContent: string }): void {
    if (!this.activeVideo) {
      console.warn('[AheadSub] Cannot load VTT: no active video');
      return;
    }

    let cues: SubtitleCue[];

    // Detect format
    if (payload.vttContent.trimStart().startsWith('WEBVTT')) {
      cues = parseVTT(payload.vttContent);
    } else {
      // Try SRT
      cues = parseSRT(payload.vttContent);
    }

    if (cues.length === 0) {
      console.warn('[AheadSub] No cues parsed from loaded file');
      return;
    }

    this.overlay.attach(this.activeVideo);
    this.overlay.setCues(cues);

    console.log(`[AheadSub] Loaded ${cues.length} cues from VTT/SRT file`);
  }

  // Native YouTube caption extraction with instant translation
  private async handleCheckNativeCaptions(payload: any, sendResponse: (r: any) => void): Promise<void> {
    const isYouTube = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be');
    if (!isYouTube) {
      sendResponse({ success: false });
      return;
    }

    try {
      const targetLang = payload?.targetLanguage || 'uz';
      const spokenLang = payload?.spokenLanguage || 'en';

      window.postMessage({
        type: 'AHEADSUB_REQUEST_YOUTUBE_CAPTIONS',
        lang: spokenLang,
        targetLang: targetLang,
      }, '*');

      const vtt = await new Promise<string | null>((resolve) => {
        const handler = (e: MessageEvent) => {
          if (e.data?.type === 'AHEADSUB_YOUTUBE_CAPTIONS_RESULT') {
            window.removeEventListener('message', handler);
            resolve(e.data.success ? e.data.vtt : null);
          }
        };
        window.addEventListener('message', handler);
        setTimeout(() => {
          window.removeEventListener('message', handler);
          resolve(null);
        }, 3500);
      });

      if (!vtt) {
        sendResponse({ success: false });
        return;
      }

      const cues = parseVTT(vtt);
      if (!cues || cues.length === 0) {
        sendResponse({ success: false });
        return;
      }

      // If targetLanguage is different from source, batch translate cue texts
      if (targetLang && targetLang !== 'en') {
        const batchSize = 10;
        for (let i = 0; i < cues.length; i += batchSize) {
          const batch = cues.slice(i, i + batchSize);
          await Promise.all(
            batch.map(async (cue) => {
              const original = cue.text.trim();
              cue.originalText = original;
              try {
                const res: any = await chrome.runtime.sendMessage({
                  type: MessageType.TRANSLATE_TEXT,
                  payload: {
                    text: original,
                    targetLang,
                    srcLang: 'en'
                  }
                });
                if (res?.translatedText && res.translatedText.trim().toLowerCase() !== original.toLowerCase()) {
                  cue.text = res.translatedText.trim();
                }
              } catch {}
            })
          );
        }
      }

      // Ensure active video is attached
      if (!this.activeVideo) {
        const fresh = this.detector.getActiveVideo();
        if (fresh?.videoElement) {
          this.activeVideo = fresh.videoElement;
          this.sync.attach(fresh.videoElement);
        }
      }

      if (this.activeVideo) {
        this.overlay.attach(this.activeVideo);
        this.overlay.setCues(cues);
      }

      sendResponse({ success: true, cues });
    } catch (err) {
      console.warn('[AheadSub] Error checking native captions:', err);
      sendResponse({ success: false });
    }
  }

  // Live audio capture fallback via captureStream for any blob/MSE video
  private liveAudioContext: AudioContext | null = null;
  private liveAudioSource: MediaStreamAudioSourceNode | null = null;
  private liveAudioProcessor: ScriptProcessorNode | null = null;

  private startLiveAudioCapture(tabId?: number): void {
    if (!this.activeVideo) {
      const fresh = this.detector.getActiveVideo();
      if (fresh?.videoElement) this.activeVideo = fresh.videoElement;
    }
    if (!this.activeVideo) return;

    try {
      const stream = (this.activeVideo as any).captureStream ? (this.activeVideo as any).captureStream() : (this.activeVideo as any).mozCaptureStream?.();
      if (!stream) return;
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) return;

      this.liveAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (this.liveAudioContext.state === 'suspended') {
        this.liveAudioContext.resume().catch(() => {});
      }
      this.liveAudioSource = this.liveAudioContext.createMediaStreamSource(new MediaStream([audioTrack]));
      this.liveAudioProcessor = this.liveAudioContext.createScriptProcessor(4096, 1, 1);

      let buffer: number[] = [];
      let chunkIndex = 0;
      const INITIAL_CHUNK_SAMPLES = 16000 * 2.5; // 2.5-second initial chunk for fast subtitle feedback
      const CHUNK_SAMPLES = 16000 * 6; // 6-second subsequent chunks

      this.liveAudioProcessor.onaudioprocess = (e) => {
        // Mute processor output to prevent audio feedback / echo to speakers
        e.outputBuffer.getChannelData(0).fill(0);

        const inputData = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < inputData.length; i++) {
          buffer.push(inputData[i]!);
        }

        const targetLimit = chunkIndex === 0 ? INITIAL_CHUNK_SAMPLES : CHUNK_SAMPLES;
        if (buffer.length >= targetLimit) {
          const pcm = new Float32Array(buffer);
          buffer = [];
          const curTime = this.activeVideo?.currentTime || 0;
          const chunkDuration = pcm.length / 16000;
          chrome.runtime.sendMessage({
            type: 'OFFSCREEN_PROCESS_LIVE_CHUNK',
            payload: {
              tabId: tabId ?? 0,
              pcmData: Array.from(pcm),
              chunkIndex: chunkIndex++,
              startTime: Math.max(0, curTime - chunkDuration),
              endTime: curTime,
            }
          }).catch(() => {});
        }
      };

      this.liveAudioSource.connect(this.liveAudioProcessor);
      this.liveAudioProcessor.connect(this.liveAudioContext.destination);
      console.log('[AheadSub] Live audio capture started via captureStream');
    } catch (e) {
      console.warn('[AheadSub] Failed to start live audio capture:', e);
    }
  }

  private stopLiveAudioCapture(): void {
    this.liveAudioProcessor?.disconnect();
    this.liveAudioSource?.disconnect();
    this.liveAudioContext?.close().catch(() => {});
    this.liveAudioProcessor = null;
    this.liveAudioSource = null;
    this.liveAudioContext = null;
  }
}

// --- Initialize with Singleton Guard ---
if ((window as any).__AHEADSUB_INITIALIZED__) {
  console.log('[AheadSub] Content script already initialized in this frame');
} else {
  (window as any).__AHEADSUB_INITIALIZED__ = true;
  const aheadSub = new AheadSubContent();
  aheadSub.init();
}
