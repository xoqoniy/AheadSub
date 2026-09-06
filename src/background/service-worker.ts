// ============================================================
// AheadSub — Background Service Worker
// Orchestrates communication between popup, content scripts,
// offscreen document, and manages the transcription pipeline.
// ============================================================

import { MessageType } from '../core/messages';
import type { ExtensionMessage, StartGenerationPayload, TranscriptionResultPayload } from '../core/messages';
import type {
  PipelineProgress,
  SubtitleCue,
  TranscriptionResult,
  AheadSubSettings,
  MediaInfo,
} from '../core/types';
import { PipelineState, ProcessingMode, AudioAccessMethod } from '../core/types';
import { DEFAULT_SETTINGS, OFFSCREEN_DOCUMENT_PATH } from '../core/constants';
import { RUSSIAN_COLLOCATIONS, INSTANT_UZBEK_WORDS } from '../core/collocations';

// --- State ---

interface TabSession {
  tabId: number;
  activeFrameId: number;
  videoInfo: Partial<MediaInfo> | null;
  recentManifestUrl: string | null;
  audioStreamUrl?: string | null;
  captionUrl?: string | null;
  cues: SubtitleCue[];
  progress: PipelineProgress;
  result: TranscriptionResult | null;
}

const tabSessions = new Map<number, TabSession>();

function getTabSession(tabId: number): TabSession {
  let session = tabSessions.get(tabId);
  if (!session) {
    session = {
      tabId,
      activeFrameId: 0,
      videoInfo: null,
      recentManifestUrl: null,
      audioStreamUrl: null,
      captionUrl: null,
      cues: [],
      progress: {
        state: PipelineState.IDLE,
        mode: state.settings.processingMode,
        processedDuration: 0,
        totalDuration: 0,
        currentChunkStart: 0,
        currentChunkEnd: 0,
        cuesGenerated: 0,
        safePlaybackThrough: 0,
      },
      result: null,
    };
    tabSessions.set(tabId, session);
  }
  return session;
}

interface BackgroundState {
  settings: AheadSubSettings;
  activeTabId: number | null;
  activeFrameId: number | null;
  videoInfo: Partial<MediaInfo> | null;
  recentManifestUrl: string | null;
  progress: PipelineProgress;
  cues: SubtitleCue[];
  isOffscreenCreated: boolean;
  result: TranscriptionResult | null;
}

const state: BackgroundState = {
  settings: { ...DEFAULT_SETTINGS },
  activeTabId: null,
  activeFrameId: null,
  videoInfo: null,
  recentManifestUrl: null,
  progress: {
    state: PipelineState.IDLE,
    mode: ProcessingMode.FULL_PRE_GENERATION,
    processedDuration: 0,
    totalDuration: 0,
    currentChunkStart: 0,
    currentChunkEnd: 0,
    cuesGenerated: 0,
    safePlaybackThrough: 0,
  },
  cues: [],
  isOffscreenCreated: false,
  result: null,
};

function saveRecentManifest(url: string, tabId?: number): void {
  if (!url) return;
  state.recentManifestUrl = url;
  if (tabId && tabId > 0) {
    const session = getTabSession(tabId);
    session.recentManifestUrl = url;
    if (session.videoInfo) {
      session.videoInfo.manifestUrl = url;
      session.videoInfo.audioAccessMethod = url.toLowerCase().includes('.mpd')
        ? AudioAccessMethod.DASH_MANIFEST
        : AudioAccessMethod.HLS_MANIFEST;
    }
  }
  const info = state.videoInfo;
  if (info) {
    info.manifestUrl = url;
    info.audioAccessMethod = url.toLowerCase().includes('.mpd')
      ? AudioAccessMethod.DASH_MANIFEST
      : AudioAccessMethod.HLS_MANIFEST;
  }
  try {
    const data: Record<string, string> = { recentManifestUrl: url };
    if (tabId && tabId > 0) {
      data[`tab_manifest_${tabId}`] = url;
    }
    chrome.storage.session?.set(data).catch(() => {});
  } catch {}
}

function saveAudioStreamUrl(url: string, tabId?: number): void {
  if (!url) return;
  if (tabId && tabId > 0) {
    const session = getTabSession(tabId);
    session.audioStreamUrl = url;
    if (session.videoInfo) {
      session.videoInfo.sourceUrl = url;
      session.videoInfo.audioAccessMethod = AudioAccessMethod.DIRECT_URL;
    }
  }
  if (state.videoInfo) {
    state.videoInfo.sourceUrl = url;
    state.videoInfo.audioAccessMethod = AudioAccessMethod.DIRECT_URL;
  }
  try {
    if (tabId && tabId > 0) {
      chrome.storage.session?.set({ [`tab_audio_${tabId}`]: url }).catch(() => {});
    }
  } catch {}
}

// Restore recent manifest from session storage when service worker wakes up
try {
  chrome.storage.session?.get(['recentManifestUrl']).then((res) => {
    if (res?.recentManifestUrl && !state.recentManifestUrl) {
      state.recentManifestUrl = res.recentManifestUrl;
      console.log('[AheadSub BG] Restored manifest from session:', state.recentManifestUrl);
    }
  }).catch(() => {});
} catch {}

// Browser-level network interceptor for HLS/DASH streams across all frames and domains
try {
  if (chrome.webRequest?.onBeforeRequest) {
    chrome.webRequest.onBeforeRequest.addListener(
      (details) => {
        const url = details.url;
        const lower = url.toLowerCase();
        if (
          lower.includes('.m3u8') ||
          lower.includes('.mpd') ||
          lower.includes('/hls/') ||
          lower.includes(':hls:manifest') ||
          lower.includes('/playlist.') ||
          lower.includes('manifest.mpd')
        ) {
          console.log('[AheadSub BG] webRequest intercepted manifest:', url);
          saveRecentManifest(url, details.tabId);
        } else if (
          (lower.includes('googlevideo.com/videoplayback') || lower.includes('/videoplayback')) &&
          (lower.includes('mime=audio') || lower.includes('itag=140') || lower.includes('itag=251') || lower.includes('itag=250') || lower.includes('itag=249'))
        ) {
          console.log('[AheadSub BG] webRequest intercepted YouTube/DASH audio:', url);
          saveAudioStreamUrl(url, details.tabId);
        } else if (lower.includes('/api/timedtext')) {
          console.log('[AheadSub BG] webRequest intercepted YouTube caption request:', url);
          if (details.tabId && details.tabId > 0) {
            getTabSession(details.tabId).captionUrl = url;
          }
        }
      },
      { urls: ['<all_urls>'] }
    );
  }
} catch (e) {
  console.warn('[AheadSub BG] webRequest setup error:', e);
}

