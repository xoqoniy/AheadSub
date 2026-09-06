// ============================================================
// AheadSub — Buffer Pipeline (Mode B)
// Maintains a transcription buffer ahead of playback position.
// Continuously processes audio to stay ahead.
// ============================================================

import type { SubtitleCue, AheadSubSettings, PipelineProgress } from '../types';
import { PipelineState, ProcessingMode } from '../types';
import { WHISPER_SAMPLE_RATE, AUDIO_CHUNK_DURATION_S, AUDIO_CHUNK_OVERLAP_S } from '../constants';

export interface BufferPipelineCallbacks {
  onProgress: (progress: PipelineProgress) => void;
  onCuesReady: (cues: SubtitleCue[]) => void;
  onError: (error: string) => void;
  captureAudioChunk: (startTime: number, duration: number) => Promise<Float32Array | null>;
  transcribeChunk: (audioData: Float32Array, chunkIndex: number, startTime: number) => Promise<{
    cues: SubtitleCue[];
    detectedLanguage?: string;
    processingTimeMs: number;
  }>;
}

export class BufferPipeline {
  private settings: AheadSubSettings;
  private callbacks: BufferPipelineCallbacks;
  private aborted: boolean = false;
  private processedThrough: number = 0;
  private currentPlaybackTime: number = 0;
  private chunkIndex: number = 0;
  private allCues: SubtitleCue[] = [];
  private loopInterval: ReturnType<typeof setInterval> | null = null;
  private isProcessing: boolean = false;
  private totalDuration: number = 0;

  constructor(settings: AheadSubSettings, callbacks: BufferPipelineCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;
  }

  start(totalDuration: number): void {
    this.aborted = false;
    this.totalDuration = totalDuration;

    // Start the buffer loop
    this.loopInterval = setInterval(() => this.bufferLoop(), 1000);
    this.bufferLoop();
  }

  updatePlaybackTime(time: number): void {
    this.currentPlaybackTime = time;
  }

  stop(): void {
    this.aborted = true;
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
  }

  getProgress(): PipelineProgress {
    const aheadSeconds = this.processedThrough - this.currentPlaybackTime;
    return {
      state: this.isProcessing ? PipelineState.TRANSCRIBING : PipelineState.IDLE,
      mode: ProcessingMode.AHEAD_BUFFER,
      processedDuration: this.processedThrough,
      totalDuration: this.totalDuration,
      currentChunkStart: this.processedThrough,
      currentChunkEnd: this.processedThrough + AUDIO_CHUNK_DURATION_S,
      cuesGenerated: this.allCues.length,
      safePlaybackThrough: this.processedThrough,
      estimatedTimeRemaining: undefined,
    };
  }

  private async bufferLoop(): Promise<void> {
    if (this.aborted || this.isProcessing) return;

    const aheadTarget = this.settings.aheadBufferSeconds || 45;
    const aheadCurrent = this.processedThrough - this.currentPlaybackTime;

    // Only process if we're not far enough ahead
    if (aheadCurrent >= aheadTarget) return;

    // Don't process beyond total duration
    if (this.processedThrough >= this.totalDuration) return;

    this.isProcessing = true;

    try {
      // Capture the next chunk of audio
      const audioData = await this.callbacks.captureAudioChunk(
        this.processedThrough,
        AUDIO_CHUNK_DURATION_S
      );

      if (!audioData || this.aborted) {
        this.isProcessing = false;
        return;
      }

      // Transcribe
      const result = await this.callbacks.transcribeChunk(
        audioData,
        this.chunkIndex,
        this.processedThrough
      );

      if (this.aborted) {
        this.isProcessing = false;
        return;
      }

      // Store and emit cues
      this.allCues.push(...result.cues);
      this.callbacks.onCuesReady(result.cues);

      // Advance position
      this.processedThrough += AUDIO_CHUNK_DURATION_S - AUDIO_CHUNK_OVERLAP_S;
      this.chunkIndex++;

      // Report progress
      this.callbacks.onProgress(this.getProgress());
    } catch (error) {
      this.callbacks.onError(`Buffer processing error: ${error}`);
    } finally {
      this.isProcessing = false;
    }
  }
}
