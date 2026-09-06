// ============================================================
// AheadSub — Popup Script
// Manages all popup UI interactions, communicates with
// the background service worker.
// ============================================================

import { MessageType } from '../core/messages';
import type { ExtensionMessage } from '../core/messages';
import { SUPPORTED_LANGUAGES, SUBTITLE_LANGUAGES, WHISPER_MODELS, DEFAULT_SETTINGS } from '../core/constants';
import type { AheadSubSettings, PipelineProgress } from '../core/types';
import { ProcessingMode, PipelineState } from '../core/types';

// --- DOM Elements ---

const elements = {
  statusIndicator: document.getElementById('statusIndicator')!,
  statusText: document.getElementById('statusText')!,
  videoInfo: document.getElementById('videoInfo')!,
  videoTitle: document.getElementById('videoTitle')!,
  videoDuration: document.getElementById('videoDuration')!,
  audioAccess: document.getElementById('audioAccess')!,
  spokenLang: document.getElementById('spokenLang') as HTMLSelectElement,
  subtitleLang: document.getElementById('subtitleLang') as HTMLSelectElement,
  modelSize: document.getElementById('modelSize') as HTMLSelectElement,
  generateBtn: document.getElementById('generateBtn') as HTMLButtonElement,
  progressSection: document.getElementById('progressSection')!,
  progressLabel: document.getElementById('progressLabel')!,
  progressPct: document.getElementById('progressPct')!,
  progressFill: document.getElementById('progressFill')!,
  progressThrough: document.getElementById('progressThrough')!,
  safeThrough: document.getElementById('safeThrough')!,
  cueCount: document.getElementById('cueCount')!,
  completeSection: document.getElementById('completeSection')!,
  completeDetails: document.getElementById('completeDetails')!,
  controlsSection: document.getElementById('controlsSection')!,
  showBtn: document.getElementById('showBtn')!,
  hideBtn: document.getElementById('hideBtn')!,
  offsetValue: document.getElementById('offsetValue')!,
  exportSection: document.getElementById('exportSection')!,
  exportVTT: document.getElementById('exportVTT')!,
  exportSRT: document.getElementById('exportSRT')!,
  loadVTT: document.getElementById('loadVTT')!,
  vttFileInput: document.getElementById('vttFileInput') as HTMLInputElement,
  modeWarning: document.getElementById('modeWarning')!,
  warningText: document.getElementById('warningText')!,
  clearCache: document.getElementById('clearCache')!,
  resetEpisodeBtn: document.getElementById('resetEpisodeBtn') as HTMLButtonElement,
  enableTranslation: document.getElementById('enableTranslation') as HTMLInputElement,
  translationTargetLang: document.getElementById('translationTargetLang') as HTMLSelectElement,
  translationOptions: document.getElementById('translationOptions') as HTMLDivElement,
  autoPauseOnWordHover: document.getElementById('autoPauseOnWordHover') as HTMLInputElement,
};

// --- State ---

let currentTabId = 0;
let currentSettings: AheadSubSettings = { ...DEFAULT_SETTINGS };
let currentOffset = 0;
let progressPollInterval: ReturnType<typeof setInterval> | null = null;
let videoFound = false;
let currentVideoInfo: any = null;

// --- Init ---

async function init(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentTabId = tabs[0]?.id || 0;
  } catch {}

  populateSelects();
  await loadSettings();
  await detectVideo();
  setupEventListeners();

  // Show export section immediately (for manual VTT loading)
  elements.exportSection.style.display = 'flex';

  // Restore active progress if pipeline is already running or completed
  try {
    const progRes = await sendMessage<any>(MessageType.GET_PROGRESS);
    if (progRes?.progress) {
      const state = progRes.progress.state;
      if (state === PipelineState.LOADING_MODEL || state === PipelineState.TRANSCRIBING) {
        elements.generateBtn.disabled = true;
        elements.generateBtn.innerHTML = '<span class="btn-icon">⏳</span> Jarayonda...';
        elements.controlsSection.style.display = 'block';
        updateProgress(progRes.progress);
        startProgressPolling();
      } else if (state === PipelineState.COMPLETE) {
        elements.controlsSection.style.display = 'block';
        showComplete(progRes.progress);
      }
    }
  } catch {
    // Ignore error
  }
}

