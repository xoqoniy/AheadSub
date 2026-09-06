// ============================================================
// AheadSub — Ahead Pipeline (Mode A)
// Full pre-generation: extract all audio, transcribe everything
// before playback, generate complete VTT.
// ============================================================

import type {
  SubtitleCue,
  TranscriptionResult,
  AheadSubSettings,
  AudioAccessResult,
  PipelineProgress,
} from '../types';
import { PipelineState, ProcessingMode, AudioAccessMethod } from '../types';
import { TranscriptionEngine } from '../transcription/transcription-engine';
import { AudioExtractor } from '../audio/audio-extractor';
import { cacheResult, getCachedResult, generateCacheKey } from '../cache/subtitle-cache';
import type { CacheKey } from '../types';

export interface AheadPipelineCallbacks {
  onProgress: (progress: PipelineProgress) => void;
  onCuesReady: (cues: SubtitleCue[]) => void;
  onComplete: (result: TranscriptionResult) => void;
  onError: (error: string) => void;
  transcribeChunk: (audioData: Float32Array, chunkIndex: number, startTime: number) => Promise<{
    cues: SubtitleCue[];
    detectedLanguage?: string;
    processingTimeMs: number;
  }>;
}

export class AheadPipeline {
  private engine: TranscriptionEngine | null = null;
  private extractor: AudioExtractor;
  private settings: AheadSubSettings;
  private callbacks: AheadPipelineCallbacks;
  private aborted: boolean = false;

  constructor(settings: AheadSubSettings, callbacks: AheadPipelineCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;
    this.extractor = new AudioExtractor();
  }

  async run(
    audioAccess: AudioAccessResult,
    totalDuration: number,
    mediaUrl: string,
    pageUrl: string
  ): Promise<void> {
    this.aborted = false;

    // Check cache first
    const cacheKey: CacheKey = {
      mediaUrl,
      pageUrl,
      duration: totalDuration,
      spokenLanguage: this.settings.spokenLanguage,
      subtitleLanguage: this.settings.subtitleLanguage,
      modelId: this.settings.modelSize,
    };

    const cached = await getCachedResult(cacheKey);
    if (cached) {
      const progress: PipelineProgress = {
        state: PipelineState.CACHED,
        mode: ProcessingMode.FULL_PRE_GENERATION,
        processedDuration: totalDuration,
        totalDuration,
        currentChunkStart: 0,
        currentChunkEnd: totalDuration,
        cuesGenerated: cached.cues.length,
        safePlaybackThrough: totalDuration,
      };
      this.callbacks.onProgress(progress);
      this.callbacks.onCuesReady(cached.cues);
      this.callbacks.onComplete(cached);
      return;
    }

    // Initialize transcription engine
    this.engine = new TranscriptionEngine(
      totalDuration,
      ProcessingMode.FULL_PRE_GENERATION,
      {
        onProgress: this.callbacks.onProgress,
        onCuesReady: this.callbacks.onCuesReady,
        onComplete: async (allCues) => {
          const result: TranscriptionResult = {
            cues: allCues,
            language: this.settings.spokenLanguage,
            duration: totalDuration,
            modelId: this.settings.modelSize,
            processedAt: Date.now(),
            processingTimeMs: 0,
            mode: ProcessingMode.FULL_PRE_GENERATION,
          };

          // Cache the result
          await cacheResult(cacheKey, result);

          this.callbacks.onComplete(result);
        },
        onError: this.callbacks.onError,
      }
    );

    this.engine.start();

    // Extract and transcribe based on access method
    try {
      switch (audioAccess.method) {
        case AudioAccessMethod.DIRECT_URL:
          await this.processDirectURL(audioAccess.url!);
          break;

        case AudioAccessMethod.HLS_MANIFEST:
          await this.processHLS(audioAccess.manifestUrl!);
          break;

        case AudioAccessMethod.DASH_MANIFEST:
          await this.processDirectURL(audioAccess.manifestUrl!);
          break;

        default:
          throw new Error(
            `Mode A (full pre-generation) requires direct URL or HLS/DASH access. ` +
            `Current method: ${audioAccess.method}. ` +
            `Try ahead-buffer or real-time mode instead.`
          );
      }
    } catch (error) {
      if (!this.aborted) {
        this.engine.setError(String(error));
      }
    }
  }

  abort(): void {
    this.aborted = true;
  }

  private async processDirectURL(url: string): Promise<void> {
    await this.extractor.extractFromURL(
      url,
      async (chunk) => {
        if (this.aborted) return;
        const result = await this.callbacks.transcribeChunk(
          chunk.pcmData,
          chunk.chunkIndex,
          chunk.startTime
        );
        this.engine?.processChunkResult(
          chunk.chunkIndex,
          chunk.startTime,
          result.cues,
          chunk.endTime
        );
      },
      (loaded, total) => {
        // Could update a sub-progress for download
      }
    );
  }

  private async processHLS(manifestUrl: string): Promise<void> {
    await this.extractor.extractFromHLS(
      manifestUrl,
      async (chunk) => {
        if (this.aborted) return;
        const result = await this.callbacks.transcribeChunk(
          chunk.pcmData,
          chunk.chunkIndex,
          chunk.startTime
        );
        this.engine?.processChunkResult(
          chunk.chunkIndex,
          chunk.startTime,
          result.cues,
          chunk.endTime
        );
      },
      (segmentIndex, totalSegments) => {
        // Could update segment-level progress
      }
    );
  }

  destroy(): void {
    this.aborted = true;
    this.extractor.destroy();
  }
}
