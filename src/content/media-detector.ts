// ============================================================
// AheadSub — Media Detector
// Detects HTML5 <video> elements on the page, including
// dynamically added videos and iframes (same-origin).
// ============================================================

import type { MediaInfo } from '../core/types';
import { AudioAccessMethod } from '../core/types';
import { MessageType } from '../core/messages';

export class MediaDetector {
  private observer: MutationObserver | null = null;
  private detectedVideos: Map<HTMLVideoElement, MediaInfo> = new Map();
  private onVideoFound: ((info: MediaInfo) => void) | null = null;
  private onVideoLost: ((video: HTMLVideoElement) => void) | null = null;
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private recentManifests: string[] = [];
  private messageListener: ((e: MessageEvent) => void) | null = null;
  private customEventListener: ((e: Event) => void) | null = null;

  start(
    onFound: (info: MediaInfo) => void,
    onLost: (video: HTMLVideoElement) => void
  ): void {
    this.onVideoFound = onFound;
    this.onVideoLost = onLost;

    const handleNewManifest = (manifestUrl: string) => {
      if (!manifestUrl) return;
      if (!this.recentManifests.includes(manifestUrl)) {
        this.recentManifests.push(manifestUrl);
        if (this.recentManifests.length > 10) {
          this.recentManifests.shift();
        }
      }

      // Attach manifest to all detected videos immediately
      for (const [, info] of this.detectedVideos.entries()) {
        info.manifestUrl = manifestUrl;
        info.audioAccessMethod = manifestUrl.includes('.mpd')
          ? AudioAccessMethod.DASH_MANIFEST
          : AudioAccessMethod.HLS_MANIFEST;
        this.onVideoFound?.(info);
      }

      // Forward to background service worker so it is stored tab-wide
      chrome.runtime.sendMessage({
        type: MessageType.MANIFEST_DETECTED,
        payload: { url: manifestUrl }
      }).catch(() => {});
    };

    // Listen for intercepted manifests & audio metadata from MAIN world (postMessage)
    this.messageListener = (event: MessageEvent) => {
      if (!event.data) return;
      if (event.data.type === 'AHEADSUB_MANIFEST_DETECTED' && event.data.url) {
        handleNewManifest(event.data.url);
      } else if (event.data.type === 'AHEADSUB_AUDIO_URL' && event.data.url) {
        const audioUrl = event.data.url;
        for (const [, info] of this.detectedVideos.entries()) {
          info.sourceUrl = audioUrl;
          info.audioAccessMethod = AudioAccessMethod.DIRECT_URL;
          this.onVideoFound?.(info);
        }
      } else if (event.data.type === 'AHEADSUB_YOUTUBE_METADATA' && event.data.payload) {
        const meta = event.data.payload;
        for (const [, info] of this.detectedVideos.entries()) {
          if (meta.title) info.title = meta.title;
          if (meta.duration && meta.duration > 0) info.duration = meta.duration;
          if (meta.audioUrl) {
            info.sourceUrl = meta.audioUrl;
            info.audioAccessMethod = AudioAccessMethod.DIRECT_URL;
          } else {
            info.audioAccessMethod = AudioAccessMethod.DIRECT_URL;
          }
          this.onVideoFound?.(info);
        }
      }
    };
    window.addEventListener('message', this.messageListener);

    // Fallback: listen for CustomEvent
    this.customEventListener = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && typeof detail === 'string') {
        handleNewManifest(detail);
      }
    };
    document.addEventListener('aheadsub_manifest', this.customEventListener);

    // Request any manifests already intercepted by MAIN world before this script loaded
    window.postMessage({ type: 'AHEADSUB_REQUEST_MANIFESTS' }, '*');

    // Initial scan
    this.scanForVideos(document);

    // Watch for DOM mutations
    this.observer = new MutationObserver((mutations) => {
      let shouldScan = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) {
            if (node.tagName === 'VIDEO' || node.querySelector('video') || node.tagName === 'IFRAME') {
              shouldScan = true;
              break;
            }
          }
        }
        for (const node of mutation.removedNodes) {
          if (node instanceof HTMLVideoElement) {
            this.handleVideoRemoved(node);
          }
        }
        if (shouldScan) break;
      }
      if (shouldScan) {
        this.scanForVideos(document);
      }
    });

    const observeTarget = document.documentElement || document.body || document;
    if (observeTarget) {
      this.observer.observe(observeTarget, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'currentSrc', 'data-src'],
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        this.scanForVideos(document);
      });
    }

    // Faster initial polling for dynamic video players and SPAs (YouTube, Netflix, Anime/Movie sites)
    let fastPollCount = 0;
    const fastPoll = () => {
      this.scanForVideos(document);
      fastPollCount++;
      if (fastPollCount < 10) {
        setTimeout(fastPoll, 800);
      }
    };
    setTimeout(fastPoll, 500);

    // Periodic rescan for dynamically loaded content
    this.scanInterval = setInterval(() => this.scanForVideos(document), 2500);
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.messageListener) {
      window.removeEventListener('message', this.messageListener);
      this.messageListener = null;
    }
    if (this.customEventListener) {
      document.removeEventListener('aheadsub_manifest', this.customEventListener);
      this.customEventListener = null;
    }
    this.detectedVideos.clear();
    this.recentManifests = [];
  }

  getRecentManifest(): string | null {
    if (this.recentManifests.length === 0) return null;
    return this.recentManifests[this.recentManifests.length - 1] ?? null;
  }

  getActiveVideo(): MediaInfo | null {
    // Always run a fresh active scan of the DOM and shadow roots
    this.scanForVideos(document);

    let best: MediaInfo | null = null;
    let bestScore = -1;

    for (const info of this.detectedVideos.values()) {
      const video = info.videoElement;
      if (!video) continue;
      // Clean up disconnected videos
      if (!video.isConnected) {
        this.detectedVideos.delete(video);
        continue;
      }
      const score = this.scoreVideo(video);
      if (score > bestScore) {
        bestScore = score;
        best = this.refreshMediaInfo(video, info);
      }
    }

    // Direct fallback search
    if (!best) {
      const direct = document.querySelector('video');
      if (direct) {
        this.handleVideoFound(direct, document);
        best = this.detectedVideos.get(direct) || null;
      }
    }

    return best;
  }

  getAllVideos(): MediaInfo[] {
    this.scanForVideos(document);
    return Array.from(this.detectedVideos.values()).map(info => {
      if (info.videoElement) {
        return this.refreshMediaInfo(info.videoElement, info);
      }
      return info;
    });
  }

  private scanForVideos(root: Document | ShadowRoot): void {
    if (!root) return;

    // 1. Find direct video elements in this root
    try {
      const videos = root.querySelectorAll('video');
      videos.forEach(video => this.handleVideoFound(video as HTMLVideoElement, root instanceof Document ? root : document));
    } catch {}

    // 2. Traverse into open Shadow DOM roots
    try {
      const allEls = root.querySelectorAll('*');
      for (let i = 0; i < allEls.length; i++) {
        const el = allEls[i]!;
        if (el.shadowRoot) {
          this.scanForVideos(el.shadowRoot);
        }
      }
    } catch {}

    // 3. Scan same-origin iframes
    if (root instanceof Document) {
      try {
        const iframes = root.querySelectorAll('iframe');
        iframes.forEach(iframe => {
          try {
            const iframeDoc = iframe.contentDocument;
            if (iframeDoc) {
              this.scanForVideos(iframeDoc);
            }
          } catch {
            // Cross-origin iframe
          }
        });
      } catch {}
    }
  }

  private handleVideoFound(video: HTMLVideoElement, doc: Document): void {
    const currentSrc = video.currentSrc || video.src || video.querySelector('source')?.src || video.querySelector('source')?.getAttribute('src') || '';
    const existing = this.detectedVideos.get(video);
    if (existing) {
      // Check if source or duration changed (e.g. Next Episode clicked, or metadata loaded)
      if ((currentSrc && currentSrc !== existing.sourceUrl) || ((video.duration || 0) > 0 && !existing.duration)) {
        const updated = this.refreshMediaInfo(video, { ...existing, sourceUrl: currentSrc || existing.sourceUrl, duration: video.duration || existing.duration });
        this.detectedVideos.set(video, updated);
        this.onVideoFound?.(updated);
      }
      return;
    }

    const info = this.buildMediaInfo(video, doc);
    this.detectedVideos.set(video, info);

    const updateInfo = () => {
      const current = this.detectedVideos.get(video) || info;
      const refreshed = this.refreshMediaInfo(video, current);
      this.detectedVideos.set(video, refreshed);
      this.onVideoFound?.(refreshed);
    };

    video.addEventListener('durationchange', updateInfo);
    video.addEventListener('loadedmetadata', updateInfo);
    video.addEventListener('loadstart', updateInfo);
    video.addEventListener('loadeddata', updateInfo);
    video.addEventListener('play', updateInfo);
    video.addEventListener('playing', updateInfo);
    video.addEventListener('timeupdate', updateInfo, { once: true });

    this.onVideoFound?.(info);
  }

  private handleVideoRemoved(video: HTMLVideoElement): void {
    if (this.detectedVideos.has(video)) {
      this.detectedVideos.delete(video);
      this.onVideoLost?.(video);
    }
  }

  private buildMediaInfo(video: HTMLVideoElement, doc: Document): MediaInfo {
    const sourceUrl = video.currentSrc || video.src || video.querySelector('source')?.src || video.querySelector('source')?.getAttribute('src') || '';
    const sourceType = this.classifySource(sourceUrl, video);
    let audioMethod = this.determineAudioAccess(sourceUrl, sourceType, video);
    let manifestUrl: string | undefined = undefined;

    // If it's a blob/MSE, check if we captured a manifest
    if (audioMethod === AudioAccessMethod.MSE_INTERCEPT && this.recentManifests.length > 0) {
      manifestUrl = this.recentManifests[this.recentManifests.length - 1]; // Use the most recent one
      if (manifestUrl.includes('.mpd')) {
        audioMethod = AudioAccessMethod.DASH_MANIFEST;
      } else {
        audioMethod = AudioAccessMethod.HLS_MANIFEST;
      }
    }

    return {
      videoElement: video,
      title: this.extractTitle(doc, video),
      duration: (video.duration && isFinite(video.duration)) ? video.duration : 0,
      currentTime: video.currentTime || 0,
      sourceUrl,
      sourceType,
      isPlaying: !video.paused && !video.ended,
      playbackRate: video.playbackRate || 1,
      dimensions: {
        width: video.videoWidth || video.offsetWidth || 1280,
        height: video.videoHeight || video.offsetHeight || 720,
      },
      audioAccessMethod: audioMethod,
      manifestUrl,
      pageUrl: doc.location?.href || window.location.href,
    };
  }

  private refreshMediaInfo(video: HTMLVideoElement, existing: MediaInfo): MediaInfo {
    const recentManifest = this.getRecentManifest();
    const manifestUrl = existing.manifestUrl || recentManifest || undefined;
    let audioAccessMethod = existing.audioAccessMethod;
    if (manifestUrl && audioAccessMethod !== AudioAccessMethod.DIRECT_URL) {
      audioAccessMethod = manifestUrl.includes('.mpd')
        ? AudioAccessMethod.DASH_MANIFEST
        : AudioAccessMethod.HLS_MANIFEST;
    }

    const currentSrc = video.currentSrc || video.src || video.querySelector('source')?.src || video.querySelector('source')?.getAttribute('src') || existing.sourceUrl || '';

    return {
      ...existing,
      sourceUrl: currentSrc,
      manifestUrl,
      audioAccessMethod,
      duration: (video.duration && isFinite(video.duration) && video.duration > 0) ? video.duration : existing.duration,
      currentTime: video.currentTime || 0,
      isPlaying: !video.paused && !video.ended,
      playbackRate: video.playbackRate || 1,
      dimensions: {
        width: video.videoWidth || video.offsetWidth || existing.dimensions.width,
        height: video.videoHeight || video.offsetHeight || existing.dimensions.height,
      },
    };
  }

  private classifySource(
    url: string,
    video: HTMLVideoElement
  ): 'direct' | 'blob' | 'mse' | 'unknown' {
    if (!url) return 'unknown';
    if (url.startsWith('blob:')) {
      // Check if MediaSource is being used
      if ((video as any).srcObject instanceof MediaSource) {
        return 'mse';
      }
      return 'blob';
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return 'direct';
    }
    return 'unknown';
  }

  private determineAudioAccess(
    url: string,
    sourceType: string,
    video: HTMLVideoElement
  ): AudioAccessMethod {
    const isYouTube = window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be');

    if (isYouTube) {
      // YouTube uses blob/MSE for video — captureStream is the reliable live path.
      // If we intercepted a real direct audio URL it will be updated later via AHEADSUB_AUDIO_URL.
      // Don't return DIRECT_URL here with a blob: url — the offscreen can't fetch that.
      if (url && url.startsWith('http') && (url.includes('googlevideo.com') || url.includes('videoplayback'))) {
        return AudioAccessMethod.DIRECT_URL;
      }
      return AudioAccessMethod.CAPTURE_STREAM;
    }

    if (sourceType === 'direct') {
      // Direct URL — might be fetchable
      try {
        const urlObj = new URL(url);
        if (urlObj.origin === window.location.origin) {
          return AudioAccessMethod.DIRECT_URL;
        }
        // Cross-origin — might work with CORS
        return AudioAccessMethod.DIRECT_URL;
      } catch {
        return AudioAccessMethod.CAPTURE_STREAM;
      }
    }

    if (sourceType === 'blob' || sourceType === 'mse') {
      if (typeof video.captureStream === 'function') {
        return AudioAccessMethod.CAPTURE_STREAM;
      }
      return AudioAccessMethod.MSE_INTERCEPT;
    }

    // Check if captureStream is available
    if (typeof video.captureStream === 'function') {
      return AudioAccessMethod.CAPTURE_STREAM;
    }

    return AudioAccessMethod.TAB_CAPTURE;
  }

  private extractTitle(doc: Document, video: HTMLVideoElement): string {
    if (window.location.hostname.includes('youtube.com') || window.location.hostname.includes('youtu.be')) {
      const ytTitle = doc.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim() ||
                      doc.querySelector('#title h1 yt-formatted-string')?.textContent?.trim() ||
                      doc.querySelector('h1.title yt-formatted-string')?.textContent?.trim();
      if (ytTitle) return ytTitle.replace(/\s*-\s*YouTube$/i, '');
    }

    // Try various sources for the video title
    const candidates: string[] = [];

    // Video element attributes
    if (video.title) candidates.push(video.title);
    const ariaLabel = video.getAttribute('aria-label');
    if (ariaLabel) candidates.push(ariaLabel);

    // Page title
    if (doc.title) candidates.push(doc.title);

    // Open Graph / Meta
    const ogTitle = doc.querySelector('meta[property="og:title"]');
    if (ogTitle) {
      const content = ogTitle.getAttribute('content');
      if (content) candidates.push(content);
    }

    // H1
    const h1 = doc.querySelector('h1');
    if (h1?.textContent) candidates.push(h1.textContent.trim());

    // Return the first non-empty candidate
    for (const c of candidates) {
      if (c && c.length > 2 && c.length < 200) return c;
    }

    return 'Untitled Video';
  }

  private scoreVideo(video: HTMLVideoElement): number {
    let score = 0;

    // Prefer larger videos
    const area = video.offsetWidth * video.offsetHeight;
    score += Math.log10(Math.max(area, 1)) * 10;

    // Prefer videos with duration
    if (video.duration && isFinite(video.duration)) score += 50;

    // Prefer videos that are playing
    if (!video.paused) score += 30;

    // Prefer visible videos
    const rect = video.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) score += 20;

    // Penalize muted videos
    if (video.muted) score -= 10;

    // Prefer videos with audio tracks
    if (video.audioTracks && video.audioTracks.length > 0) score += 20;

    return score;
  }
}