function populateSelects(): void {
  // Spoken language
  for (const [code, name] of Object.entries(SUPPORTED_LANGUAGES)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    elements.spokenLang.appendChild(opt);
  }

  // Subtitle language
  for (const [code, name] of Object.entries(SUBTITLE_LANGUAGES)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    elements.subtitleLang.appendChild(opt);
  }
}

async function loadSettings(): Promise<void> {
  try {
    const response = await sendMessage<any>(MessageType.GET_SETTINGS);
    if (response?.settings) {
      currentSettings = { ...DEFAULT_SETTINGS, ...response.settings };
    }
  } catch {
    // Use defaults
  }

  // Apply to UI
  elements.spokenLang.value = currentSettings.spokenLanguage;
  elements.subtitleLang.value = currentSettings.subtitleLanguage;
  elements.modelSize.value = currentSettings.modelSize;

  // Set mode radio
  const modeRadios = document.querySelectorAll('input[name="mode"]') as NodeListOf<HTMLInputElement>;
  for (const radio of modeRadios) {
    radio.checked = radio.value === currentSettings.processingMode;
  }

  // Translation settings
  if (elements.enableTranslation) {
    elements.enableTranslation.checked = currentSettings.hoverTranslationEnabled ?? true;
  }
  if (elements.translationTargetLang) {
    elements.translationTargetLang.value = currentSettings.hoverTranslationLanguage ?? 'uz';
  }
  const transRadios = document.querySelectorAll('input[name="transMode"]') as NodeListOf<HTMLInputElement>;
  for (const radio of transRadios) {
    radio.checked = radio.value === (currentSettings.translationDisplayMode ?? 'word');
  }
  if (elements.autoPauseOnWordHover) {
    elements.autoPauseOnWordHover.checked = currentSettings.autoPauseOnWordHover ?? true;
  }
  if (elements.translationOptions) {
    elements.translationOptions.style.display = (currentSettings.hoverTranslationEnabled ?? true) ? 'flex' : 'none';
  }
}

async function detectVideo(): Promise<void> {
  try {
    const response = await sendMessage<any>(MessageType.GET_VIDEO_INFO);

    if (response?.found && response.info) {
      videoFound = true;
      showVideoFound(response.info);
    } else {
      videoFound = false;
      showVideoSearching();
      // Faster retry so dynamically mounted videos on SPAs appear immediately
      setTimeout(detectVideo, 800);
    }
  } catch {
    showVideoSearching();
    setTimeout(detectVideo, 1200);
  }
}

// --- UI Updates ---

function showVideoFound(info: any): void {
  currentVideoInfo = info;
  const dot = elements.statusIndicator.querySelector('.dot')!;
  dot.className = 'dot dot-found';
  elements.statusText.textContent = 'Video aniqlandi';

  elements.videoInfo.style.display = 'flex';
  elements.videoTitle.textContent = info.title || 'Nomsiz video';
  elements.videoDuration.textContent = formatDuration(info.duration || 0);
  elements.audioAccess.textContent = formatAudioAccess(info.audioAccessMethod, info.manifestUrl, info.sourceUrl);

  elements.generateBtn.disabled = false;
  if (elements.modeWarning.style.display !== 'none' && info.manifestUrl) {
    elements.modeWarning.style.display = 'none';
  }
}

function showVideoSearching(): void {
  const dot = elements.statusIndicator.querySelector('.dot')!;
  dot.className = 'dot dot-searching';
  elements.statusText.textContent = 'Video qidirilmoqda...';
  elements.videoInfo.style.display = 'none';
  elements.generateBtn.disabled = true;
}

function updateProgress(progress: PipelineProgress): void {
  let pct = 0;
  if (progress.state === PipelineState.LOADING_MODEL) {
    pct = progress.modelLoadingProgress ? Math.round(progress.modelLoadingProgress) : 0;
  } else {
    pct = progress.totalDuration > 0
      ? Math.round((progress.processedDuration / progress.totalDuration) * 100)
      : 0;
  }

  elements.progressSection.style.display = 'block';
  elements.progressLabel.textContent = getStateLabel(progress.state);
  elements.progressPct.textContent = `${pct}%`;
  elements.progressFill.style.width = `${pct}%`;
  
  if (progress.state === PipelineState.LOADING_MODEL) {
    elements.progressThrough.textContent = `AI modeli yuklanmoqda...`;
    elements.safeThrough.textContent = '0:00';
    elements.cueCount.textContent = '0';
  } else {
    elements.progressThrough.textContent =
      `${formatDuration(progress.processedDuration)} / ${formatDuration(progress.totalDuration)}`;
    elements.safeThrough.textContent = formatDuration(progress.safePlaybackThrough);
    elements.cueCount.textContent = String(progress.cuesGenerated);
  }

  if (progress.state === PipelineState.COMPLETE) {
    showComplete(progress);
  } else if (progress.state === PipelineState.ERROR) {
    showError(progress.error || 'Noma\'lum xatolik');
  }
}

