// ============================================================
// AheadSub — Kodik Adapter
// Handles Kodik player (used by AnimeLIB and similar sites).
// Kodik uses HLS streaming via blob: URLs and iframes.
// ============================================================

import type { SiteAdapter } from './adapter-interface';
import type { MediaInfo, AudioAccessResult } from '../core/types';
import { AudioAccessMethod } from '../core/types';

export class KodikAdapter implements SiteAdapter {
  name = 'Kodik Player';
  priority = 100;

  canHandle(url: string, doc?: Document): boolean {
    // Check URL patterns
    if (url.includes('kodik.info') || url.includes('kodik.cc') || url.includes('kodik.biz')) {
      return true;
    }

    // Check for Kodik iframe on the page
    if (doc) {
      const iframes = doc.querySelectorAll('iframe');
      for (const iframe of iframes) {
        const src = iframe.src || iframe.getAttribute('data-src') || '';
        if (src.includes('kodik.info') || src.includes('kodik.cc') || src.includes('kodik.biz')) {
          return true;
        }
      }

      // Check for AnimeLIB specific markers
      if (url.includes('animeli') || url.includes('anilib')) {
        return true;
      }
    }

    return false;
  }

  async getMediaInfo(video: HTMLVideoElement, doc: Document): Promise<MediaInfo> {
    const sourceUrl = video.currentSrc || video.src || '';

    return {
      videoElement: video,
      title: this.extractKodikTitle(doc),
      duration: video.duration || 0,
      currentTime: video.currentTime,
      sourceUrl,
      sourceType: sourceUrl.startsWith('blob:') ? 'blob' : 'direct',
      isPlaying: !video.paused && !video.ended,
      playbackRate: video.playbackRate,
      dimensions: {
        width: video.videoWidth || video.offsetWidth,
        height: video.videoHeight || video.offsetHeight,
      },
      audioAccessMethod: AudioAccessMethod.HLS_MANIFEST,
      pageUrl: doc.location?.href || window.location.href,
    };
  }

  async getAudioAccess(video: HTMLVideoElement, doc: Document): Promise<AudioAccessResult> {
    // Strategy 1: Find HLS manifest URL
    const manifestUrl = await this.discoverHLSManifest(doc, video);
    if (manifestUrl) {
      return {
        method: AudioAccessMethod.HLS_MANIFEST,
        manifestUrl,
        canPreGenerate: true,
        canBuffer: true,
      };
    }

    // Strategy 2: Try to access the Kodik iframe's content
    const iframeResult = await this.tryIframeAccess(doc);
    if (iframeResult) {
      return iframeResult;
    }

    // Strategy 3: captureStream fallback
    if (typeof video.captureStream === 'function') {
      try {
        const stream = video.captureStream();
        return {
          method: AudioAccessMethod.CAPTURE_STREAM,
          stream,
          canPreGenerate: false,
          canBuffer: true,
          limitation: 'Kodik player restricts direct media access. Using capture stream for ahead-buffer mode.',
        };
      } catch {
        // Fall through
      }
    }

    return {
      method: AudioAccessMethod.TAB_CAPTURE,
      canPreGenerate: false,
      canBuffer: false,
      limitation: 'Kodik player uses cross-origin iframe with restricted access. Only real-time mode available.',
    };
  }

  // --- Private Methods ---

  private async discoverHLSManifest(doc: Document, video: HTMLVideoElement): Promise<string | null> {
    // Method 1: Check for Kodik's HLS.js instance
    try {
      const win = doc.defaultView || window;

      // Kodik typically stores HLS player reference
      const kodikPlayer = (win as any).kodikPlayer ||
        (win as any).player ||
        (win as any).__player;
      if (kodikPlayer?.hls?.url) {
        return kodikPlayer.hls.url;
      }

      // Check for hls.js instances
      if ((win as any).Hls) {
        const hlsInstances = (win as any).__hls_instances;
        if (Array.isArray(hlsInstances) && hlsInstances.length > 0) {
          return hlsInstances[0].url || null;
        }
      }
    } catch {
      // Cross-origin restriction
    }

    // Method 2: Look through inline scripts for stream URLs
    try {
      const scripts = doc.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        const content = script.textContent || '';

        // Common Kodik patterns
        const patterns = [
          /["']([^"']+\.m3u8[^"']*)['"]/g,
          /src\s*[:=]\s*["']([^"']+\.m3u8[^"']*)['"]/g,
          /video_url\s*[:=]\s*["']([^"']+)['"]/g,
          /stream\s*[:=]\s*["']([^"']+)['"]/g,
        ];

        for (const pattern of patterns) {
          let match;
          while ((match = pattern.exec(content)) !== null) {
            const url = match[1];
            if (url && (url.includes('.m3u8') || url.includes('/video/'))) {
              return url;
            }
          }
        }
      }
    } catch {
      // Security restriction
    }

    // Method 3: Monitor network for manifest requests (requires webRequest)
    // This would be done from the background script using chrome.webRequest
    // For now, return null and let the background handle it
    return null;
  }

  private async tryIframeAccess(doc: Document): Promise<AudioAccessResult | null> {
    const iframes = doc.querySelectorAll('iframe');

    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (!src.includes('kodik')) continue;

      try {
        const iframeDoc = iframe.contentDocument;
        if (!iframeDoc) continue;

        // Found accessible Kodik iframe
        const video = iframeDoc.querySelector('video');
        if (video) {
          // Try to get the HLS manifest from inside the iframe
          const manifestUrl = await this.discoverHLSManifest(iframeDoc, video);
          if (manifestUrl) {
            return {
              method: AudioAccessMethod.HLS_MANIFEST,
              manifestUrl,
              canPreGenerate: true,
              canBuffer: true,
            };
          }

          // Try captureStream on the iframe's video
          if (typeof video.captureStream === 'function') {
            const stream = video.captureStream();
            return {
              method: AudioAccessMethod.CAPTURE_STREAM,
              stream,
              canPreGenerate: false,
              canBuffer: true,
            };
          }
        }
      } catch {
        // Cross-origin iframe — cannot access content
        console.log('[AheadSub Kodik] Cross-origin iframe, cannot access directly');
      }
    }

    return null;
  }

  private extractKodikTitle(doc: Document): string {
    // Try AnimeLIB/Kodik specific selectors
    const selectors = [
      '.anime-title',
      '.media-name',
      '.episode-title',
      'h1.title',
      '.player-title',
      'meta[property="og:title"]',
    ];

    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (el) {
        const text = el instanceof HTMLMetaElement
          ? el.getAttribute('content')
          : el.textContent;
        if (text?.trim()) return text.trim();
      }
    }

    return doc.title || 'Kodik Video';
  }
}
