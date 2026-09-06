// ============================================================
// AheadSub — Real-time Pipeline (Mode C)
// Fallback mode: captures and transcribes audio in real-time
// with minimal delay.
// ============================================================

import type { SubtitleCue, AheadSubSettings, PipelineProgress } from '../types';
import { PipelineState, ProcessingMode } from '../types';
import { WHISPER_SAMPLE_RATE } from '../constants';

export interface RealtimePipelineCallbacks {
  onProgress: (progress: PipelineProgress) => void;
  onCuesReady: (cues: SubtitleCue[]) => void;
  onError: (error: string) => void;
  transcribeChunk: (audioData: Float32Array, chunkIndex: number, startTime: number) => Promise<{
    cues: SubtitleCue[];
    detectedLanguage?: string;
    processingTimeMs: number;
  }>;
}

export class RealtimePipeline {
  private settings: AheadSubSettings;
  private callbacks: RealtimePipelineCallbacks;
  private aborted: boolean = false;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private audioBuffer: Float32Array[] = [];
  private chunkIndex: number = 0;
  private isProcessing: boolean = false;
  private processedDuration: number = 0;
  private cueCount: number = 0;

  // Collect 10 seconds of audio before processing
  private readonly REALTIME_CHUNK_S = 10;

  constructor(settings: AheadSubSettings, callbacks: RealtimePipelineCallbacks) {
    this.settings = settings;
    this.callbacks = callbacks;
  }

  async start(stream: MediaStream): Promise<void> {
    this.aborted = false;
    this.mediaStream = stream;

    try {
      this.audioContext = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
      this.sourceNode = this.audioContext.createMediaStreamSource(stream);

      // Use ScriptProcessorNode for audio capture
      // (AudioWorklet would be better but more complex to set up in extension context)
      const bufferSize = 4096;
      this.processor = this.audioContext.createScriptProcessor(bufferSize, 1, 1);

      let samplesCollected = 0;
      const targetSamples = this.REALTIME_CHUNK_S * WHISPER_SAMPLE_RATE;

      this.processor.onaudioprocess = (e) => {
        if (this.aborted) return;

        const inputData = e.inputBuffer.getChannelData(0);
        this.audioBuffer.push(new Float32Array(inputData));
        samplesCollected += inputData.length;

        if (samplesCollected >= targetSamples && !this.isProcessing) {
          this.processBuffer();
          samplesCollected = 0;
        }
      };

      this.sourceNode.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.callbacks.onProgress({
        state: PipelineState.TRANSCRIBING,
        mode: ProcessingMode.REALTIME,
        processedDuration: 0,
        totalDuration: 0,
        currentChunkStart: 0,
        currentChunkEnd: 0,
        cuesGenerated: 0,
        safePlaybackThrough: 0,
      });

    } catch (error) {
      this.callbacks.onError(`Real-time capture failed: ${error}`);
    }
  }

  stop(): void {
    this.aborted = true;

    this.processor?.disconnect();
    this.sourceNode?.disconnect();
    this.audioContext?.close();

    this.processor = null;
    this.sourceNode = null;
    this.audioContext = null;
    this.mediaStream = null;
    this.audioBuffer = [];
  }

  private async processBuffer(): Promise<void> {
    if (this.isProcessing || this.audioBuffer.length === 0) return;

    this.isProcessing = true;

    try {
      // Combine buffer chunks into single array
      const totalLength = this.audioBuffer.reduce((sum, arr) => sum + arr.length, 0);
      const combined = new Float32Array(totalLength);
      let offset = 0;
      for (const chunk of this.audioBuffer) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      this.audioBuffer = [];

      const startTime = this.processedDuration;

      // Transcribe
      const result = await this.callbacks.transcribeChunk(
        combined,
        this.chunkIndex,
        startTime
      );

      if (this.aborted) return;

      this.cueCount += result.cues.length;
      this.processedDuration += combined.length / WHISPER_SAMPLE_RATE;
      this.chunkIndex++;

      this.callbacks.onCuesReady(result.cues);

      this.callbacks.onProgress({
        state: PipelineState.TRANSCRIBING,
        mode: ProcessingMode.REALTIME,
        processedDuration: this.processedDuration,
        totalDuration: 0, // unknown in real-time mode
        currentChunkStart: startTime,
        currentChunkEnd: this.processedDuration,
        cuesGenerated: this.cueCount,
        safePlaybackThrough: startTime,
      });

    } catch (error) {
      this.callbacks.onError(`Real-time processing error: ${error}`);
    } finally {
      this.isProcessing = false;
    }
  }
}