function showComplete(progress: PipelineProgress): void {
  elements.progressSection.style.display = 'none';
  elements.completeSection.style.display = 'block';
  elements.controlsSection.style.display = 'block';

  if (progress.cuesGenerated === 0) {
    elements.completeDetails.innerHTML = [
      `⚠️ ${formatDuration(progress.totalDuration)} ishlandi`,
      `<span style="color:#F87171; font-weight:700;">0 ta subtitr qatori topildi</span>`,
      `<span style="font-size:0.85em; color:#CBD5E1;">Maslahat: "Video tili (Nutq)" sozlamasidan to'g'ri tilni (masalan, Inglizcha yoki Ruscha) tanlab qayta urinib ko'ring.</span>`,
    ].join('<br>');
  } else {
    elements.completeDetails.innerHTML = [
      `✓ ${formatDuration(progress.totalDuration)} ishlandi`,
      `✓ ${progress.cuesGenerated} ta subtitr qatori`,
      `✓ Mahalliy keshga saqlandi`,
    ].join('<br>');
  }

  stopProgressPolling();
}

function showError(error: string): void {
  elements.progressLabel.textContent = `Xatolik: ${error}`;
  elements.progressFill.style.background = 'var(--error)';
  stopProgressPolling();
}

// --- Event Listeners ---

function setupEventListeners(): void {
  // Generate button
  elements.generateBtn.addEventListener('click', handleGenerate);

  // Show/Hide
  elements.showBtn.addEventListener('click', () => {
    sendMessage(MessageType.SHOW_OVERLAY);
  });
  elements.hideBtn.addEventListener('click', () => {
    sendMessage(MessageType.HIDE_OVERLAY);
  });

  // Offset controls
  document.querySelectorAll('[data-offset]').forEach(btn => {
    btn.addEventListener('click', () => {
      const delta = parseInt(btn.getAttribute('data-offset')!);
      currentOffset += delta;
      elements.offsetValue.textContent = `${currentOffset}ms`;
      sendMessage(MessageType.SET_OFFSET, currentOffset);
    });
  });

  // Export
  elements.exportVTT.addEventListener('click', () => handleExport('vtt'));
  elements.exportSRT.addEventListener('click', () => handleExport('srt'));

  // Load VTT
  elements.loadVTT.addEventListener('click', () => {
    elements.vttFileInput.click();
  });
  elements.vttFileInput.addEventListener('change', handleLoadVTT);

  // Clear cache
  elements.clearCache.addEventListener('click', async () => {
    await sendMessage(MessageType.CLEAR_CACHE);
    elements.clearCache.textContent = '✓ Tozalandi';
    setTimeout(() => {
      (elements.clearCache as HTMLButtonElement).textContent = 'Keshni tozalash';
    }, 2000);
  });

  // Settings changes — save
  elements.spokenLang.addEventListener('change', saveCurrentSettings);
  elements.subtitleLang.addEventListener('change', saveCurrentSettings);
  elements.modelSize.addEventListener('change', saveCurrentSettings);
  document.querySelectorAll('input[name="mode"]').forEach(radio => {
    radio.addEventListener('change', saveCurrentSettings);
  });

  // Reset episode button
  elements.resetEpisodeBtn?.addEventListener('click', async () => {
    elements.resetEpisodeBtn.disabled = true;
    elements.resetEpisodeBtn.textContent = '🔄 Skanerlanmoqda...';
    try {
      await sendMessage(MessageType.RESET_PIPELINE);
      // Reset popup UI state
      elements.progressSection.style.display = 'none';
      elements.completeSection.style.display = 'none';
      elements.controlsSection.style.display = 'none';
      elements.modeWarning.style.display = 'none';
      elements.generateBtn.disabled = true;
      elements.generateBtn.innerHTML = '<span class="btn-icon">▶</span> Subtitrlarni yaratish';
      stopProgressPolling();
      showVideoSearching();
      await detectVideo();
    } finally {
      elements.resetEpisodeBtn.disabled = false;
      elements.resetEpisodeBtn.textContent = '🔄 Yangi qism';
    }
  });

  // Translation settings listeners
  elements.enableTranslation?.addEventListener('change', () => {
    const enabled = elements.enableTranslation.checked;
    if (elements.translationOptions) {
      elements.translationOptions.style.display = enabled ? 'flex' : 'none';
    }
    saveCurrentSettings();
  });

  elements.translationTargetLang?.addEventListener('change', saveCurrentSettings);
  elements.autoPauseOnWordHover?.addEventListener('change', saveCurrentSettings);

  document.querySelectorAll('input[name="transMode"]').forEach(radio => {
    radio.addEventListener('change', saveCurrentSettings);
  });
}