// Reset tab state when user navigates away to a different domain/site
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    const session = tabSessions.get(tabId);
    let shouldReset = false;
    try {
      if (session?.videoInfo?.pageUrl) {
        const oldUrl = new URL(session.videoInfo.pageUrl);
        const newUrl = new URL(changeInfo.url);
        // Only reset if domain/hostname changed
        if (oldUrl.hostname !== newUrl.hostname) {
          shouldReset = true;
        }
      }
    } catch {
      // If URL parsing fails, preserve state
    }

    if (shouldReset) {
      console.log(`[AheadSub BG] Tab ${tabId} navigated to new domain ${changeInfo.url}. Resetting tab state.`);
      tabSessions.delete(tabId);
      if (state.activeTabId === tabId) {
        state.videoInfo = null;
        state.activeFrameId = null;
        state.recentManifestUrl = null;
        state.cues = [];
        state.progress = {
          state: PipelineState.IDLE,
          mode: state.settings.processingMode,
          processedDuration: 0,
          totalDuration: 0,
          currentChunkStart: 0,
          currentChunkEnd: 0,
          cuesGenerated: 0,
          safePlaybackThrough: 0,
        };
        chrome.runtime.sendMessage({ type: MessageType.STOP_OFFSCREEN_PIPELINE }).catch(() => {});
      }
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabSessions.delete(tabId);
});

// --- Message Router ---

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender, sendResponse) => {
    handleMessage(message, sender, sendResponse);
    return true;
  }
);

