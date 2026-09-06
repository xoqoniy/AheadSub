// ============================================================
// AheadSub — Transcription Engine
// Orchestrates the transcription pipeline: chunk scheduling,
// progress tracking, and cue building.
// ============================================================

import type { SubtitleCue, TranscriptionWord, PipelineProgress, AudioChunk } from '../types';
import { PipelineState, ProcessingMode } from '../types';
import { deduplicateOverlappingCues } from '../audio/audio-chunker';
import {
  MIN_CUE_DURATION_S,
  MAX_CUE_DURATION_S,
  MAX_CHARS_PER_SECOND,
  MIN_GAP_BETWEEN_CUES_S,
} from '../constants';

export interface TranscriptionEngineCallbacks {
  onProgress: (progress: PipelineProgress) => void;
  onCuesReady: (cues: SubtitleCue[]) => void;
  onComplete: (allCues: SubtitleCue[]) => void;
  onError: (error: string) => void;
}

export class TranscriptionEngine {
  private allCues: SubtitleCue[] = [];
  private progress: PipelineProgress;
  private callbacks: TranscriptionEngineCallbacks;
  private startTime: number = 0;

  constructor(
    totalDuration: number,
    mode: ProcessingMode,
    callbacks: TranscriptionEngineCallbacks
  ) {
    this.callbacks = callbacks;
    this.progress = {
      state: PipelineState.IDLE,
      mode,
      processedDuration: 0,
      totalDuration,
      currentChunkStart: 0,
      currentChunkEnd: 0,
      cuesGenerated: 0,
      safePlaybackThrough: 0,
    };
  }

  getProgress(): PipelineProgress {
    return { ...this.progress };
  }

  getAllCues(): SubtitleCue[] {
    return [...this.allCues];
  }

  start(): void {
    this.startTime = performance.now();
    this.progress.state = PipelineState.TRANSCRIBING;
    this.callbacks.onProgress(this.progress);
  }

  /**
   * Process a transcription result from a chunk.
   * Called when the worker returns results for a chunk.
   */
  processChunkResult(
    chunkIndex: number,
    chunkStartTime: number,
    cues: SubtitleCue[],
    chunkEndTime: number
  ): void {
    // Add new cues
    this.allCues.push(...cues);

    // Deduplicate overlapping cues
    this.allCues = deduplicateOverlappingCues(this.allCues);

    // Update progress
    this.progress.processedDuration = chunkEndTime;
    this.progress.currentChunkStart = chunkStartTime;
    this.progress.currentChunkEnd = chunkEndTime;
    this.progress.cuesGenerated = this.allCues.length;
    this.progress.safePlaybackThrough = chunkStartTime; // Safe through the start of completed chunk

    // Estimate time remaining
    const elapsed = (performance.now() - this.startTime) / 1000;
    const rate = this.progress.processedDuration / elapsed; // seconds of audio per second
    const remaining = this.progress.totalDuration - this.progress.processedDuration;
    this.progress.estimatedTimeRemaining = rate > 0 ? remaining / rate : undefined;

    this.callbacks.onProgress(this.progress);
    this.callbacks.onCuesReady(cues);

    // Check if complete
    if (chunkEndTime >= this.progress.totalDuration) {
      this.complete();
    }
  }

  /**
   * Mark the transcription as complete.
   */
  complete(): void {
    // Final deduplication and cleanup
    this.allCues = deduplicateOverlappingCues(this.allCues);
    this.allCues = this.postProcessCues(this.allCues);

    this.progress.state = PipelineState.COMPLETE;
    this.progress.processedDuration = this.progress.totalDuration;
    this.progress.safePlaybackThrough = this.progress.totalDuration;
    this.progress.cuesGenerated = this.allCues.length;

    this.callbacks.onProgress(this.progress);
    this.callbacks.onComplete(this.allCues);
  }

  /**
   * Post-process cues: enforce timing constraints, merge/split as needed.
   */
  private postProcessCues(cues: SubtitleCue[]): SubtitleCue[] {
    const processed: SubtitleCue[] = [];

    for (let i = 0; i < cues.length; i++) {
      const cue = { ...cues[i]! };

      // Enforce minimum duration
      if (cue.endTime - cue.startTime < MIN_CUE_DURATION_S) {
        cue.endTime = cue.startTime + MIN_CUE_DURATION_S;
      }

      // Enforce maximum duration
      if (cue.endTime - cue.startTime > MAX_CUE_DURATION_S) {
        cue.endTime = cue.startTime + MAX_CUE_DURATION_S;
      }

      // Enforce reading speed
      const duration = cue.endTime - cue.startTime;
      const charsPerSecond = cue.text.length / duration;
      if (charsPerSecond > MAX_CHARS_PER_SECOND && i + 1 < cues.length) {
        // Extend duration slightly
        const idealDuration = cue.text.length / MAX_CHARS_PER_SECOND;
        const maxEnd = cues[i + 1]!.startTime - MIN_GAP_BETWEEN_CUES_S;
        cue.endTime = Math.min(cue.startTime + idealDuration, maxEnd);
      }

      // Ensure no overlap with next cue
      if (i + 1 < cues.length) {
        const nextStart = cues[i + 1]!.startTime;
        if (cue.endTime > nextStart - MIN_GAP_BETWEEN_CUES_S) {
          cue.endTime = nextStart - MIN_GAP_BETWEEN_CUES_S;
        }
      }

      // Only add valid cues
      if (cue.endTime > cue.startTime && cue.text.trim()) {
        processed.push(cue);
      }
    }

    return processed;
  }

  setError(error: string): void {
    this.progress.state = PipelineState.ERROR;
    this.progress.error = error;
    this.callbacks.onError(error);
  }
}
