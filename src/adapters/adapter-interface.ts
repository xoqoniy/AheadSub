// ============================================================
// AheadSub — Site Adapter Interface
// Defines the contract all site-specific adapters must follow.
// ============================================================

import type { MediaInfo, AudioAccessResult } from '../core/types';

export interface SiteAdapter {
  /** Unique name for this adapter */
  name: string;

  /** Lower priority = tried first. Generic = 1000. */
  priority: number;

  /**
   * Check if this adapter can handle the given page.
   * Should be fast — no network requests.
   */
  canHandle(url: string, doc?: Document): boolean;

  /**
   * Extract detailed media information for the video.
   */
  getMediaInfo(video: HTMLVideoElement, doc: Document): Promise<MediaInfo>;

  /**
   * Determine and provide audio access for transcription.
   * Returns the best available method and any URLs/streams.
   */
  getAudioAccess(video: HTMLVideoElement, doc: Document): Promise<AudioAccessResult>;
}