async function handleMessage(
  message: ExtensionMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    switch (message.type) {
      // --- From Popup ---

      case MessageType.GET_VIDEO_INFO:
        await handleGetVideoInfo(sendResponse, (message.payload as any)?.tabId);
        break;

      case MessageType.START_GENERATION:
        await handleStartGeneration(message.payload as StartGenerationPayload, sendResponse);
        break;

      case MessageType.STOP_GENERATION:
        handleStopGeneration(sendResponse, (message.payload as any)?.tabId);
        break;

      case MessageType.GET_PROGRESS: {
        const reqTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        const session = reqTabId ? tabSessions.get(reqTabId) : null;
        sendResponse({ progress: session?.progress ?? state.progress });
        break;
      }

      case MessageType.GET_SETTINGS:
        sendResponse({ settings: state.settings });
        break;

      case MessageType.SAVE_SETTINGS:
        state.settings = { ...(message.payload as AheadSubSettings) };
        await chrome.storage.local.set({ settings: state.settings });
        await forwardToActiveTab(message).catch(() => {});
        sendResponse({ success: true });
        break;

      case MessageType.CLEAR_CACHE as any:
        try {
          // Clear AheadSub's subtitle cache (IndexedDB)
          indexedDB.deleteDatabase('aheadsub-cache');
          
          // Clear Transformers.js Cache API
          caches.delete('transformers-cache');
          
          // Also forward to offscreen just in case it holds memory or its own db handles
          chrome.runtime.sendMessage({ type: 'OFFSCREEN_CLEAR_CACHE' }).catch(() => {});
          
          sendResponse({ success: true });
        } catch (e) {
          sendResponse({ error: String(e) });
        }
        break;

      case MessageType.SHOW_OVERLAY:
      case MessageType.HIDE_OVERLAY:
      case MessageType.SET_OFFSET:
        await forwardToActiveTab(message);
        sendResponse({ success: true });
        break;

      case MessageType.LOAD_VTT_FILE:
        await forwardToActiveTab(message);
        sendResponse({ success: true });
        break;

      case MessageType.EXPORT_VTT:
      case MessageType.EXPORT_SRT:
        handleExport(message.type === MessageType.EXPORT_VTT ? 'vtt' : 'srt', sendResponse, (message.payload as any)?.tabId);
        break;

      case MessageType.GET_HARDWARE_INFO:
        await handleGetHardwareInfo(sendResponse);
        break;

      case MessageType.RESET_PIPELINE as any: {
        const reqTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        console.log(`[AheadSub BG] Resetting pipeline state for tab ${reqTabId}`);
        if (reqTabId && tabSessions.has(reqTabId)) {
          const session = tabSessions.get(reqTabId)!;
          session.videoInfo = null;
          session.activeFrameId = 0;
          session.recentManifestUrl = null;
          session.cues = [];
          session.progress = {
            state: PipelineState.IDLE,
            mode: state.settings.processingMode,
            processedDuration: 0,
            totalDuration: 0,
            currentChunkStart: 0,
            currentChunkEnd: 0,
            cuesGenerated: 0,
            safePlaybackThrough: 0,
          };
        }
        if (!reqTabId || state.activeTabId === reqTabId) {
          state.videoInfo = null;
          state.activeFrameId = null;
          state.recentManifestUrl = null;
          state.cues = [];
          state.progress = {
            state: PipelineState.IDLE,
            mode: state.settings.processingMode,
            processedDuration: 0,
            totalDuration: 0,
            currentChunkStart: 0,
            currentChunkEnd: 0,
            cuesGenerated: 0,
            safePlaybackThrough: 0,
          };
        }
        chrome.runtime.sendMessage({
          type: MessageType.STOP_OFFSCREEN_PIPELINE,
          payload: { tabId: reqTabId },
        }).catch(() => {});
        sendResponse({ success: true });
        break;
      }

      case MessageType.TRANSLATE_TEXT as any:
        await handleTranslateText(message.payload as any, sendResponse);
        break;

      // --- From Content Script ---

      case MessageType.VIDEO_DETECTED: {
        const detectedInfo = message.payload as Partial<MediaInfo>;
        const tabId = sender.tab?.id;
        const frameId = sender.frameId ?? 0;
        if (tabId) {
          const session = getTabSession(tabId);
          session.activeFrameId = frameId;
          if (detectedInfo) {
            if (detectedInfo.manifestUrl) {
              saveRecentManifest(detectedInfo.manifestUrl, tabId);
            } else if (session.recentManifestUrl) {
              detectedInfo.manifestUrl = session.recentManifestUrl;
              detectedInfo.audioAccessMethod = session.recentManifestUrl.toLowerCase().includes('.mpd')
                ? AudioAccessMethod.DASH_MANIFEST
                : AudioAccessMethod.HLS_MANIFEST;
            }
          }
          session.videoInfo = detectedInfo;
        }

        if (detectedInfo) {
          if (detectedInfo.manifestUrl) {
            saveRecentManifest(detectedInfo.manifestUrl, tabId);
          } else if (state.recentManifestUrl) {
            detectedInfo.manifestUrl = state.recentManifestUrl;
            detectedInfo.audioAccessMethod = state.recentManifestUrl.toLowerCase().includes('.mpd')
              ? AudioAccessMethod.DASH_MANIFEST
              : AudioAccessMethod.HLS_MANIFEST;
          }
        }
        state.videoInfo = detectedInfo;
        state.activeTabId = tabId ?? null;
        state.activeFrameId = frameId;
        console.log(`[AheadSub BG] Video detected in tab ${state.activeTabId}, frame ${state.activeFrameId}, manifest: ${state.videoInfo?.manifestUrl}`);
        sendResponse({ success: true });
        break;
      }

      case MessageType.MANIFEST_DETECTED: {
        const manifestUrl = (message.payload as any)?.url;
        if (manifestUrl) {
          console.log('[AheadSub BG] Manifest reported from content script:', manifestUrl);
          saveRecentManifest(manifestUrl, sender.tab?.id);
        }
        sendResponse({ success: true });
        break;
      }

      case MessageType.VIDEO_LOST: {
        const tabId = sender.tab?.id;
        if (tabId && tabSessions.has(tabId)) {
          const session = tabSessions.get(tabId)!;
          if (sender.frameId === session.activeFrameId || session.activeFrameId === 0) {
            session.videoInfo = null;
          }
        }
        if (sender.frameId === state.activeFrameId || state.activeFrameId === null) {
          console.log(`[AheadSub BG] Video lost from frame ${sender.frameId}`);
          state.videoInfo = null;
          state.activeFrameId = null;
        }
        sendResponse({ success: true });
        break;
      }

      // --- From Offscreen Document ---

      case MessageType.OFFSCREEN_TRANSCRIPTION_RESULT:
        handleTranscriptionResult(message.payload as any);
        sendResponse({ success: true });
        break;

      case MessageType.OFFSCREEN_MODEL_PROGRESS: {
        const targetTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        if (targetTabId && tabSessions.has(targetTabId)) {
          const s = tabSessions.get(targetTabId)!;
          s.progress.state = PipelineState.LOADING_MODEL;
          s.progress.modelLoadingProgress = (message.payload as any)?.progress || 0;
        }
        state.progress.state = PipelineState.LOADING_MODEL;
        state.progress.modelLoadingProgress = (message.payload as any)?.progress || 0;
        sendResponse({ success: true });
        break;
      }

      case MessageType.OFFSCREEN_MODEL_READY: {
        const targetTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        const session = targetTabId ? getTabSession(targetTabId) : null;
        if (session) session.progress.state = PipelineState.TRANSCRIBING;
        state.progress.state = PipelineState.TRANSCRIBING;
        
        // Start audio extraction and transcription pipeline in offscreen document
        const videoInfoToSend = session?.videoInfo || state.videoInfo;
        chrome.runtime.sendMessage({
          type: MessageType.START_OFFSCREEN_PIPELINE,
          payload: {
            videoInfo: videoInfoToSend,
            settings: state.settings,
            tabId: targetTabId,
          }
        }).catch((e) => {
          console.error('[AheadSub BG] Failed to send START_OFFSCREEN_PIPELINE:', e);
        });

        // Also ensure content script has active overlay ready across frames
        if (targetTabId !== null) {
          const frameId = session?.activeFrameId ?? state.activeFrameId ?? 0;
          chrome.tabs.sendMessage(targetTabId, {
             type: MessageType.START_PIPELINE,
             payload: { settings: state.settings }
          }, { frameId }).catch(() => {});
          if (frameId !== 0) {
            chrome.tabs.sendMessage(targetTabId, {
               type: MessageType.START_PIPELINE,
               payload: { settings: state.settings }
            }).catch(() => {});
          }
        }
        sendResponse({ success: true });
        break;
      }

      case MessageType.OFFSCREEN_AUDIO_DECODED: {
        const targetTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        if (targetTabId !== null) {
          const frameId = tabSessions.get(targetTabId)?.activeFrameId ?? state.activeFrameId ?? 0;
          chrome.tabs.sendMessage(targetTabId, message, { frameId }).catch(() => {});
        }
        sendResponse({ success: true });
        break;
      }

      case MessageType.OFFSCREEN_ERROR: {
        const targetTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        const errText = (message.payload as any)?.error || 'Unknown error';
        if (targetTabId && tabSessions.has(targetTabId)) {
          const s = tabSessions.get(targetTabId)!;
          s.progress.state = PipelineState.ERROR;
          s.progress.error = errText;
        }
        state.progress.state = PipelineState.ERROR;
        state.progress.error = errText;
        if (targetTabId !== null) {
          const frameId = tabSessions.get(targetTabId)?.activeFrameId ?? state.activeFrameId ?? 0;
          chrome.tabs.sendMessage(targetTabId, message, { frameId }).catch(() => {});
        }
        sendResponse({ success: true });
        break;
      }

      case MessageType.OFFSCREEN_HARDWARE_INFO:
        sendResponse(message.payload);
        break;

      case MessageType.OFFSCREEN_TRANSCRIBE_CHUNK:
      case MessageType.OFFSCREEN_DECODE_AUDIO:
        // Forward to offscreen document
        chrome.runtime.sendMessage(message).catch(() => {});
        sendResponse({ success: true });
        break;

      case MessageType.PIPELINE_PROGRESS: {
        const prog = message.payload as any;
        const targetTabId = prog?.tabId ?? state.activeTabId;
        if (targetTabId && tabSessions.has(targetTabId)) {
          tabSessions.get(targetTabId)!.progress = prog;
        }
        if (!targetTabId || targetTabId === state.activeTabId) {
          state.progress = prog;
        }
        sendResponse({ success: true });
        break;
      }

      case MessageType.GENERATION_COMPLETE: {
        const p = message.payload as any;
        const cues = Array.isArray(p) ? p : (p?.cues || []);
        const targetTabId = p?.tabId ?? state.activeTabId;
        if (targetTabId && tabSessions.has(targetTabId)) {
          const s = tabSessions.get(targetTabId)!;
          s.cues = cues;
          s.progress.state = PipelineState.COMPLETE;
        }
        if (!targetTabId || targetTabId === state.activeTabId) {
          state.cues = cues;
          state.progress.state = PipelineState.COMPLETE;
        }
        sendResponse({ success: true });
        break;
      }

      case MessageType.GENERATION_ERROR: {
        const targetTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        const err = String((message.payload as any)?.error || message.payload);
        if (targetTabId && tabSessions.has(targetTabId)) {
          const s = tabSessions.get(targetTabId)!;
          s.progress.state = PipelineState.ERROR;
          s.progress.error = err;
        }
        state.progress.state = PipelineState.ERROR;
        state.progress.error = err;
        sendResponse({ success: true });
        break;
      }

      case 'FORWARD_TO_TAB' as any: {
        const p = message.payload as any;
        const targetTabId = p?.tabId ?? state.activeTabId;
        const innerMsg = p?.message;
        if (targetTabId && innerMsg) {
          const session = getTabSession(targetTabId);
          const frameId = session.activeFrameId ?? state.activeFrameId ?? 0;
          chrome.tabs.sendMessage(targetTabId, innerMsg, { frameId }).catch(() => {});
          if (frameId !== 0) {
            chrome.tabs.sendMessage(targetTabId, innerMsg).catch(() => {});
          }
        }
        sendResponse({ success: true });
        break;
      }

      case 'AHEADSUB_START_STREAM_CAPTURE' as any:
      case 'AHEADSUB_STOP_STREAM_CAPTURE' as any: {
        const targetTabId = (message.payload as any)?.tabId ?? state.activeTabId;
        if (targetTabId) {
          const session = getTabSession(targetTabId);
          const frameId = session.activeFrameId ?? state.activeFrameId ?? 0;
          chrome.tabs.sendMessage(targetTabId, message, { frameId }).catch(() => {});
          if (frameId !== 0) {
            chrome.tabs.sendMessage(targetTabId, message).catch(() => {});
          }
        }
        sendResponse({ success: true });
        break;
      }

      case 'OFFSCREEN_PROCESS_LIVE_CHUNK' as any: {
        if (sender.tab) {
          chrome.runtime.sendMessage(message).catch(() => {});
        }
        sendResponse({ success: true });
        break;
      }

      default:
        sendResponse({ error: `Unknown message: ${message.type}` });
    }
  } catch (error) {
    console.error('[AheadSub BG] Error handling message:', error);
    sendResponse({ error: String(error) });
  }
}

