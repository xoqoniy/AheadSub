// ============================================================
// AheadSub — Generic HTML5 Adapter
// Handles standard HTML5 <video> elements on any page.
// Attempts various audio access strategies.
// ============================================================

import type { SiteAdapter } from './adapter-interface';
import type { MediaInfo, AudioAccessResult } from '../core/types';
import { AudioAccessMethod } from '../core/types';

export class GenericHTML5Adapter implements SiteAdapter {
  name = 'Generic HTML5';
  priority = 1000;

  canHandle(_url: string, _doc?: Document): boolean {
    // Generic adapter handles everything as fallback
    return true;
  }

  async getMediaInfo(video: HTMLVideoElement, doc: Document): Promise<MediaInfo> {
    const sourceUrl = video.currentSrc || video.src || '';
    const sourceType = this.classifySource(sourceUrl, video);

    return {
      videoElement: video,
      title: this.extractTitle(doc, video),
      duration: video.duration || 0,
      currentTime: video.currentTime,
      sourceUrl,
      sourceType,
      isPlaying: !video.paused && !video.ended,
      playbackRate: video.playbackRate,
      dimensions: {
        width: video.videoWidth || video.offsetWidth,
        height: video.videoHeight || video.offsetHeight,
      },
      audioAccessMethod: await this.determineAudioAccess(sourceUrl, sourceType, video),
      pageUrl: doc.location?.href || window.location.href,
    };
  }

  async getAudioAccess(video: HTMLVideoElement, doc: Document): Promise<AudioAccessResult> {
    const sourceUrl = video.currentSrc || video.src || '';
    const sourceType = this.classifySource(sourceUrl, video);

    // Strategy 1: Direct URL access
    if (sourceType === 'direct' && sourceUrl) {
      const canFetch = await this.testDirectAccess(sourceUrl);
      if (canFetch) {
        return {
          method: AudioAccessMethod.DIRECT_URL,
          url: sourceUrl,
          canPreGenerate: true,
          canBuffer: true,
        };
      }
    }

    // Strategy 2: Look for HLS/DASH manifests in page
    const manifestUrl = await this.discoverManifest(doc, video);
    if (manifestUrl) {
      const isHLS = manifestUrl.includes('.m3u8');
      return {
        method: isHLS ? AudioAccessMethod.HLS_MANIFEST : AudioAccessMethod.DASH_MANIFEST,
        manifestUrl,
        canPreGenerate: true,
        canBuffer: true,
      };
    }

    // Strategy 3: captureStream()
    if (typeof video.captureStream === 'function') {
      try {
        const stream = video.captureStream();
        if (stream.getAudioTracks().length > 0) {
          return {
            method: AudioAccessMethod.CAPTURE_STREAM,
            stream,
            canPreGenerate: false,
            canBuffer: true,
          };
        }
      } catch (e) {
        console.warn('[AheadSub] captureStream failed:', e);
      }
    }

    // Strategy 4: Tab capture (requires user gesture + extension permissions)
    return {
      method: AudioAccessMethod.TAB_CAPTURE,
      canPreGenerate: false,
      canBuffer: true,
      limitation: 'Only real-time or ahead-buffer modes available. The video source is not directly accessible.',
    };
  }

  // --- Private Helpers ---

  private classifySource(
    url: string,
    video: HTMLVideoElement
  ): 'direct' | 'blob' | 'mse' | 'unknown' {
    if (!url) return 'unknown';
    if (url.startsWith('blob:')) {
      return 'blob';
    }
    if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:')) {
      return 'direct';
    }
    return 'unknown';
  }

  private async determineAudioAccess(
    url: string,
    sourceType: string,
    video: HTMLVideoElement
  ): Promise<AudioAccessMethod> {
    if (sourceType === 'direct' && url) {
      const canFetch = await this.testDirectAccess(url);
      if (canFetch) return AudioAccessMethod.DIRECT_URL;
    }
    if (typeof video.captureStream === 'function') {
      return AudioAccessMethod.CAPTURE_STREAM;
    }
    return AudioAccessMethod.TAB_CAPTURE;
  }

  private async testDirectAccess(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        mode: 'cors',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async discoverManifest(doc: Document, video: HTMLVideoElement): Promise<string | null> {
    // Check <source> elements
    const sources = video.querySelectorAll('source');
    for (const source of sources) {
      const src = source.src || source.getAttribute('src') || '';
      if (src.includes('.m3u8') || src.includes('.mpd')) {
        return src;
      }
    }

    // Check for common global player variables
    try {
      const win = doc.defaultView || window;

      // Check common patterns: hls.js, video.js, shaka
      const hlsInstances = (win as any).__hls_instances ||
        (win as any).hls ||
        (video as any).hls;
      if (hlsInstances) {
        const url = hlsInstances.url || hlsInstances.config?.url;
        if (url) return url;
      }
    } catch {
      // Cross-origin or security restriction
    }

    // Check page source for manifest URLs (heuristic)
    try {
      const scripts = doc.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        const content = script.textContent || '';
        const m3u8Match = content.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/);
        if (m3u8Match) return m3u8Match[1]!;
        const mpdMatch = content.match(/(https?:\/\/[^\s"']+\.mpd[^\s"']*)/);
        if (mpdMatch) return mpdMatch[1]!;
      }
    } catch {
      // Security restriction
    }

    return null;
  }

  private extractTitle(doc: Document, video: HTMLVideoElement): string {
    if (video.title) return video.title;
    const ariaLabel = video.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (ogTitle) return ogTitle;
    if (doc.title) return doc.title;
    return 'Untitled Video';
  }
}
