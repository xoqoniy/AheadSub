// ============================================================
// AheadSub — Cross-Component Messaging
// ============================================================

import type {
  MediaInfo,
  PipelineProgress,
  SubtitleCue,
  TranscriptionResult,
  AheadSubSettings,
  AudioChunk,
  ModelLoadProgress,
  HardwareCapabilities,
  ProcessingMode,
} from './types';

// --- Message Types ---

export enum MessageType {
  // Popup → Background
  GET_VIDEO_INFO = 'get_video_info',
  START_GENERATION = 'start_generation',
  STOP_GENERATION = 'stop_generation',
  GET_PROGRESS = 'get_progress',
  EXPORT_VTT = 'export_vtt',
  EXPORT_SRT = 'export_srt',
  CLEAR_CACHE = 'clear_cache',
  GET_SETTINGS = 'get_settings',
  SAVE_SETTINGS = 'save_settings',
  GET_HARDWARE_INFO = 'get_hardware_info',
  LOAD_VTT_FILE = 'load_vtt_file',

  // Background → Content Script
  INJECT_SUBTITLES = 'inject_subtitles',
  UPDATE_SUBTITLES = 'update_subtitles',
  SHOW_OVERLAY = 'show_overlay',
  HIDE_OVERLAY = 'hide_overlay',
  SET_OFFSET = 'set_offset',
  DETECT_VIDEO = 'detect_video',
  START_PIPELINE = 'start_pipeline',

  // Content Script → Background
  VIDEO_DETECTED = 'video_detected',
  VIDEO_LOST = 'video_lost',
  VIDEO_TIME_UPDATE = 'video_time_update',
  AUDIO_CHUNK_READY = 'audio_chunk_ready',
  MANIFEST_DETECTED = 'manifest_detected',

  // Background → Offscreen
  OFFSCREEN_INIT = 'offscreen_init',
  OFFSCREEN_TRANSCRIBE_CHUNK = 'offscreen_transcribe_chunk',
  OFFSCREEN_LOAD_MODEL = 'offscreen_load_model',
  OFFSCREEN_DECODE_AUDIO = 'offscreen_decode_audio',
  OFFSCREEN_DETECT_HARDWARE = 'offscreen_detect_hardware',
  START_OFFSCREEN_PIPELINE = 'start_offscreen_pipeline',
  STOP_OFFSCREEN_PIPELINE = 'stop_offscreen_pipeline',

  // Offscreen → Background
  OFFSCREEN_TRANSCRIPTION_RESULT = 'offscreen_transcription_result',
  OFFSCREEN_MODEL_PROGRESS = 'offscreen_model_progress',
  OFFSCREEN_MODEL_READY = 'offscreen_model_ready',
  OFFSCREEN_AUDIO_DECODED = 'offscreen_audio_decoded',
  OFFSCREEN_HARDWARE_INFO = 'offscreen_hardware_info',
  OFFSCREEN_ERROR = 'offscreen_error',

  // Progress updates (broadcast)
  PIPELINE_PROGRESS = 'pipeline_progress',
  GENERATION_COMPLETE = 'generation_complete',
  GENERATION_ERROR = 'generation_error',

  // Translation & Navigation
  TRANSLATE_TEXT = 'translate_text',
  RESET_PIPELINE = 'reset_pipeline',
}

// --- Message Payloads ---

export interface GetVideoInfoResponse {
  found: boolean;
  info?: MediaInfo;
}

export interface StartGenerationPayload {
  tabId: number;
  settings: AheadSubSettings;
}

export interface InjectSubtitlesPayload {
  cues: SubtitleCue[];
  settings: AheadSubSettings;
}

export interface StartPipelinePayload {
  settings: AheadSubSettings;
}

export interface UpdateSubtitlesPayload {
  newCues: SubtitleCue[];
  processedThrough: number;
}

export interface TranscribeChunkPayload {
  audioData: ArrayBuffer;
  sampleRate: number;
  chunkIndex: number;
  chunkStartTime: number;
  language: string;
  modelId: string;
}

export interface TranscriptionResultPayload {
  chunkIndex: number;
  chunkStartTime: number;
  cues: SubtitleCue[];
  detectedLanguage?: string;
  processingTimeMs: number;
}

export interface DecodeAudioPayload {
  audioData: ArrayBuffer;
  targetSampleRate: number;
  startTime: number;
  chunkIndex: number;
}

export interface DecodedAudioPayload {
  pcmData: ArrayBuffer;  // Float32Array transferred
  sampleRate: number;
  duration: number;
  chunkIndex: number;
  startTime: number;
}

export interface ExportPayload {
  format: 'vtt' | 'srt';
  result: TranscriptionResult;
  filename: string;
}

export interface LoadVttPayload {
  vttContent: string;
  tabId: number;
}

// --- Generic Message Envelope ---

export interface ExtensionMessage<T = unknown> {
  type: MessageType;
  payload?: T;
  tabId?: number;
  error?: string;
}

// --- Helper Functions ---

export function createMessage<T>(
  type: MessageType,
  payload?: T,
  tabId?: number
): ExtensionMessage<T> {
  return { type, payload, tabId };
}

export function sendToBackground<T, R = unknown>(
  type: MessageType,
  payload?: T
): Promise<R> {
  return chrome.runtime.sendMessage(createMessage(type, payload));
}

export function sendToTab<T>(
  tabId: number,
  type: MessageType,
  payload?: T
): Promise<void> {
  return chrome.tabs.sendMessage(tabId, createMessage(type, payload, tabId));
}

export function sendToOffscreen<T>(
  type: MessageType,
  payload?: T
): Promise<void> {
  return chrome.runtime.sendMessage(createMessage(type, payload));
}
