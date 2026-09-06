// ============================================================
// AheadSub — Network & Player Interceptor
// Runs in the MAIN world at document_start.
// Intercepts fetch, XHR (requests & JSON responses), Hls.js,
// and media element source setters to capture HLS/DASH stream manifests.
// ============================================================

(function () {
  const capturedManifests = new Set<string>();

  function normalizeUrl(url: string): string | null {
    if (!url || typeof url !== 'string') return null;
    let trimmed = url.trim();
    if (trimmed.startsWith('//')) {
      trimmed = window.location.protocol + trimmed;
    }
    try {
      const urlObj = new URL(trimmed, window.location.href);
      return urlObj.href;
    } catch {
      return null;
    }
  }

  function isStreamUrl(urlStr: string): boolean {
    const lower = urlStr.toLowerCase();
    return (
      lower.includes('.m3u8') ||
      lower.includes('.mpd') ||
      lower.includes('/hls/') ||
      lower.includes(':hls:manifest') ||
      lower.includes('/playlist.') ||
      lower.includes('manifest.mpd')
    );
  }

  function isAudioStreamUrl(urlStr: string): boolean {
    const lower = urlStr.toLowerCase();
    return (
      (lower.includes('googlevideo.com/videoplayback') || lower.includes('/videoplayback')) &&
      (lower.includes('mime=audio') || lower.includes('itag=140') || lower.includes('itag=251') || lower.includes('itag=250') || lower.includes('itag=249'))
    ) || (
      lower.includes('.mp3') || lower.includes('.m4a') || lower.includes('.aac') || lower.includes('.opus')
    );
  }

  function broadcastManifest(rawUrl: string): void {
    const fullUrl = normalizeUrl(rawUrl);
    if (!fullUrl) return;

    if (!capturedManifests.has(fullUrl)) {
      capturedManifests.add(fullUrl);
      console.log('[AheadSub Intercept] Manifest captured:', fullUrl);
    }

    // Broadcast via window message to isolated world
    window.postMessage({
      type: 'AHEADSUB_MANIFEST_DETECTED',
      url: fullUrl
    }, '*');

    // Also dispatch document custom event as fallback
    try {
      document.dispatchEvent(new CustomEvent('aheadsub_manifest', { detail: fullUrl }));
    } catch {}
  }

  function broadcastAudioUrl(rawUrl: string): void {
    const fullUrl = normalizeUrl(rawUrl);
    if (!fullUrl) return;

    console.log('[AheadSub Intercept] Audio stream URL captured:', fullUrl);
    window.postMessage({
      type: 'AHEADSUB_AUDIO_URL',
      url: fullUrl
    }, '*');

    try {
      document.dispatchEvent(new CustomEvent('aheadsub_audio_url', { detail: fullUrl }));
    } catch {}
  }

  // --- YouTube In-Page Metadata & Native Caption Extractor ---
  function inspectYouTube(): void {
    if (!window.location.hostname.includes('youtube.com')) return;
    try {
      const player = document.getElementById('movie_player') as any;
      const playerResponse = (window as any).ytInitialPlayerResponse ||
                             player?.getPlayerResponse?.() ||
                             (window as any).yt?.config_?.PLAYER_VARS?.playerResponse;
      if (playerResponse) {
        const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        const adaptive = playerResponse.streamingData?.adaptiveFormats || [];
        // Pick best audio format: prefer opus (itag 251) > m4a (itag 140) > any audio
        const AUDIO_ITAGS = [251, 250, 249, 140, 139];
        let audioFormat: any = null;
        for (const itag of AUDIO_ITAGS) {
          audioFormat = adaptive.find((f: any) => f.itag === itag && f.url);
          if (audioFormat) break;
        }
        if (!audioFormat) {
          audioFormat = adaptive.find((f: any) => f.mimeType?.startsWith('audio/') && f.url);
        }
        const audioUrl = audioFormat?.url || null;

        window.postMessage({
          type: 'AHEADSUB_YOUTUBE_METADATA',
          payload: {
            captionTracks: tracks,
            audioUrl,
            title: playerResponse.videoDetails?.title || document.title,
            duration: Number(playerResponse.videoDetails?.lengthSeconds || 0),
            videoId: playerResponse.videoDetails?.videoId,
          }
        }, '*');

        // If we found a direct audio URL, broadcast it as a direct audio stream
        if (audioUrl) {
          window.postMessage({
            type: 'AHEADSUB_AUDIO_URL',
            url: audioUrl
          }, '*');
          try { document.dispatchEvent(new CustomEvent('aheadsub_audio_url', { detail: audioUrl })); } catch {}
        }
      }
    } catch {}
  }

  window.addEventListener('yt-navigate-finish', () => setTimeout(inspectYouTube, 600));
  window.addEventListener('load', () => setTimeout(inspectYouTube, 1000));
  setInterval(inspectYouTube, 3500);

  // Allow isolated world to trigger native caption fetch inside YouTube origin
  window.addEventListener('message', async (event) => {
    if (event.data?.type === 'AHEADSUB_REQUEST_YOUTUBE_CAPTIONS') {
      const lang = event.data.lang || 'en';
      const targetLang = event.data.targetLang;
      try {
        const player = document.getElementById('movie_player') as any;
        const playerResponse = (window as any).ytInitialPlayerResponse || player?.getPlayerResponse?.();
        const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

        let track = tracks.find((t: any) => t.languageCode === lang) ||
                    tracks.find((t: any) => t.languageCode === 'en' || t.vssId?.includes('.en')) ||
                    tracks[0];

        if (track && track.baseUrl) {
          let fetchUrl = track.baseUrl + '&fmt=vtt';
          if (targetLang && track.isTranslatable) {
            fetchUrl += `&tlang=${encodeURIComponent(targetLang)}`;
          }
          const res = await fetch(fetchUrl, { credentials: 'include' });
          if (res.ok) {
            const vtt = await res.text();
            if (vtt && vtt.includes('WEBVTT')) {
              window.postMessage({
                type: 'AHEADSUB_YOUTUBE_CAPTIONS_RESULT',
                success: true,
                vtt,
                lang: targetLang || track.languageCode
              }, '*');
              return;
            }
          }
        }
      } catch (err) {
        console.warn('[AheadSub Intercept] YouTube caption fetch error:', err);
      }
      window.postMessage({
        type: 'AHEADSUB_YOUTUBE_CAPTIONS_RESULT',
        success: false
      }, '*');
    }
  });

  function scanTextForManifests(text: string): void {
    if (!text || typeof text !== 'string') return;
    if (!text.includes('.m3u8') && !text.includes('.mpd') && !text.includes(':hls:manifest')) return;

    // Match full or protocol-relative URLs containing .m3u8 or :hls:manifest
    const urlMatches = text.match(/(?:https?:)?\/\/[^\s"'<>\\]+?(?:\.m3u8|:hls:manifest|\.mpd)[^\s"'<>\\]*/gi);
    if (urlMatches) {
      for (const m of urlMatches) {
        broadcastManifest(m);
      }
    }
  }

  // --- Handshake Listener (Replay captured manifests to content script) ---
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'AHEADSUB_REQUEST_MANIFESTS') {
      for (const url of capturedManifests) {
        window.postMessage({
          type: 'AHEADSUB_MANIFEST_DETECTED',
          url
        }, '*');
      }
    }
  });

  // --- 1. Hook Hls.js ---
  function hookHlsClass(HlsClass: any): void {
    if (!HlsClass || !HlsClass.prototype || HlsClass.__aheadsub_hooked) return;
    HlsClass.__aheadsub_hooked = true;
    const origLoadSource = HlsClass.prototype.loadSource;
    if (typeof origLoadSource === 'function') {
      HlsClass.prototype.loadSource = function (url: string) {
        if (url) broadcastManifest(url);
        return origLoadSource.apply(this, arguments as any);
      };
      console.log('[AheadSub Intercept] Hooked Hls.prototype.loadSource');
    }
  }

  if ((window as any).Hls) {
    hookHlsClass((window as any).Hls);
  } else {
    let currentHls = (window as any).Hls;
    try {
      Object.defineProperty(window, 'Hls', {
        configurable: true,
        enumerable: true,
        get() {
          return currentHls;
        },
        set(val) {
          currentHls = val;
          hookHlsClass(val);
        },
      });
    } catch {}
  }

  // Periodic poll for dynamically loaded Hls library
  let hlsPollCount = 0;
  const hlsPollInterval = setInterval(() => {
    hlsPollCount++;
    if ((window as any).Hls) {
      hookHlsClass((window as any).Hls);
      clearInterval(hlsPollInterval);
    } else if (hlsPollCount > 30) {
      clearInterval(hlsPollInterval);
    }
  }, 500);

  // --- 2. Hook Fetch ---
  const origFetch = window.fetch;
  window.fetch = async function (...args: any[]) {
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : (req instanceof Request ? req.url : req?.url);
      if (url && typeof url === 'string') {
        if (isStreamUrl(url)) {
          broadcastManifest(url);
        } else if (isAudioStreamUrl(url)) {
          broadcastAudioUrl(url);
        }
      }
    } catch (e) {
      console.warn('[AheadSub Intercept] Fetch URL inspect error:', e);
    }

    const response = await origFetch.apply(this, args as any);

    // Also inspect JSON/text responses (e.g. Kodik /ftor or /gHandler API)
    try {
      const clone = response.clone();
      clone.text().then((text) => {
        scanTextForManifests(text);
      }).catch(() => {});
    } catch {}

    return response;
  };

  // --- 3. Hook XMLHttpRequest ---
  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args: any[]) {
    try {
      const url = args[1];
      const urlStr = typeof url === 'string' ? url : url?.toString();
      if (urlStr) {
        if (isStreamUrl(urlStr)) {
          broadcastManifest(urlStr);
        } else if (isAudioStreamUrl(urlStr)) {
          broadcastAudioUrl(urlStr);
        }
      }
    } catch (e) {
      console.warn('[AheadSub Intercept] XHR open error:', e);
    }

    // Inspect response text when completed
    this.addEventListener('load', function () {
      try {
        if (typeof this.responseText === 'string') {
          scanTextForManifests(this.responseText);
        }
      } catch {}
    });

    return origOpen.apply(this, args as any);
  };

  // --- 4. Hook HTMLMediaElement.src Setter ---
  try {
    const originalSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    if (originalSrcDescriptor && originalSrcDescriptor.set) {
      const originalSet = originalSrcDescriptor.set;
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        set(val: string) {
          if (val && typeof val === 'string' && isStreamUrl(val)) {
            broadcastManifest(val);
          }
          return originalSet.call(this, val);
        },
        get() {
          return originalSrcDescriptor.get?.call(this);
        },
        configurable: true,
      });
    }
  } catch {}

  console.log('[AheadSub] Advanced network & player interceptor active in MAIN world.');
})();