async function handleGenerate(): Promise<void> {
  saveCurrentSettings();

  elements.generateBtn.disabled = true;
  elements.generateBtn.innerHTML = '<span class="btn-icon">⏳</span> Boshlanmoqda...';
  elements.completeSection.style.display = 'none';
  elements.modeWarning.style.display = 'none';

  // If manifest is missing and source is blob, poll briefly in case stream is just starting or being captured
  if (!currentVideoInfo?.manifestUrl && (!currentVideoInfo?.sourceUrl || currentVideoInfo?.sourceUrl.startsWith('blob:'))) {
    elements.generateBtn.innerHTML = '<span class="btn-icon">⏳</span> Video oqimi kutilmoqda...';
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res: any = await sendMessage(MessageType.GET_VIDEO_INFO);
        if (res?.info?.manifestUrl || (res?.info?.sourceUrl && !res.info.sourceUrl.startsWith('blob:'))) {
          currentVideoInfo = res.info;
          elements.audioAccess.textContent = formatAudioAccess(res.info.audioAccessMethod, res.info.manifestUrl, res.info.sourceUrl);
          break;
        }
      } catch {}
    }
  }

  // If no video is found at all on the page, inform user
  if (!currentVideoInfo || (!currentVideoInfo.duration && !currentVideoInfo.sourceUrl && !currentVideoInfo.isPlaying)) {
    elements.modeWarning.style.display = 'flex';
    elements.warningText.textContent = 'Sahifada video topilmadi. Iltimos, videoni oching va ijro eting.';
    elements.generateBtn.disabled = false;
    elements.generateBtn.innerHTML = '<span class="btn-icon">▶</span> Subtitrlarni yaratish';
    return;
  }

  try {
    elements.generateBtn.innerHTML = '<span class="btn-icon">⏳</span> Subtitrlar tayyorlanmoqda...';
    const response = await sendMessage<any>(MessageType.START_GENERATION, {
      tabId: currentTabId,
      settings: currentSettings,
    });

    if (response?.success) {
      startProgressPolling();
      elements.controlsSection.style.display = 'block';
    } else {
      elements.generateBtn.disabled = false;
      elements.generateBtn.innerHTML = '<span class="btn-icon">▶</span> Subtitrlarni yaratish';
    }
  } catch (error) {
    console.error('Failed to start generation:', error);
    elements.generateBtn.disabled = false;
    elements.generateBtn.innerHTML = '<span class="btn-icon">▶</span> Subtitrlarni yaratish';
  }
}

async function handleExport(format: 'vtt' | 'srt'): Promise<void> {
  try {
    const response = await sendMessage<any>(
      format === 'vtt' ? MessageType.EXPORT_VTT : MessageType.EXPORT_SRT
    );

    if (response?.content) {
      downloadFile(
        response.content,
        `subtitles.${format}`,
        format === 'vtt' ? 'text/vtt' : 'application/x-subrip'
      );
    } else if (response?.error) {
      alert(response.error);
    }
  } catch (error) {
    console.error('Export failed:', error);
  }
}

async function handleLoadVTT(): Promise<void> {
  const file = elements.vttFileInput.files?.[0];
  if (!file) return;

  const content = await file.text();

  try {
    await sendMessage(MessageType.LOAD_VTT_FILE, { vttContent: content });
    elements.controlsSection.style.display = 'block';
    elements.completeSection.style.display = 'block';
    elements.completeDetails.innerHTML = `✓ Fayldan yuklandi<br>✓ ${file.name}`;
  } catch (error) {
    console.error('Failed to load VTT:', error);
  }

  // Reset file input
  elements.vttFileInput.value = '';
}

