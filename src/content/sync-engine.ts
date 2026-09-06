// ============================================================
// AheadSub — Synchronization Engine
// Maps videoTime ↔ audioTime ↔ transcriptionTime
// Handles seeking, rate changes, pauses, and manual offsets.
// ============================================================

export interface SyncState {
  videoTime: number;
  audioTime: number;
  transcriptionTime: number;
  playbackRate: number;
  isPlaying: boolean;
  offset: number;         // manual offset in ms
  driftCorrection: number; // auto-detected drift in ms
}

export interface SyncConfig {
  initialOffset: number;
  mediaStartOffset: number;  // if media doesn't start at 0
  driftThresholdMs: number;
  driftCorrectionRate: number;  // ms per second to correct
}

export class SyncEngine {
  private video: HTMLVideoElement | null = null;
  private state: SyncState;
  private config: SyncConfig;
  private listeners: Map<string, Set<(state: SyncState) => void>> = new Map();
  private driftSamples: number[] = [];
  private lastSyncTime: number = 0;

  constructor(config?: Partial<SyncConfig>) {
    this.config = {
      initialOffset: 0,
      mediaStartOffset: 0,
      driftThresholdMs: 200,
      driftCorrectionRate: 10,
      ...config,
    };

    this.state = {
      videoTime: 0,
      audioTime: 0,
      transcriptionTime: 0,
      playbackRate: 1,
      isPlaying: false,
      offset: this.config.initialOffset,
      driftCorrection: 0,
    };
  }

  attach(video: HTMLVideoElement): void {
    this.detach();
    this.video = video;

    video.addEventListener('timeupdate', this.handleTimeUpdate);
    video.addEventListener('seeking', this.handleSeeking);
    video.addEventListener('seeked', this.handleSeeked);
    video.addEventListener('ratechange', this.handleRateChange);
    video.addEventListener('play', this.handlePlay);
    video.addEventListener('pause', this.handlePause);
    video.addEventListener('waiting', this.handleWaiting);
    video.addEventListener('playing', this.handlePlaying);

    // Initial state
    this.updateState();
  }

  detach(): void {
    if (this.video) {
      this.video.removeEventListener('timeupdate', this.handleTimeUpdate);
      this.video.removeEventListener('seeking', this.handleSeeking);
      this.video.removeEventListener('seeked', this.handleSeeked);
      this.video.removeEventListener('ratechange', this.handleRateChange);
      this.video.removeEventListener('play', this.handlePlay);
      this.video.removeEventListener('pause', this.handlePause);
      this.video.removeEventListener('waiting', this.handleWaiting);
      this.video.removeEventListener('playing', this.handlePlaying);
      this.video = null;
    }
  }

  getState(): SyncState {
    return { ...this.state };
  }

  /**
   * Convert video time to the effective subtitle display time.
   * This is what the overlay should use to look up cues.
   */
  videoTimeToSubtitleTime(videoTime: number): number {
    const audioTime = videoTime - this.config.mediaStartOffset;
    const subtitleTime = audioTime + (this.state.offset / 1000) + (this.state.driftCorrection / 1000);
    return subtitleTime;
  }

  /**
   * Convert subtitle/transcription time back to video time.
   */
  subtitleTimeToVideoTime(subtitleTime: number): number {
    return subtitleTime + this.config.mediaStartOffset - (this.state.offset / 1000) - (this.state.driftCorrection / 1000);
  }

  setOffset(offsetMs: number): void {
    this.state.offset = offsetMs;
    this.emit('offset-changed', this.state);
  }

  getOffset(): number {
    return this.state.offset;
  }

  adjustOffset(deltaMs: number): void {
    this.setOffset(this.state.offset + deltaMs);
  }

  setMediaStartOffset(offsetSeconds: number): void {
    this.config.mediaStartOffset = offsetSeconds;
  }

  /**
   * Report observed drift between expected and actual subtitle timing.
   * Called when the user manually identifies a sync issue.
   */
  reportDrift(observedDriftMs: number): void {
    this.driftSamples.push(observedDriftMs);
    if (this.driftSamples.length > 10) {
      this.driftSamples.shift();
    }

    // Calculate average drift
    const avgDrift = this.driftSamples.reduce((a, b) => a + b, 0) / this.driftSamples.length;

    if (Math.abs(avgDrift) > this.config.driftThresholdMs) {
      this.state.driftCorrection = avgDrift;
      this.emit('drift-detected', this.state);
    }
  }

  on(event: string, callback: (state: SyncState) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: string, callback: (state: SyncState) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  // --- Event Handlers ---

  private handleTimeUpdate = (): void => {
    this.updateState();
    this.emit('timeupdate', this.state);
  };

  private handleSeeking = (): void => {
    this.updateState();
    this.emit('seeking', this.state);
  };

  private handleSeeked = (): void => {
    this.updateState();
    this.emit('seeked', this.state);
  };

  private handleRateChange = (): void => {
    if (this.video) {
      this.state.playbackRate = this.video.playbackRate;
    }
    this.emit('ratechange', this.state);
  };

  private handlePlay = (): void => {
    this.state.isPlaying = true;
    this.emit('play', this.state);
  };

  private handlePause = (): void => {
    this.state.isPlaying = false;
    this.emit('pause', this.state);
  };

  private handleWaiting = (): void => {
    this.emit('buffering', this.state);
  };

  private handlePlaying = (): void => {
    this.state.isPlaying = true;
    this.emit('playing', this.state);
  };

  private updateState(): void {
    if (!this.video) return;

    this.state.videoTime = this.video.currentTime;
    this.state.audioTime = this.video.currentTime - this.config.mediaStartOffset;
    this.state.transcriptionTime = this.videoTimeToSubtitleTime(this.video.currentTime);
    this.state.playbackRate = this.video.playbackRate;
    this.state.isPlaying = !this.video.paused && !this.video.ended;
  }

  private emit(event: string, state: SyncState): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      const snapshot = { ...state };
      for (const cb of callbacks) {
        try {
          cb(snapshot);
        } catch (e) {
          console.error(`[AheadSub] SyncEngine event handler error:`, e);
        }
      }
    }
  }
}
