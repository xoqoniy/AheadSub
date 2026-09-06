// ============================================================
// AheadSub — Constants
// ============================================================

import type { WhisperModelConfig, AheadSubSettings } from './types';
import { ProcessingMode } from './types';

// --- Whisper Models ---

export const WHISPER_MODELS: Record<string, WhisperModelConfig> = {
  tiny: {
    id: 'tiny',
    name: 'Tiny (fastest)',
    size: 'tiny',
    onnxModelId: 'Xenova/whisper-tiny',
    estimatedSizeMB: 40,
    estimatedSpeedFactor: 0.1,
  },
  base: {
    id: 'base',
    name: 'Base (balanced)',
    size: 'base',
    onnxModelId: 'Xenova/whisper-base',
    estimatedSizeMB: 75,
    estimatedSpeedFactor: 0.2,
  },
  small: {
    id: 'small',
    name: 'Small (recommended)',
    size: 'small',
    onnxModelId: 'Xenova/whisper-small',
    estimatedSizeMB: 250,
    estimatedSpeedFactor: 0.5,
  },
  medium: {
    id: 'medium',
    name: 'Medium (best quality)',
    size: 'medium',
    onnxModelId: 'Xenova/whisper-medium',
    estimatedSizeMB: 780,
    estimatedSpeedFactor: 1.5,
  },
};

// --- Supported Languages ---

export const SUPPORTED_LANGUAGES: Record<string, string> = {
  auto: 'Auto-detect',
  uz: "O'zbekcha (Uzbek)",
  en: 'English',
  ru: 'Русский (Russian)',
  ja: '日本語 (Japanese)',
  ko: '한국어 (Korean)',
  zh: '中文 (Chinese)',
  de: 'Deutsch (German)',
  fr: 'Français (French)',
  es: 'Español (Spanish)',
  pt: 'Português (Portuguese)',
  it: 'Italiano (Italian)',
  ar: 'العربية (Arabic)',
  hi: 'हिन्दी (Hindi)',
  uk: 'Українська (Ukrainian)',
  pl: 'Polski (Polish)',
  tr: 'Türkçe (Turkish)',
  nl: 'Nederlands (Dutch)',
  sv: 'Svenska (Swedish)',
  cs: 'Čeština (Czech)',
  th: 'ไทย (Thai)',
};

// No 'auto' for subtitle language output
export const SUBTITLE_LANGUAGES: Record<string, string> = Object.fromEntries(
  Object.entries(SUPPORTED_LANGUAGES).filter(([k]) => k !== 'auto')
);

// --- Default Settings ---

export const DEFAULT_SETTINGS: AheadSubSettings = {
  spokenLanguage: 'auto',
  subtitleLanguage: 'en',
  modelSize: 'tiny',
  processingMode: ProcessingMode.FULL_PRE_GENERATION,
  aheadBufferSeconds: 45,
  subtitleOffset: 0,
  maxCharsPerLine: 42,
  maxLines: 2,
  fontSize: 28,
  fontColor: '#FFFFFF',
  outlineColor: '#000000',
  outlineWidth: 2,
  subtitlePosition: 'bottom',
  showOverlay: true,
  useWebGPU: true,
  translationMode: 'local',
  hoverTranslationEnabled: true,
  hoverTranslationLanguage: 'uz',
  translationDisplayMode: 'word',
  autoPauseOnWordHover: true,
};

// --- Audio Processing ---

export const AUDIO_CHUNK_DURATION_S = 30;
export const AUDIO_CHUNK_OVERLAP_S = 3;
export const WHISPER_SAMPLE_RATE = 16000;
export const WHISPER_MAX_AUDIO_LENGTH_S = 30;

// --- Subtitle Rendering ---

export const MIN_CUE_DURATION_S = 0.8;
export const MAX_CUE_DURATION_S = 7.0;
export const MAX_CHARS_PER_SECOND = 21;  // reading speed
export const MIN_GAP_BETWEEN_CUES_S = 0.05;

// --- Cache ---

export const CACHE_DB_NAME = 'aheadsub-cache';
export const CACHE_DB_VERSION = 1;
export const CACHE_STORE_NAME = 'subtitles';
export const MAX_CACHE_ENTRIES = 200;
export const MAX_CACHE_SIZE_MB = 100;

// --- Extension ---

export const EXTENSION_NAME = 'AheadSub';
export const OFFSCREEN_DOCUMENT_PATH = 'src/offscreen/offscreen.html';
