// ============================================================
// AheadSub — Core Type Definitions
// ============================================================

// --- Transcription Types ---

export interface TranscriptionWord {
  word: string;
  start: number;  // seconds
  end: number;    // seconds
  confidence: number;
  speaker?: number;
}

export interface SubtitleCue {
  id: string;
  startTime: number;  // seconds
  endTime: number;    // seconds
  text: string;
  words: TranscriptionWord[];
  speaker?: number;
  originalText?: string;  // pre-translation text
}

export interface TranscriptionResult {
  cues: SubtitleCue[];
  language: string;
  detectedLanguage?: string;
  duration: number;
  modelId: string;
  processedAt: number;
  processingTimeMs: number;
  mode: ProcessingMode;
}

// --- Processing Modes ---

export enum ProcessingMode {
  FULL_PRE_GENERATION = 'full',
  AHEAD_BUFFER = 'buffer',
  REALTIME = 'realtime',
}

// --- Audio Types ---

export enum AudioAccessMethod {
  DIRECT_URL = 'direct_url',
  HLS_MANIFEST = 'hls_manifest',
  DASH_MANIFEST = 'dash_manifest',
  CAPTURE_STREAM = 'capture_stream',
  TAB_CAPTURE = 'tab_capture',
  MSE_INTERCEPT = 'mse_intercept',
  NONE = 'none',
}

export interface MediaInfo {
  videoElement: HTMLVideoElement | null;
  title: string;
  duration: number;
  currentTime: number;
  sourceUrl: string;
  sourceType: 'direct' | 'blob' | 'mse' | 'unknown';
  isPlaying: boolean;
  playbackRate: number;
  dimensions: { width: number; height: number };
  audioAccessMethod: AudioAccessMethod;
  pageUrl: string;
  estimatedBitrate?: number;
  manifestUrl?: string;
}

export interface AudioAccessResult {
  method: AudioAccessMethod;
  url?: string;
  manifestUrl?: string;
  segments?: AudioSegment[];
  stream?: MediaStream;
  canPreGenerate: boolean;
  canBuffer: boolean;
  limitation?: string;
}

export interface AudioSegment {
  url: string;
  startTime: number;
  endTime: number;
  duration: number;
  byteRange?: { start: number; end: number };
}

export interface AudioChunk {
  pcmData: Float32Array;
  sampleRate: number;
  startTime: number;   // seconds in the original media timeline
  endTime: number;
  chunkIndex: number;
  isLast: boolean;
}

// --- Pipeline Types ---

export interface PipelineProgress {
  state: PipelineState;
  mode: ProcessingMode;
  processedDuration: number;  // seconds
  totalDuration: number;      // seconds
  currentChunkStart: number;
  currentChunkEnd: number;
  cuesGenerated: number;
  safePlaybackThrough: number;  // seconds — can watch up to here
  modelLoadingProgress?: number; // 0 to 100 percentage
  estimatedTimeRemaining?: number;  // seconds
  error?: string;
}

export enum PipelineState {
  IDLE = 'idle',
  ANALYZING = 'analyzing',
  EXTRACTING_AUDIO = 'extracting_audio',
  LOADING_MODEL = 'loading_model',
  TRANSCRIBING = 'transcribing',
  TRANSLATING = 'translating',
  GENERATING_SUBTITLES = 'generating_subtitles',
  COMPLETE = 'complete',
  ERROR = 'error',
  CACHED = 'cached',
}

// --- Model Types ---

export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium';

export interface WhisperModelConfig {
  id: string;
  name: string;
  size: WhisperModelSize;
  onnxModelId: string;
  estimatedSizeMB: number;
  estimatedSpeedFactor: number;  // relative to real-time (< 1 means faster than realtime)
}

export interface ModelLoadProgress {
  status: 'downloading' | 'loading' | 'ready' | 'error';
  progress: number;  // 0-100
  downloadedMB: number;
  totalMB: number;
  modelId: string;
}

// --- Hardware Capabilities ---

export interface HardwareCapabilities {
  webgpu: boolean;
  webgpuAdapter?: string;
  wasm: boolean;
  simd: boolean;
  threads: boolean;
  estimatedCores: number;
  estimatedMemoryGB: number;
}

// --- Settings ---

export interface AheadSubSettings {
  spokenLanguage: string;      // 'auto' or ISO code
  subtitleLanguage: string;    // ISO code
  modelSize: WhisperModelSize;
  processingMode: ProcessingMode;
  aheadBufferSeconds: number;
  subtitleOffset: number;      // milliseconds
  maxCharsPerLine: number;
  maxLines: number;
  fontSize: number;
  fontColor: string;
  outlineColor: string;
  outlineWidth: number;
  subtitlePosition: 'bottom' | 'top';
  showOverlay: boolean;
  useWebGPU: boolean;
  translationMode: 'local' | 'cloud' | 'none';
  cloudApiKey?: string;
  cloudApiProvider?: 'google' | 'deepl';
  // Hover & bilingual translation
  hoverTranslationEnabled?: boolean;
  hoverTranslationLanguage?: string;
  translationDisplayMode?: 'word' | 'hover' | 'dual';
  autoPauseOnWordHover?: boolean;
}

export interface WordDefinition {
  word: string;
  translation: string;
  pos?: string;
  base?: string;
  terms?: string[];
}

// --- Cache Types ---

export interface CacheEntry {
  id: string;
  cacheKey: string;
  result: TranscriptionResult;
  mediaUrl: string;
  pageUrl: string;
  duration: number;
  spokenLanguage: string;
  subtitleLanguage: string;
  modelId: string;
  createdAt: number;
  accessedAt: number;
  sizeBytesEstimate: number;
}

export interface CacheKey {
  mediaUrl: string;
  pageUrl: string;
  duration: number;
  spokenLanguage: string;
  subtitleLanguage: string;
  modelId: string;
}

// --- Adapter Types ---

export interface SiteAdapter {
  name: string;
  priority: number;  // lower = tried first
  canHandle(url: string, doc?: Document): boolean;
  getMediaInfo(video: HTMLVideoElement, doc: Document): Promise<MediaInfo>;
  getAudioAccess(video: HTMLVideoElement, doc: Document): Promise<AudioAccessResult>;
}