function saveCurrentSettings(): void {
  const modeRadio = document.querySelector('input[name="mode"]:checked') as HTMLInputElement;
  const transModeRadio = document.querySelector('input[name="transMode"]:checked') as HTMLInputElement;

  currentSettings = {
    ...currentSettings,
    spokenLanguage: elements.spokenLang.value,
    subtitleLanguage: elements.subtitleLang.value,
    modelSize: elements.modelSize.value as any,
    processingMode: (modeRadio?.value || 'full') as ProcessingMode,
    hoverTranslationEnabled: elements.enableTranslation?.checked ?? true,
    hoverTranslationLanguage: elements.translationTargetLang?.value ?? 'uz',
    translationDisplayMode: (transModeRadio?.value || 'word') as 'word' | 'hover' | 'dual',
    autoPauseOnWordHover: elements.autoPauseOnWordHover?.checked ?? true,
  };

  sendMessage(MessageType.SAVE_SETTINGS, currentSettings).catch(() => {});
}

// --- Progress Polling ---

function startProgressPolling(): void {
  stopProgressPolling();
  progressPollInterval = setInterval(async () => {
    try {
      const response = await sendMessage<any>(MessageType.GET_PROGRESS);
      if (response?.progress) {
        updateProgress(response.progress);
      }
    } catch {
      // Popup may have closed
    }
  }, 1000);
}

function stopProgressPolling(): void {
  if (progressPollInterval) {
    clearInterval(progressPollInterval);
    progressPollInterval = null;
  }
}

// --- Helpers ---

function formatDuration(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatAudioAccess(method: string, manifestUrl?: string, sourceUrl?: string): string {
  if (manifestUrl) {
    return manifestUrl.toLowerCase().includes('.mpd') ? '✓ DASH Oqim' : '✓ HLS Oqim';
  }
  if (sourceUrl && sourceUrl.startsWith('http')) {
    if (sourceUrl.includes('googlevideo.com') || sourceUrl.includes('youtube.com')) {
      return '✓ YouTube Oqimi';
    }
    return "✓ To'g'ridan-to'g'ri URL";
  }
  if (currentVideoInfo?.pageUrl && (currentVideoInfo.pageUrl.includes('youtube.com') || currentVideoInfo.pageUrl.includes('youtu.be'))) {
    return '✓ YouTube Oqimi';
  }
  if (method === 'capture_stream' || method === 'mse_intercept' || sourceUrl?.startsWith('blob:')) {
    return '⚡ Oqimni ushlab olish';
  }
  const labels: Record<string, string> = {
    direct_url: "✓ To'g'ridan-to'g'ri URL",
    hls_manifest: '✓ HLS Oqim',
    dash_manifest: '✓ DASH Oqim',
    capture_stream: '⚡ Oqimni ushlab olish',
    tab_capture: '⚡ Tab audio',
    mse_intercept: '⚡ Oqimni ushlab olish',
    none: '✗ Manba topilmadi',
  };
  return labels[method] || method;
}

function getStateLabel(state: PipelineState): string {
  const labels: Record<string, string> = {
    idle: 'Kutish rejimi',
    analyzing: 'Video tahlil qilinmoqda...',
    extracting_audio: 'Audio ajratib olinmoqda...',
    loading_model: 'AI modeli yuklanmoqda...',
    transcribing: 'Subtitrlar yozilmoqda...',
    translating: 'Tarjima qilinmoqda...',
    generating_subtitles: 'Subtitrlar yaratilmoqda...',
    complete: 'Tayyor',
    error: 'Xatolik',
    cached: 'Keshdan yuklandi',
  };
  return labels[state] || state;
}

function downloadFile(content: string, filename: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sendMessage<T>(type: MessageType, payload?: any): Promise<T> {
  let finalPayload = payload;
  if (typeof payload === 'object' && payload !== null) {
    finalPayload = { tabId: currentTabId, ...payload };
  } else if (payload === undefined) {
    finalPayload = { tabId: currentTabId };
  }
  return chrome.runtime.sendMessage({ type, payload: finalPayload });
}

// --- Start ---

init();