function applyManifestToInfo(info: Partial<MediaInfo>, tabId?: number): Partial<MediaInfo> {
  const session = tabId ? getTabSession(tabId) : null;
  const manifest = info.manifestUrl || session?.recentManifestUrl || state.recentManifestUrl;
  if (manifest) {
    info.manifestUrl = manifest;
    info.audioAccessMethod = manifest.toLowerCase().includes('.mpd')
      ? AudioAccessMethod.DASH_MANIFEST
      : AudioAccessMethod.HLS_MANIFEST;
    saveRecentManifest(manifest, tabId);
  } else if (session?.audioStreamUrl) {
    info.sourceUrl = session.audioStreamUrl;
    info.audioAccessMethod = AudioAccessMethod.DIRECT_URL;
  } else if (info.pageUrl && (info.pageUrl.includes('youtube.com') || info.pageUrl.includes('youtu.be'))) {
    info.audioAccessMethod = AudioAccessMethod.DIRECT_URL;
  }
  return info;
}

// --- Handlers ---

// Auto-inject content scripts into all frames of tab if they were not already loaded
async function injectContentScriptIntoTab(tabId: number): Promise<void> {
  try {
    // First ping the tab to check if content script is already alive and running
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' }).catch(() => null);
    if (ping?.pong) {
      return; // Already active, do not reinject
    }

    const manifest = chrome.runtime.getManifest();
    const scripts = manifest.content_scripts || [];
    for (const cs of scripts) {
      if (cs.js && cs.js.length > 0) {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: cs.all_frames ?? true },
          files: cs.js,
          world: (cs as any).world === 'MAIN' ? 'MAIN' : 'ISOLATED',
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.warn('[AheadSub BG] injectContentScript error:', e);
  }
}

/// In-page direct DOM & Shadow-DOM video scanner (works on ANY website, even custom/embedded players)
function inPageScanForVideos(): any {
  function findVideos(root: Document | ShadowRoot | Element): HTMLVideoElement[] {
    const list: HTMLVideoElement[] = [];
    try {
      const vids = root.querySelectorAll('video');
      vids.forEach((v) => list.push(v as HTMLVideoElement));
    } catch {}
    try {
      const all = root.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const shadow = all[i]?.shadowRoot;
        if (shadow) list.push(...findVideos(shadow));
      }
    } catch {}
    return list;
  }

  const vids = findVideos(document);
  if (!vids || vids.length === 0) return null;

  let best: HTMLVideoElement | null = null;
  let bestScore = -1;

  for (const v of vids) {
    let score = 100;
    const w = v.videoWidth || v.offsetWidth || v.clientWidth || 0;
    const h = v.videoHeight || v.offsetHeight || v.clientHeight || 0;
    const area = w * h;

    // Heavily penalize invisible or tiny video elements (ad pixels / audio tracking tags)
    if (w < 100 || h < 100) {
      score -= 500000;
    } else {
      score += Math.min(100000, area / 10);
      if (w >= 300 && h >= 150) score += 200000;
    }

    if (v.duration && isFinite(v.duration) && v.duration > 0) score += 30000;
    if (!v.paused && !v.ended) score += 50000;
    if (v.currentTime > 0) score += 10000;
    const src = v.currentSrc || v.src || v.querySelector('source')?.src || v.querySelector('source')?.getAttribute('src') || v.getAttribute('src') || v.getAttribute('data-src') || '';
    if (src) score += 5000;
    if (v.readyState > 0) score += 2000;

    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  }

  if (!best) return null;

  const src = best.currentSrc || best.src || best.querySelector('source')?.src || best.querySelector('source')?.getAttribute('src') || best.getAttribute('src') || best.getAttribute('data-src') || '';
  const isMpd = src.includes('.mpd');
  const isHls = src.includes('.m3u8');
  const isYouTube = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be');

  let audioAccessMethod = 'capture_stream';
  if (isMpd) audioAccessMethod = 'dash_manifest';
  else if (isHls) audioAccessMethod = 'hls_manifest';
  else if (isYouTube || src.startsWith('http')) audioAccessMethod = 'direct_url';
  else if (src.startsWith('blob:')) audioAccessMethod = 'capture_stream';

  const w = best.videoWidth || best.offsetWidth || best.clientWidth || 1280;
  const h = best.videoHeight || best.offsetHeight || best.clientHeight || 720;

  let title = document.title || 'Video';
  if (isYouTube) {
    const ytTitle = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
                    document.querySelector('#title h1 yt-formatted-string')?.textContent?.trim() ||
                    document.querySelector('h1.title yt-formatted-string')?.textContent?.trim();
    if (ytTitle) title = ytTitle;
    title = title.replace(/\s*-\s*YouTube$/i, '');
  }

  return {
    title,
    duration: (best.duration && isFinite(best.duration)) ? best.duration : 0,
    currentTime: best.currentTime || 0,
    sourceUrl: src,
    sourceType: src.startsWith('blob:') ? 'blob' : (src.startsWith('http') ? 'direct' : 'unknown'),
    audioAccessMethod,
    pageUrl: window.location.href,
    dimensions: { width: w, height: h },
    isPlaying: !best.paused && !best.ended,
    hasVideo: true,
  };
}

