// ============================================================
// AheadSub — Extended DOM Type Declarations
// ============================================================

interface HTMLVideoElement {
  /** Capture the video's media stream (non-standard, supported in Chrome) */
  captureStream(frameRate?: number): MediaStream;

  /** Audio tracks of the video element */
  audioTracks: AudioTrackList;
}

interface AudioTrackList {
  readonly length: number;
  [index: number]: AudioTrack;
  getTrackById(id: string): AudioTrack | null;
}

interface AudioTrack {
  readonly id: string;
  kind: string;
  label: string;
  language: string;
  enabled: boolean;
}

interface HTMLCanvasElement {
  captureStream(frameRate?: number): MediaStream;
}

// Chrome Extension Offscreen API types augmentation
declare namespace chrome.offscreen {
  export enum Reason {
    WORKERS = 'WORKERS',
    AUDIO_PLAYBACK = 'AUDIO_PLAYBACK',
    USER_MEDIA = 'USER_MEDIA',
  }
}

declare namespace chrome.runtime {
  export enum ContextType {
    OFFSCREEN_DOCUMENT = 'OFFSCREEN_DOCUMENT',
  }
}