async function handleGetVideoInfo(sendResponse: (r: any) => void, requestedTabId?: number): Promise<void> {
  let tabId = requestedTabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tabs[0]?.id;
  }

  if (!tabId) {
    sendResponse({ found: false });
    return;
  }

  const session = getTabSession(tabId);
  state.activeTabId = tabId;

  // Restore manifest from session storage if missing
  if (!session.recentManifestUrl) {
    try {
      const stored = await chrome.storage.session?.get([`tab_manifest_${tabId}`, 'recentManifestUrl']);
      if (stored?.[`tab_manifest_${tabId}`]) {
        session.recentManifestUrl = stored[`tab_manifest_${tabId}`];
      } else if (stored?.recentManifestUrl) {
        session.recentManifestUrl = stored.recentManifestUrl;
      }
    } catch {}
  }

  // 1. If video was already detected and active in session, return it immediately
  if (session.videoInfo && (session.videoInfo.duration! > 0 || session.videoInfo.sourceUrl || session.videoInfo.isPlaying || (session.videoInfo as any).hasVideo)) {
    const info = applyManifestToInfo(session.videoInfo, tabId);
    session.videoInfo = info;
    state.videoInfo = info;
    sendResponse({ found: true, info });
    return;
  }

  // 2. High-speed direct in-page script scan across ALL frames and Shadow DOM roots
  // Directly executes via C++ browser engine in <15ms without waiting for content script handshake
  try {
    const scriptResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: inPageScanForVideos,
    });

    if (scriptResults && scriptResults.length > 0) {
      let bestResult: any = null;
      let bestFrameId = 0;
      let bestScore = -1;

      for (const item of scriptResults) {
        if (item.result && item.result.hasVideo) {
          let score = 100;
          if (item.result.duration > 0) score += 10000;
          if (item.result.isPlaying) score += 50000;
          if (item.result.sourceUrl) score += 5000;
          if (score > bestScore) {
            bestScore = score;
            bestResult = item.result;
            bestFrameId = item.frameId ?? 0;
          }
        }
      }

      if (bestResult) {
        session.activeFrameId = bestFrameId;
        state.activeFrameId = bestFrameId;
        const info = applyManifestToInfo(bestResult, tabId);
        session.videoInfo = info;
        state.videoInfo = info;

        // Ensure content script is injected for overlay
        injectContentScriptIntoTab(tabId).catch(() => {});

        console.log(`[AheadSub BG] Universal scanner detected video in tab ${tabId}, frame ${bestFrameId}: "${info.title}"`);
        sendResponse({ found: true, info });
        return;
      }
    }
  } catch (err) {
    console.warn('[AheadSub BG] inPageScanForVideos error:', err);
  }

  // 3. Fallback: Query top frame and all frames via messaging
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: MessageType.DETECT_VIDEO,
    });
    if (response?.found && response.info) {
      const info = applyManifestToInfo(response.info, tabId);
      session.videoInfo = info;
      state.videoInfo = info;
      sendResponse({ found: true, info });
      return;
    }
  } catch {}

  // 4. Query all frames via webNavigation
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (frames && frames.length > 0) {
      for (const frame of frames) {
        try {
          const response = await chrome.tabs.sendMessage(tabId, {
            type: MessageType.DETECT_VIDEO,
          }, { frameId: frame.frameId });
          if (response?.found && response.info) {
            session.activeFrameId = frame.frameId;
            state.activeFrameId = frame.frameId;
            const info = applyManifestToInfo(response.info, tabId);
            session.videoInfo = info;
            state.videoInfo = info;
            sendResponse({ found: true, info });
            return;
          }
        } catch {}
      }
    }
  } catch {}

  // 5. If session has ANY video info stored
  if (session.videoInfo) {
    const info = applyManifestToInfo(session.videoInfo, tabId);
    sendResponse({ found: true, info });
    return;
  }

  // Inject content scripts so upcoming video events will trigger VIDEO_DETECTED
  injectContentScriptIntoTab(tabId).catch(() => {});

  sendResponse({ found: false });
}

// In-memory translation cache (preserves instant response on hover)
interface TranslationCacheItem {
  translatedText: string;
  dictEntries?: Array<{ pos: string; terms: string[]; base?: string }>;
  sourceLang?: string;
}

const translationCache = new Map<string, TranslationCacheItem>();

// Preload recent translations from local storage on wake (purging any false-name or self-translation corruptions)
try {
  chrome.storage.local.get(['aheadsub_trans_cache']).then((data) => {
    if (data?.aheadsub_trans_cache && typeof data.aheadsub_trans_cache === 'object') {
      for (const [k, v] of Object.entries(data.aheadsub_trans_cache)) {
        const item = v as TranslationCacheItem;
        // Purge any corrupted false-name entries from previous versions
        if (item?.dictEntries?.[0]?.pos === 'NAME') {
          continue;
        }
        // Purge any corrupted entries where translation is identical to original text or contains HTML/GoogleSorry
        const keyText = k.includes(':') ? k.slice(k.indexOf(':') + 1) : k;
        if (
          !item?.translatedText ||
          item.translatedText.trim().toLowerCase() === keyText.trim().toLowerCase() ||
          item.translatedText.includes('<') ||
          item.translatedText.includes('GoogleSorry')
        ) {
          continue;
        }
        if (!translationCache.has(k)) {
          translationCache.set(k, item);
        }
      }
    }
  }).catch(() => {});
} catch {}

function persistTranslation(key: string, item: TranslationCacheItem): void {
  const keyText = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  if (
    !item.translatedText ||
    item.translatedText.trim().toLowerCase() === keyText.trim().toLowerCase() ||
    item.translatedText.includes('<') ||
    item.translatedText.includes('GoogleSorry')
  ) {
    return; // Never persist self-translations or HTML errors
  }
  translationCache.set(key, item);
  // Persist asynchronously in small batches
  if (translationCache.size % 10 === 0) {
    try {
      const obj: Record<string, TranslationCacheItem> = {};
      let count = 0;
      for (const [k, v] of translationCache.entries()) {
        obj[k] = v;
        if (++count > 400) break; // keep cache bounded
      }
      chrome.storage.local.set({ aheadsub_trans_cache: obj }).catch(() => {});
    } catch {}
  }
}

// In-flight translation request deduplication map
const inFlightTranslations = new Map<string, Promise<TranslationCacheItem>>();

// Staggered parallel translation fetcher: races multiple Google Translate mirrors with Promise.any
async function fetchFastTranslation(urls: string[], timeoutMs: number = 3200): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const tryFetch = async (url: string): Promise<any> => {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      throw new Error('HTML response blocked');
    }
    if (contentType.includes('application/json') || url.includes('&dt=')) {
      const json = await res.json();
      return json;
    }
    const text = await res.text();
    const trimmed = text.trim();
    if (trimmed.startsWith('<') || trimmed.includes('GoogleSorry') || trimmed.includes("We're sorry")) {
      throw new Error('HTML response blocked');
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  const promises: Promise<any>[] = [tryFetch(urls[0])];

  // Stagger second endpoint by 200ms
  if (urls.length > 1) {
    promises.push(
      new Promise((resolve, reject) => {
        setTimeout(() => {
          if (controller.signal.aborted) return reject(new Error('Aborted'));
          tryFetch(urls[1]).then(resolve, reject);
        }, 200);
      })
    );
  }

  // Stagger third endpoint by 450ms
  if (urls.length > 2) {
    promises.push(
      new Promise((resolve, reject) => {
        setTimeout(() => {
          if (controller.signal.aborted) return reject(new Error('Aborted'));
          tryFetch(urls[2]).then(resolve, reject);
        }, 450);
      })
    );
  }

  try {
    const result = await Promise.any(promises);
    clearTimeout(timeoutId);
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error('All translation endpoints failed');
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleTranslateText(
  payload: { text: string; targetLang?: string; isWord?: boolean; sourceLang?: string },
  sendResponse: (r: any) => void
): Promise<void> {
  const text = payload?.text?.trim();
  let targetLang = payload?.targetLang || 'uz';
  const isWord = !!payload?.isWord;

  if (!text) {
    sendResponse({ translatedText: '', dictEntries: [] });
    return;
  }

  // Automatic script detection for source language:
  // If text contains Cyrillic, it is Russian. If text contains Latin letters, it is English.
  let srcLang = payload?.sourceLang && payload.sourceLang !== 'auto' ? payload.sourceLang : (state.settings.spokenLanguage || 'auto');
  if (/[а-яА-ЯёЁ]/u.test(text)) {
    srcLang = 'ru';
    if (targetLang === 'ru') {
      targetLang = 'uz';
    }
  } else if (/[a-zA-Z]/u.test(text)) {
    srcLang = 'en';
    if (targetLang === 'en') {
      targetLang = 'uz';
    }
  }
  if (srcLang === targetLang) {
    targetLang = srcLang === 'uz' ? 'ru' : 'uz';
  }

  const lowerText = text.toLowerCase();
  const cacheKey = `${targetLang}:${lowerText}`;
  if (translationCache.has(cacheKey)) {
    const cached = translationCache.get(cacheKey)!;
    if (cached.translatedText && cached.translatedText.trim().toLowerCase() !== lowerText) {
      sendResponse(cached);
      return;
    }
    translationCache.delete(cacheKey);
  }

  // If identical translation request is currently in-flight, await and share the result!
  if (inFlightTranslations.has(cacheKey)) {
    try {
      const sharedResult = await inFlightTranslations.get(cacheKey)!;
      sendResponse(sharedResult);
    } catch {
      sendResponse({ translatedText: '', dictEntries: [] });
    }
    return;
  }

  const translationPromise = (async (): Promise<TranslationCacheItem> => {
    // 1. Instant local dictionary checks (0ms latency)
    if (targetLang === 'uz') {
      if (RUSSIAN_COLLOCATIONS[lowerText]) {
        const col = RUSSIAN_COLLOCATIONS[lowerText]!;
        const result: TranslationCacheItem = {
          translatedText: col.uz,
          dictEntries: [{ pos: 'PHRASE', terms: [], base: text }],
          sourceLang: 'ru',
        };
        persistTranslation(cacheKey, result);
        return result;
      }
      if (INSTANT_UZBEK_WORDS[lowerText]) {
        const inst = INSTANT_UZBEK_WORDS[lowerText]!;
        const result: TranslationCacheItem = {
          translatedText: inst.uz,
          dictEntries: [{ pos: inst.pos || '', terms: [], base: inst.base || text }],
          sourceLang: 'ru',
        };
        persistTranslation(cacheKey, result);
        return result;
      }
    } else if (targetLang === 'en') {
      if (RUSSIAN_COLLOCATIONS[lowerText]) {
        const col = RUSSIAN_COLLOCATIONS[lowerText]!;
        const result: TranslationCacheItem = {
          translatedText: col.en,
          dictEntries: [{ pos: 'PHRASE', terms: [], base: text }],
          sourceLang: 'ru',
        };
        persistTranslation(cacheKey, result);
        return result;
      }
    }

    const encoded = encodeURIComponent(text);

    // 2. High-speed Google Translate API Endpoints (prioritizing clients5 dict-chrome-ex which bypasses bot blocks)
    const endpoints = isWord
      ? [
          `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(srcLang)}&tl=${encodeURIComponent(targetLang)}&q=${encoded}`,
          `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=${encodeURIComponent(srcLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&dt=bd&q=${encoded}`,
          `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(srcLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&dt=bd&q=${encoded}`,
        ]
      : [
          `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=${encodeURIComponent(srcLang)}&tl=${encodeURIComponent(targetLang)}&q=${encoded}`,
          `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=${encodeURIComponent(srcLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encoded}`,
          `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(srcLang)}&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encoded}`,
        ];

    try {
      const data = await fetchFastTranslation(endpoints, 3200);
      let translated = '';

      if (typeof data === 'string') {
        translated = data;
      } else if (Array.isArray(data)) {
        if (typeof data[0] === 'string') {
          translated = data[0];
        } else if (Array.isArray(data[0])) {
          // clients5 dict-chrome-ex returns [ ["translated text", "ru"] ]
          if (typeof data[0][0] === 'string' && (data[0].length === 1 || (data[0].length === 2 && typeof data[0][1] === 'string' && data[0][1].length <= 5))) {
            translated = data[0][0];
          } else {
            // dt=t chunked format: [ [ ["chunk1", "orig1"], ["chunk2", "orig2"] ] ]
            for (const item of data[0]) {
              if (Array.isArray(item) && typeof item[0] === 'string') {
                translated += item[0];
              } else if (typeof item === 'string') {
                translated += item;
              }
            }
          }
        }
      }

      const dictEntries: Array<{ pos: string; terms: string[]; base?: string }> = [];
      if (isWord && Array.isArray(data?.[1])) {
        for (const entry of data[1]) {
          if (entry && entry[0]) {
            dictEntries.push({
              pos: entry[0],
              terms: Array.isArray(entry[1]) ? entry[1].slice(0, 5) : [],
              base: entry[3] || '',
            });
          }
        }
      }

      if (
        translated &&
        translated.trim() &&
        translated.trim().toLowerCase() !== text.toLowerCase() &&
        !translated.includes('<') &&
        !translated.includes('GoogleSorry')
      ) {
        const cleanTranslated = translated.trim()
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        const result: TranslationCacheItem = { translatedText: cleanTranslated, dictEntries, sourceLang: srcLang };
        persistTranslation(cacheKey, result);
        return result;
      }
    } catch {}

    // 3. Fallback: MyMemory API
    try {
      const mmUrl = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=${encodeURIComponent(srcLang)}|${encodeURIComponent(targetLang)}`;
      const res = await fetch(mmUrl, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const mmData = await res.json();
        const translated = mmData?.responseData?.translatedText;
        if (
          translated &&
          !translated.startsWith('MYMEMORY WARNING') &&
          translated.trim() &&
          translated.trim().toLowerCase() !== text.toLowerCase()
        ) {
          const result: TranslationCacheItem = { translatedText: translated.trim(), dictEntries: [], sourceLang: srcLang };
          persistTranslation(cacheKey, result);
          return result;
        }
      }
    } catch {}

    // Return empty string on failure instead of original text to prevent showing Russian in translation line
    return { translatedText: '', dictEntries: [] };
  })();

  inFlightTranslations.set(cacheKey, translationPromise);

  try {
    const finalResult = await translationPromise;
    sendResponse(finalResult);
  } catch {
    sendResponse({ translatedText: '', dictEntries: [] });
  } finally {
    inFlightTranslations.delete(cacheKey);
  }
}

async function handleStartGeneration(
  payload: StartGenerationPayload & { tabId?: number },
  sendResponse: (r: any) => void
): Promise<void> {
  const targetTabId = payload.tabId || state.activeTabId || 0;
  const session = targetTabId ? getTabSession(targetTabId) : null;

  // Always use the fresh settings from the popup — never allow a stale
  // auto-detected language from a previous session to bleed through.
  // Explicitly copy to break any reference sharing with offscreen.
  const freshSettings: AheadSubSettings = { ...payload.settings };
  state.settings = freshSettings;

  // Persist to storage so GET_SETTINGS always returns the correct user-set language
  chrome.storage.local.set({ settings: freshSettings }).catch(() => {});

  state.cues = [];
  state.result = null;

  if (session) {
    session.cues = [];
    session.result = null;
    if (session.videoInfo) {
      session.videoInfo = applyManifestToInfo(session.videoInfo, targetTabId);
    }
    session.progress = {
      state: PipelineState.ANALYZING,
      mode: freshSettings.processingMode,
      processedDuration: 0,
      totalDuration: session.videoInfo?.duration || 0,
      currentChunkStart: 0,
      currentChunkEnd: 0,
      cuesGenerated: 0,
      safePlaybackThrough: 0,
    };
  }

  state.progress = session?.progress ?? {
    state: PipelineState.ANALYZING,
    mode: freshSettings.processingMode,
    processedDuration: 0,
    totalDuration: state.videoInfo?.duration || 0,
    currentChunkStart: 0,
    currentChunkEnd: 0,
    cuesGenerated: 0,
    safePlaybackThrough: 0,
  };

  sendResponse({ success: true, progress: state.progress });

  // 1. Check if native subtitles (e.g. YouTube captions) can be fetched directly in 1-2s
  if (targetTabId) {
    chrome.tabs.sendMessage(targetTabId, {
      type: 'AHEADSUB_CHECK_NATIVE_CAPTIONS',
      payload: {
        targetLanguage: freshSettings.hoverTranslationLanguage || freshSettings.subtitleLanguage || 'uz',
        spokenLanguage: freshSettings.spokenLanguage || 'en',
      }
    }).then((res: any) => {
      if (res?.success && res.cues && res.cues.length > 0) {
        console.log(`[AheadSub BG] Native subtitles extracted (${res.cues.length} cues)!`);
        if (session) {
          session.cues = res.cues;
          session.progress.state = PipelineState.COMPLETE;
          session.progress.cuesGenerated = res.cues.length;
          session.progress.processedDuration = session.videoInfo?.duration || 100;
          session.progress.totalDuration = session.videoInfo?.duration || 100;
        }
        state.cues = res.cues;
        state.progress.state = PipelineState.COMPLETE;
        state.progress.cuesGenerated = res.cues.length;
        state.progress.processedDuration = state.videoInfo?.duration || 100;
        state.progress.totalDuration = state.videoInfo?.duration || 100;

        // Stop offscreen model load/transcription since we already have high-accuracy subtitles
        chrome.runtime.sendMessage({
          type: MessageType.STOP_OFFSCREEN_PIPELINE,
          payload: { tabId: targetTabId }
        }).catch(() => {});
      }
    }).catch(() => {});
  }

  // Ensure offscreen document exists
  await ensureOffscreenDocument();

  // Start the transcription pipeline
  if (session) session.progress.state = PipelineState.LOADING_MODEL;
  state.progress.state = PipelineState.LOADING_MODEL;

  // Send model load request to offscreen with tabId and FRESH settings
  try {
    await chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_LOAD_MODEL,
      payload: {
        modelId: freshSettings.modelSize,
        language: freshSettings.spokenLanguage,
        useWebGPU: freshSettings.useWebGPU,
        tabId: targetTabId,
      },
    });
  } catch (error) {
    console.error('[AheadSub BG] Failed to send to offscreen:', error);
    if (session) {
      session.progress.state = PipelineState.ERROR;
      session.progress.error = 'Failed to initialize transcription engine';
    }
    state.progress.state = PipelineState.ERROR;
    state.progress.error = 'Failed to initialize transcription engine';
  }
}

function handleStopGeneration(sendResponse: (r: any) => void, tabId?: number): void {
  const targetTabId = tabId ?? state.activeTabId;
  if (targetTabId && tabSessions.has(targetTabId)) {
    tabSessions.get(targetTabId)!.progress.state = PipelineState.IDLE;
  }
  state.progress.state = PipelineState.IDLE;
  chrome.runtime.sendMessage({
    type: MessageType.STOP_OFFSCREEN_PIPELINE,
    payload: { tabId: targetTabId }
  }).catch(() => {});
  sendResponse({ success: true });
}

function handleTranscriptionResult(payload: TranscriptionResultPayload & { tabId?: number }): void {
  const targetTabId = payload.tabId ?? state.activeTabId;
  const session = targetTabId ? getTabSession(targetTabId) : null;

  if (session) {
    session.cues.push(...payload.cues);
    session.progress.cuesGenerated = session.cues.length;
    session.progress.processedDuration = payload.chunkStartTime + 30; // approximate
    session.progress.safePlaybackThrough = payload.chunkStartTime;
    if (session.progress.processedDuration >= session.progress.totalDuration && session.progress.totalDuration > 0) {
      session.progress.state = PipelineState.COMPLETE;
    }
  }

  // Update global state if active tab
  if (!targetTabId || targetTabId === state.activeTabId) {
    state.cues.push(...payload.cues);
    state.progress.cuesGenerated = state.cues.length;
    state.progress.processedDuration = payload.chunkStartTime + 30;
    state.progress.safePlaybackThrough = payload.chunkStartTime;
    if (state.progress.processedDuration >= state.progress.totalDuration && state.progress.totalDuration > 0) {
      state.progress.state = PipelineState.COMPLETE;
      state.result = {
        cues: state.cues,
        language: state.settings.spokenLanguage,
        duration: state.progress.totalDuration,
        modelId: state.settings.modelSize,
        processedAt: Date.now(),
        processingTimeMs: 0,
        mode: state.settings.processingMode,
      };
    }
  }

  if (payload.detectedLanguage) {
    console.log(`[AheadSub BG] Detected language: ${payload.detectedLanguage} (Tab: ${targetTabId})`);
  }

  // Forward new cues and transcription result to content script — target specific tab and frame
  if (targetTabId !== null && targetTabId !== undefined) {
    const frameId = session?.activeFrameId ?? state.activeFrameId ?? 0;
    const msgOpts = { frameId };

    const updateMsg = {
      type: MessageType.UPDATE_SUBTITLES,
      payload: {
        newCues: payload.cues,
        processedThrough: session?.progress.processedDuration ?? state.progress.processedDuration,
      },
    };

    chrome.tabs.sendMessage(targetTabId, updateMsg, msgOpts).catch(() => {});
    if (frameId !== 0) {
      chrome.tabs.sendMessage(targetTabId, updateMsg).catch(() => {});
    }
    
    // CRITICAL: forward OFFSCREEN_TRANSCRIPTION_RESULT so the pipeline's awaiting Promise resolves
    chrome.tabs.sendMessage(targetTabId, {
      type: MessageType.OFFSCREEN_TRANSCRIPTION_RESULT,
      payload,
    }, msgOpts).catch(() => {});
    if (frameId !== 0) {
      chrome.tabs.sendMessage(targetTabId, {
        type: MessageType.OFFSCREEN_TRANSCRIPTION_RESULT,
        payload,
      }).catch(() => {});
    }
  }
}

function handleExport(format: 'vtt' | 'srt', sendResponse: (r: any) => void, tabId?: number): void {
  const targetTabId = tabId ?? state.activeTabId;
  const session = targetTabId ? tabSessions.get(targetTabId) : null;
  const cues = (session?.cues && session.cues.length > 0) ? session.cues : state.cues;

  if (cues.length === 0) {
    sendResponse({ error: 'No subtitles to export' });
    return;
  }

  let content: string;
  if (format === 'vtt') {
    content = generateVTT(cues);
  } else {
    content = generateSRT(cues);
  }

  sendResponse({ content, format });
}

async function handleGetHardwareInfo(sendResponse: (r: any) => void): Promise<void> {
  await ensureOffscreenDocument();
  try {
    await chrome.runtime.sendMessage({
      type: MessageType.OFFSCREEN_DETECT_HARDWARE,
    });
    // Response will come back through OFFSCREEN_HARDWARE_INFO
    sendResponse({ pending: true });
  } catch {
    sendResponse({
      webgpu: false,
      wasm: true,
      simd: true,
      threads: true,
      estimatedCores: navigator.hardwareConcurrency || 4,
      estimatedMemoryGB: 4,
    });
  }
}

// --- Offscreen Document Management ---

async function ensureOffscreenDocument(): Promise<void> {
  if (state.isOffscreenCreated) return;

  // Check if already exists
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT as any],
  });

  if (existingContexts.length > 0) {
    state.isOffscreenCreated = true;
    return;
  }

  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS as any],
      justification: 'Running Whisper AI transcription in a Web Worker',
    });
    state.isOffscreenCreated = true;
    console.log('[AheadSub BG] Offscreen document created');
  } catch (error) {
    console.error('[AheadSub BG] Failed to create offscreen document:', error);
  }
}

// --- Forward Messages ---

async function forwardToActiveTab(message: ExtensionMessage): Promise<void> {
  if (!state.activeTabId) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    state.activeTabId = tabs[0]?.id ?? null;
  }

  if (state.activeTabId) {
    const session = tabSessions.get(state.activeTabId);
    const frameId = session?.activeFrameId ?? state.activeFrameId ?? 0;
    await chrome.tabs.sendMessage(state.activeTabId, message, { frameId }).catch(() => {});
    if (frameId !== 0) {
      await chrome.tabs.sendMessage(state.activeTabId, message).catch(() => {});
    }
  }
}

// --- VTT/SRT Generation ---

function formatTime(seconds: number, separator: string = '.'): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}${separator}${ms.toString().padStart(3, '0')}`;
}

function generateVTT(cues: SubtitleCue[]): string {
  let vtt = 'WEBVTT\n\n';
  for (const cue of cues) {
    vtt += `${cue.id}\n`;
    vtt += `${formatTime(cue.startTime)} --> ${formatTime(cue.endTime)}\n`;
    vtt += `${cue.text}\n\n`;
  }
  return vtt;
}

function generateSRT(cues: SubtitleCue[]): string {
  let srt = '';
  for (let i = 0; i < cues.length; i++) {
    const cue = cues[i]!;
    srt += `${i + 1}\n`;
    srt += `${formatTime(cue.startTime, ',')} --> ${formatTime(cue.endTime, ',')}\n`;
    srt += `${cue.text}\n\n`;
  }
  return srt;
}

// --- Load Settings on Startup ---

chrome.storage.local.get('settings', (data) => {
  if (data.settings) {
    state.settings = { ...DEFAULT_SETTINGS, ...data.settings };
  }
});

// --- Extension Icon Click ---

chrome.action.onClicked.addListener(async (tab) => {
  // Popup handles this, but just in case
  if (tab.id) {
    state.activeTabId = tab.id;
  }
});

console.log('[AheadSub] Background service worker started');
