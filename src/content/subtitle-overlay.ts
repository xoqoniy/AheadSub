// ============================================================
// AheadSub — Subtitle Overlay Renderer
// Custom DOM overlay that renders subtitles above the video.
// Supports interactive Word-by-Word Russian dictionary lookup,
// sentence hover tooltips, and dual bilingual subtitles.
// ============================================================

import type { SubtitleCue, AheadSubSettings } from '../core/types';
import {
  detectCollocations,
  INSTANT_UZBEK_WORDS,
  cleanToken,
  type DetectedPhrase,
} from '../core/collocations';

export class SubtitleOverlay {
  private container: HTMLDivElement | null = null;
  private textElement: HTMLDivElement | null = null;
  private primaryRowElement: HTMLDivElement | null = null;
  private primaryTextSpan: HTMLSpanElement | null = null;
  private toggleSentenceBtn: HTMLSpanElement | null = null;
  private dualElement: HTMLDivElement | null = null;
  private translationTooltip: HTMLDivElement | null = null;
  private wordTooltip: HTMLDivElement | null = null;
  private badgeElement: HTMLDivElement | null = null;
  private video: HTMLVideoElement | null = null;
  private cues: SubtitleCue[] = [];
  private activeCue: SubtitleCue | null = null;
  private animationFrameId: number | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private offset: number = 0; // milliseconds
  private isVisible: boolean = true;
  private settings: Partial<AheadSubSettings> = {};
  private translationCache: Map<string, string> = new Map();
  private wordCache: Map<string, any> = new Map();
  private phraseCache: Map<string, any> = new Map();
  private lastPrefetchedTime: number = -1;
  private isHovered: boolean = false;
  private isSentenceExpanded: boolean = false;
  private pausedByOverlay: boolean = false;
  private activeHoveredWord: string | null = null;
  // Tracks original text-track modes so we can restore them on detach
  private suppressedTracksData: Array<{ track: TextTrack; originalMode: TextTrackMode }> = [];

  attach(video: HTMLVideoElement, settings?: Partial<AheadSubSettings>): void {
    if (this.video === video && this.container?.isConnected) {
      if (settings) this.updateSettings(settings);
      return;
    }

    this.detach();

    // Clean up any stale or orphan overlays anywhere on the page
    document.querySelectorAll('#aheadsub-overlay, #aheadsub-badge').forEach((el) => el.remove());

    this.video = video;
    if (settings) this.settings = settings;

    // Suppress native video text tracks to prevent double subtitles
    this.suppressNativeSubtitles(video);

    this.createOverlay();
    this.startRendering();
    this.observeResize();
    this.observeFullscreen();
    this.bindVideoEvents();
  }

  detach(): void {
    this.stopRendering();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.pausedByOverlay && this.video?.paused) {
      this.video.play().catch(() => {});
      this.pausedByOverlay = false;
    }
    // Restore any native text tracks we suppressed
    this.restoreNativeSubtitles();
    this.container?.remove();
    this.container = null;
    this.textElement = null;
    this.primaryRowElement = null;
    this.primaryTextSpan = null;
    this.toggleSentenceBtn = null;
    this.dualElement = null;
    this.translationTooltip = null;
    this.wordTooltip = null;
    this.badgeElement?.remove();
    this.badgeElement = null;
    this.video = null;
    this.activeCue = null;
    document.removeEventListener('fullscreenchange', this.handleFullscreen);

    // Clean up any remaining aheadsub elements in the document
    document.querySelectorAll('#aheadsub-overlay, #aheadsub-badge').forEach((el) => el.remove());
  }

  isAttached(): boolean {
    return this.video !== null && this.container !== null && this.container.isConnected;
  }

  setCues(cues: SubtitleCue[]): void {
    this.cues = cues.sort((a, b) => a.startTime - b.startTime);
    this.updateBadge();
    const targetLang = this.settings.hoverTranslationLanguage || 'uz';
    const currentT = this.video?.currentTime || 0;
    this.prefetchLookahead(currentT, targetLang, true);
  }

  addCues(newCues: SubtitleCue[]): void {
    const existingIds = new Set(this.cues.map((c) => c.id));
    const uniqueNew = newCues.filter((c) => !existingIds.has(c.id));
    const combined = [...this.cues, ...uniqueNew].sort((a, b) => a.startTime - b.startTime);

    const deduplicated: SubtitleCue[] = [];
    for (const cue of combined) {
      const prev = deduplicated[deduplicated.length - 1];
      if (prev && Math.abs(prev.startTime - cue.startTime) < 0.3 && prev.text === cue.text) {
        continue;
      }
      deduplicated.push(cue);
    }

    this.cues = deduplicated;
    this.updateBadge();
    const targetLang = this.settings.hoverTranslationLanguage || 'uz';
    const currentT = this.video?.currentTime || 0;
    this.prefetchLookahead(currentT, targetLang, true);
  }

  setOffset(offsetMs: number): void {
    this.offset = offsetMs;
  }

  show(): void {
    this.isVisible = true;
    if (this.container) {
      this.container.style.display = 'block';
    }
    this.updateBadge();
  }

  hide(): void {
    this.isVisible = false;
    if (this.container) {
      this.container.style.display = 'none';
    }
    this.updateBadge();
  }

  updateSettings(settings: Partial<AheadSubSettings>): void {
    this.settings = { ...this.settings, ...settings };
    this.applyStyles();
    if (this.activeCue) {
      this.updateCueDisplay(this.activeCue);
    }
  }

  getCueCount(): number {
    return this.cues.length;
  }

  // --- Native Subtitle Suppression ---

  /**
   * Disable all native text tracks on the video element so they don't overlap
   * with AheadSub's own subtitle overlay. Stores their original modes for restoration.
   */
  private suppressNativeSubtitles(video: HTMLVideoElement): void {
    this.suppressedTracksData = [];
    try {
      const tracks = video.textTracks;
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]!;
        if (track.mode !== 'disabled') {
          this.suppressedTracksData.push({ track, originalMode: track.mode });
          track.mode = 'disabled';
        }
      }

      // Suppress <track> elements rendered by the site player
      video.querySelectorAll('track').forEach((t) => {
        (t as any).__aheadsub_kind = t.getAttribute('kind');
        t.setAttribute('kind', 'metadata');
      });

      // Inject strict global CSS to hide all site-native caption elements (YouTube, JWPlayer, VideoJS, etc.)
      let hideStyle = document.getElementById('aheadsub-hide-native-css') as HTMLStyleElement | null;
      if (!hideStyle) {
        hideStyle = document.createElement('style');
        hideStyle.id = 'aheadsub-hide-native-css';
        hideStyle.textContent = `
          .ytp-caption-window-container,
          .ytp-caption-window,
          .caption-window,
          .ytp-caption-segment,
          .jw-captions,
          .jw-text-track-container,
          .vjs-text-track-display,
          .plyr__captions,
          .dplayer-subtitles,
          video::cue,
          video::-webkit-media-text-track-container {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
          }
        `;
        (document.head || document.documentElement).appendChild(hideStyle);
      }

      // Watch for dynamically added tracks
      const observer = new MutationObserver(() => {
        const tl = video.textTracks;
        for (let i = 0; i < tl.length; i++) {
          const t = tl[i]!;
          if (t.mode !== 'disabled') {
            const alreadyTracked = this.suppressedTracksData.some((x) => x.track === t);
            if (!alreadyTracked) {
              this.suppressedTracksData.push({ track: t, originalMode: t.mode });
            }
            t.mode = 'disabled';
          }
        }
      });

      observer.observe(video, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
      (video as any).__aheadsub_track_observer = observer;
    } catch (e) {
      // Best-effort
    }
  }

  /**
   * Restore native text tracks to their original modes when AheadSub detaches.
   */
  private restoreNativeSubtitles(): void {
    try {
      const hideStyle = document.getElementById('aheadsub-hide-native-css');
      hideStyle?.remove();

      for (const { track, originalMode } of this.suppressedTracksData) {
        try { track.mode = originalMode; } catch {}
      }
      this.suppressedTracksData = [];

      if (this.video) {
        this.video.querySelectorAll('track[__aheadsub_kind]').forEach((t) => {
          const orig = (t as any).__aheadsub_kind;
          if (orig) t.setAttribute('kind', orig);
          delete (t as any).__aheadsub_kind;
        });

        const obs = (this.video as any).__aheadsub_track_observer as MutationObserver | undefined;
        if (obs) {
          obs.disconnect();
          delete (this.video as any).__aheadsub_track_observer;
        }
      }
    } catch (e) {}
  }

  // --- Private Overlay Creation ---

  private createOverlay(): void {
    if (!this.video) return;

    // Create container
    this.container = document.createElement('div');
    this.container.id = 'aheadsub-overlay';
    this.container.setAttribute('data-aheadsub', 'true');

    // Inject styles for word interactions + native subtitle suppression
    const styleEl = document.createElement('style');
    styleEl.id = 'aheadsub-styles';
    styleEl.textContent = `
      /* === Hide native player subtitle renderers to avoid double subtitles === */
      /* VideoJS */
      .vjs-text-track-display, .vjs-subtitles-menu-item, .vjs-captions-menu-item { display: none !important; }
      /* JWPlayer */
      .jw-text-track-display, .jw-captions, .jw-text-tracks { display: none !important; }
      /* Plyr */
      .plyr__captions, .plyr__caption { display: none !important; }
      /* Shaka Player */
      .shaka-text-container { display: none !important; }
      /* Browser native ::cue */
      video::cue { visibility: hidden !important; }
      /* Generic site-specific subtitle containers adjacent to video */
      .subtitle-container:not(#aheadsub-overlay), .subtitles-container:not(#aheadsub-overlay),
      .sub-container:not(#aheadsub-overlay), [class*="subtitle"]:not([data-aheadsub]) video + *,
      .player-subtitles:not(#aheadsub-overlay), .vilos-container, .vilos-controller,
      .caption-container:not(#aheadsub-overlay), [class*="caption"]:not([data-aheadsub]) {
        /* Only suppress if they are direct siblings/descendants of a video wrapper */
      }
      .aheadsub-word {
        display: inline-block;
        cursor: pointer;
        transition: color 0.12s ease, text-decoration 0.12s ease;
        border-radius: 3px;
        padding: 0 1px;
      }
      .aheadsub-word:hover {
        color: #67E8F9 !important;
        text-decoration: underline;
        text-decoration-color: #A855F7;
        text-underline-offset: 4px;
        text-decoration-thickness: 2px;
      }
      .aheadsub-phrase-active {
        color: #67E8F9 !important;
        background-color: rgba(168, 85, 247, 0.4) !important;
        border-bottom: 2px solid #C084FC !important;
        border-radius: 4px !important;
        box-shadow: 0 0 10px rgba(168, 85, 247, 0.5) !important;
      }
      #aheadsub-sentence-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-left: 10px;
        font-size: 0.72em;
        cursor: pointer;
        vertical-align: middle;
        opacity: 0.55;
        padding: 2px 6px;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.16);
        transition: all 0.18s ease;
        user-select: none;
      }
      #aheadsub-sentence-toggle:hover {
        opacity: 1;
        transform: scale(1.18);
        background: rgba(139, 92, 246, 0.3);
        border-color: rgba(168, 85, 247, 0.7);
        box-shadow: 0 0 10px rgba(168, 85, 247, 0.45);
      }
      #aheadsub-sentence-toggle.aheadsub-toggle-active {
        opacity: 1 !important;
        background: linear-gradient(135deg, rgba(139, 92, 246, 0.45), rgba(6, 182, 212, 0.45)) !important;
        border-color: #67E8F9 !important;
        color: #67E8F9 !important;
        box-shadow: 0 0 12px rgba(103, 232, 249, 0.55), inset 0 0 6px rgba(168, 85, 247, 0.3) !important;
        transform: scale(1.12);
      }
    `;
    this.container.appendChild(styleEl);

    // Create text element
    this.textElement = document.createElement('div');
    this.textElement.id = 'aheadsub-text';
    this.container.appendChild(this.textElement);

    // Primary row: wraps primaryTextSpan and toggleSentenceBtn inline on the same row
    this.primaryRowElement = document.createElement('div');
    this.primaryRowElement.id = 'aheadsub-primary-row';
    this.textElement.appendChild(this.primaryRowElement);

    // Primary text container for tokens
    this.primaryTextSpan = document.createElement('span');
    this.primaryTextSpan.id = 'aheadsub-primary-text';
    this.primaryRowElement.appendChild(this.primaryTextSpan);

    // Quick toggle for full sentence translation - placed inline right after subtitle text
    this.toggleSentenceBtn = document.createElement('span');
    this.toggleSentenceBtn.id = 'aheadsub-sentence-toggle';
    this.toggleSentenceBtn.innerHTML = '🌐';
    this.toggleSentenceBtn.title = "To'liq tarjimani ko'rsatish / Show full translation";
    this.toggleSentenceBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      this.isSentenceExpanded = !this.isSentenceExpanded;
      this.updateSentenceToggleDisplay();

      if (this.isSentenceExpanded && this.activeCue) {
        const targetLang = this.settings.hoverTranslationLanguage || 'uz';
        const cueText = this.activeCue.text.trim();
        const sKey = `${targetLang}:${cueText}`;
        if (this.translationCache.has(sKey)) {
          const cached = this.translationCache.get(sKey)!;
          if (cached && cached.trim().toLowerCase() !== cueText.toLowerCase()) {
            if (this.dualElement) {
              this.dualElement.textContent = cached;
            }
          } else {
            this.translationCache.delete(sKey);
            if (this.dualElement) {
              this.dualElement.textContent = targetLang === 'uz' ? 'Tarjima qilinmoqda...' : 'Translating...';
            }
            const trans = await this.requestTranslation(cueText, targetLang);
            if (this.dualElement && (!this.activeCue || this.activeCue.text.trim() === cueText)) {
              if (trans && trans.trim().toLowerCase() !== cueText.toLowerCase()) {
                this.dualElement.textContent = trans;
              } else {
                this.dualElement.textContent = '';
              }
            }
          }
        } else {
          if (this.dualElement && (!this.dualElement.textContent || this.dualElement.textContent === '')) {
            this.dualElement.textContent = targetLang === 'uz' ? 'Tarjima qilinmoqda...' : 'Translating...';
          }
          const trans = await this.requestTranslation(cueText, targetLang);
          if (this.dualElement && (!this.activeCue || this.activeCue.text.trim() === cueText)) {
            if (trans && trans.trim().toLowerCase() !== cueText.toLowerCase()) {
              this.dualElement.textContent = trans;
            } else {
              this.dualElement.textContent = '';
            }
          }
        }
      }
    });
    this.primaryRowElement.appendChild(this.toggleSentenceBtn);

    // Dual subtitle line
    this.dualElement = document.createElement('div');
    this.dualElement.id = 'aheadsub-dual-text';
    this.textElement.appendChild(this.dualElement);

    // Floating translation tooltip for sentence hover
    this.translationTooltip = document.createElement('div');
    this.translationTooltip.id = 'aheadsub-translation-tooltip';
    this.textElement.appendChild(this.translationTooltip);

    // Compact floating word dictionary card
    this.wordTooltip = document.createElement('div');
    this.wordTooltip.id = 'aheadsub-word-tooltip';
    this.container.appendChild(this.wordTooltip);

    // Whole sentence hover interactions (only active if mode === 'hover')
    this.textElement.addEventListener('mouseenter', () => {
      this.isHovered = true;
      if (
        this.settings.hoverTranslationEnabled !== false &&
        this.settings.translationDisplayMode === 'hover' &&
        this.translationTooltip?.textContent
      ) {
        this.translationTooltip.style.display = 'block';
        requestAnimationFrame(() => {
          if (this.translationTooltip) {
            this.translationTooltip.style.opacity = '1';
            this.translationTooltip.style.transform = 'translateX(-50%) translateY(-10px)';
          }
        });
      }
    });

    this.textElement.addEventListener('mouseleave', () => {
      this.isHovered = false;
      if (this.translationTooltip) {
        this.translationTooltip.style.opacity = '0';
        this.translationTooltip.style.transform = 'translateX(-50%) translateY(-4px)';
        setTimeout(() => {
          if (!this.isHovered && this.translationTooltip) {
            this.translationTooltip.style.display = 'none';
          }
        }, 180);
      }
    });

    // Create floating status badge
    this.badgeElement = document.createElement('div');
    this.badgeElement.id = 'aheadsub-badge';
    this.badgeElement.title = 'AheadSub Subtitles — Click to Toggle';
    Object.assign(this.badgeElement.style, {
      position: 'absolute',
      top: '12px',
      right: '12px',
      zIndex: '2147483647',
      backgroundColor: 'rgba(20, 15, 35, 0.85)',
      color: '#A78BFA',
      border: '1px solid rgba(139, 92, 246, 0.4)',
      padding: '4px 10px',
      borderRadius: '6px',
      fontSize: '12px',
      fontWeight: '600',
      fontFamily: '"Inter", -apple-system, sans-serif',
      cursor: 'pointer',
      pointerEvents: 'auto',
      userSelect: 'none',
      boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
      backdropFilter: 'blur(6px)',
      transition: 'opacity 0.2s ease, transform 0.1s ease',
    });

    this.badgeElement.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (this.isVisible) {
        this.hide();
      } else {
        this.show();
      }
    });

    // Apply styles
    this.applyStyles();
    this.insertIntoDOM();
    this.positionOverlay();
    this.updateBadge();
  }

  private insertIntoDOM(): void {
    if (!this.video || !this.container) return;
    if (this.container.isConnected) return;

    // Purge any duplicate or orphan aheadsub elements from DOM before inserting
    document.querySelectorAll('#aheadsub-overlay, #aheadsub-badge').forEach((el) => {
      if (el !== this.container && el !== this.badgeElement) {
        el.remove();
      }
    });

    const parent = this.video.parentElement;
    if (parent) {
      const parentPosition = getComputedStyle(parent).position;
      if (parentPosition === 'static') {
        parent.style.position = 'relative';
      }
      parent.appendChild(this.container);
      if (this.badgeElement) {
        parent.appendChild(this.badgeElement);
      }
    } else {
      document.body.appendChild(this.container);
      if (this.badgeElement) {
        document.body.appendChild(this.badgeElement);
      }
    }
  }

  private updateBadge(): void {
    if (!this.badgeElement) return;
    if (this.cues.length === 0) {
      this.badgeElement.style.display = 'none';
      return;
    }
    this.badgeElement.style.display = 'block';
    if (this.isVisible) {
      this.badgeElement.textContent = `AheadSub: ${this.cues.length} cues ✓`;
      this.badgeElement.style.color = '#A78BFA';
    } else {
      this.badgeElement.textContent = `AheadSub: Off ✗`;
      this.badgeElement.style.color = '#9CA3AF';
    }
  }

  private bindVideoEvents(): void {
    if (!this.video) return;

    const onPlayOrSeek = () => {
      if (this.container && !this.container.isConnected && this.video?.parentElement) {
        this.insertIntoDOM();
      }
      this.positionOverlay();
    };

    this.video.addEventListener('play', onPlayOrSeek);
    this.video.addEventListener('playing', onPlayOrSeek);
    this.video.addEventListener('seeked', onPlayOrSeek);
    this.video.addEventListener('loadeddata', onPlayOrSeek);
  }

  private applyStyles(): void {
    if (!this.container || !this.textElement) return;

    const fontSize = this.settings.fontSize || 28;
    const fontColor = this.settings.fontColor || '#FFFFFF';
    const outlineColor = this.settings.outlineColor || '#000000';
    const outlineWidth = this.settings.outlineWidth || 2;
    const position = this.settings.subtitlePosition || 'bottom';

    // Container styles — use height: 0 with overflow visible so the pill
    // sits exactly at the subtitle position without covering player controls
    Object.assign(this.container.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      [position]: '8%',
      [position === 'bottom' ? 'top' : 'bottom']: 'auto',
      height: '0',
      overflow: 'visible',
      zIndex: '2147483647',
      pointerEvents: 'none',
      display: this.isVisible ? 'block' : 'none',
      textAlign: 'center',
      padding: '0',
      boxSizing: 'border-box',
    });

    // Text styles - Tight Pill Wrapping ONLY the words
    const shadowSpread = outlineWidth;
    const textShadow = [
      `${shadowSpread}px ${shadowSpread}px 0 ${outlineColor}`,
      `-${shadowSpread}px -${shadowSpread}px 0 ${outlineColor}`,
      `${shadowSpread}px -${shadowSpread}px 0 ${outlineColor}`,
      `-${shadowSpread}px ${shadowSpread}px 0 ${outlineColor}`,
      `0 ${shadowSpread}px 0 ${outlineColor}`,
      `0 -${shadowSpread}px 0 ${outlineColor}`,
      `${shadowSpread}px 0 0 ${outlineColor}`,
      `-${shadowSpread}px 0 0 ${outlineColor}`,
    ].join(', ');

    Object.assign(this.textElement.style, {
      fontFamily: '"Inter", "Segoe UI", "Roboto", "Noto Sans", sans-serif',
      fontSize: `${fontSize}px`,
      fontWeight: '600',
      lineHeight: '1.35',
      color: fontColor,
      textShadow,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      display: this.activeCue ? 'inline-flex' : 'none',
      flexDirection: 'column',
      alignItems: 'center',
      width: 'fit-content',
      maxWidth: '90%',
      margin: '0 auto',
      padding: '5px 15px',
      borderRadius: '8px',
      backgroundColor: 'rgba(0, 0, 0, 0.74)',
      backdropFilter: 'blur(3px)',
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.65)',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      transition: 'opacity 0.12s ease-in-out',
      opacity: this.activeCue ? '1' : '0',
      userSelect: 'none',
      position: 'relative',
      pointerEvents: 'auto',
    });

    if (this.primaryRowElement) {
      Object.assign(this.primaryRowElement.style, {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexWrap: 'wrap',
        gap: '6px',
        width: '100%',
      });
    }

    if (this.toggleSentenceBtn) {
      const isDualActive = this.settings.translationDisplayMode === 'dual' || this.isSentenceExpanded;
      Object.assign(this.toggleSentenceBtn.style, {
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1px 6px',
        borderRadius: '5px',
        fontSize: '0.68em',
        lineHeight: '1.2',
        opacity: isDualActive ? '1' : '0.65',
        backgroundColor: isDualActive ? 'rgba(139, 92, 246, 0.4)' : 'rgba(255, 255, 255, 0.1)',
        border: isDualActive ? '1px solid rgba(168, 85, 247, 0.65)' : '1px solid rgba(255, 255, 255, 0.15)',
        transition: 'all 0.15s ease',
        userSelect: 'none',
        marginLeft: '4px',
        verticalAlign: 'middle',
      });
    }

    if (this.dualElement) {
      Object.assign(this.dualElement.style, {
        fontSize: '0.78em',
        color: '#67E8F9',
        fontWeight: '500',
        marginTop: '3px',
        lineHeight: '1.3',
        textShadow: '0 0 4px #000, 1px 1px 2px #000, -1px -1px 2px #000',
        backgroundColor: 'transparent',
        display: (this.settings.translationDisplayMode === 'dual' || this.isSentenceExpanded) ? 'block' : 'none',
      });
    }

    const videoWidth = this.video ? (this.video.videoWidth || this.video.clientWidth || 1280) : 1280;
    const sf = Math.max(0.9, Math.min(1.75, videoWidth / 1280));

    if (this.translationTooltip) {
      Object.assign(this.translationTooltip.style, {
        position: 'absolute',
        bottom: '100%',
        left: '50%',
        transform: 'translateX(-50%) translateY(-4px)',
        backgroundColor: 'rgba(15, 12, 30, 0.95)',
        color: '#67E8F9',
        border: '1px solid rgba(139, 92, 246, 0.55)',
        padding: `${Math.round(6 * sf)}px ${Math.round(14 * sf)}px`,
        borderRadius: `${Math.round(8 * sf)}px`,
        fontSize: `${Math.round(13 * sf)}px`,
        fontWeight: '500',
        lineHeight: '1.35',
        fontFamily: '"Inter", -apple-system, sans-serif',
        whiteSpace: 'pre-wrap',
        maxWidth: `${Math.round(520 * sf)}px`,
        minWidth: `${Math.round(140 * sf)}px`,
        textAlign: 'center',
        pointerEvents: 'none',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6), 0 0 12px rgba(139, 92, 246, 0.25)',
        backdropFilter: 'blur(10px)',
        opacity: '0',
        transition: 'opacity 0.18s ease, transform 0.18s ease',
        zIndex: '2147483647',
        display: 'none',
      });
    }

    if (this.wordTooltip) {
      Object.assign(this.wordTooltip.style, {
        position: 'absolute',
        backgroundColor: 'rgba(15, 12, 30, 0.97)',
        color: '#FFFFFF',
        border: '1px solid rgba(168, 85, 247, 0.65)',
        padding: `${Math.round(8 * sf)}px ${Math.round(13 * sf)}px`,
        borderRadius: `${Math.round(8 * sf)}px`,
        fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: `${Math.round(13 * sf)}px`,
        lineHeight: '1.35',
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.8), 0 0 16px rgba(108, 92, 231, 0.35)',
        backdropFilter: 'blur(12px)',
        zIndex: '2147483647',
        pointerEvents: 'none',
        whiteSpace: 'normal',
        maxWidth: `${Math.round(360 * sf)}px`,
        minWidth: `${Math.round(150 * sf)}px`,
        textAlign: 'left',
        display: 'none',
        transform: 'translateX(-50%)',
        transition: 'opacity 0.12s ease',
      });
    }
  }

  private positionOverlay(): void {
    if (!this.container || !this.video) return;

    const videoRect = this.video.getBoundingClientRect();
    const parent = this.container.parentElement;
    if (!parent) return;

    const parentRect = parent.getBoundingClientRect();
    const left = videoRect.left - parentRect.left;
    const width = videoRect.width > 0 ? `${videoRect.width}px` : '100%';

    Object.assign(this.container.style, {
      left: `${left}px`,
      width,
    });

    // Scale font size relative to video width
    const baseWidth = videoRect.width > 0 ? videoRect.width : window.innerWidth;
    const scaleFactor = Math.max(0.6, Math.min(1.4, baseWidth / 800));
    const baseFontSize = this.settings.fontSize || 28;
    if (this.textElement) {
      this.textElement.style.fontSize = `${Math.round(baseFontSize * scaleFactor)}px`;
    }
  }

  private observeResize(): void {
    if (!this.video) return;

    this.resizeObserver = new ResizeObserver(() => {
      this.positionOverlay();
    });

    this.resizeObserver.observe(this.video);
    if (this.video.parentElement) {
      this.resizeObserver.observe(this.video.parentElement);
    }
  }

  private handleFullscreen = (): void => {
    requestAnimationFrame(() => {
      this.positionOverlay();

      const fsElement = document.fullscreenElement;
      if (fsElement && this.container && !fsElement.contains(this.container)) {
        fsElement.appendChild(this.container);
        if (this.badgeElement) fsElement.appendChild(this.badgeElement);
        this.positionOverlay();
      } else if (!fsElement && this.container && this.video?.parentElement) {
        if (!this.video.parentElement.contains(this.container)) {
          this.insertIntoDOM();
          this.positionOverlay();
        }
      }
    });
  };

  private observeFullscreen(): void {
    document.addEventListener('fullscreenchange', this.handleFullscreen);
  }

  private startRendering(): void {
    const render = (): void => {
      if (!this.video || !this.textElement) return;

      if (this.container && !this.container.isConnected && this.video.parentElement) {
        this.insertIntoDOM();
        this.positionOverlay();
      }

      // If user is inspecting a word with autoPause, don't tick forward to next cue while paused
      if (!this.activeHoveredWord) {
        const currentTime = this.video.currentTime + this.offset / 1000;
        const newCue = this.findActiveCue(currentTime);

        if (newCue !== this.activeCue) {
          this.activeCue = newCue;

          if (newCue) {
            this.textElement.style.display = 'inline-flex';
            this.updateCueDisplay(newCue);
            this.textElement.style.opacity = '1';
          } else {
            this.textElement.style.opacity = '0';
            this.textElement.style.display = 'none';
            this.hideTooltips();
          }
        }

        // Prefetch ahead for smooth 0ms hover experience
        const targetLang = this.settings.hoverTranslationLanguage || 'uz';
        this.prefetchLookahead(currentTime, targetLang);
      }

      this.animationFrameId = requestAnimationFrame(render);
    };

    this.animationFrameId = requestAnimationFrame(render);
  }

  private hideTooltips(): void {
    if (this.translationTooltip) {
      this.translationTooltip.style.opacity = '0';
      this.translationTooltip.style.display = 'none';
    }
    if (this.wordTooltip) {
      this.wordTooltip.style.display = 'none';
    }
  }

  private updateSentenceToggleDisplay(): void {
    const isDualActive = this.isSentenceExpanded || this.settings.translationDisplayMode === 'dual';
    const isUzbek = (this.settings.hoverTranslationLanguage || 'uz') === 'uz';

    if (this.toggleSentenceBtn) {
      if (isDualActive) {
        this.toggleSentenceBtn.classList.add('aheadsub-toggle-active');
        this.toggleSentenceBtn.title = isUzbek
          ? "To'liq tarjimani yashirish (Bosish orqali yopish)"
          : "Hide full translation (Click to close)";
      } else {
        this.toggleSentenceBtn.classList.remove('aheadsub-toggle-active');
        this.toggleSentenceBtn.title = isUzbek
          ? "To'liq tarjimani ko'rsatish (Bosish orqali ochish)"
          : "Show full translation (Click to open)";
      }
    }

    if (this.dualElement) {
      this.dualElement.style.display = isDualActive ? 'block' : 'none';
    }
  }

  // --- Lookahead 0ms Instant Prefetching ---

  private prefetchLookahead(currentTime: number, targetLang: string, force: boolean = false): void {
    if (this.cues.length === 0) return;
    if (!force && Math.abs(currentTime - this.lastPrefetchedTime) < 4.0) return;
    this.lastPrefetchedTime = currentTime;

    // Locate current cue index
    let startIdx = 0;
    for (let i = 0; i < this.cues.length; i++) {
      if (this.cues[i]!.endTime >= currentTime) {
        startIdx = i;
        break;
      }
    }

    // Prefetch current cue + next 4 cues ahead of time (full sentences + collocations)
    const endIdx = Math.min(this.cues.length, startIdx + 5);

    for (let i = startIdx; i < endIdx; i++) {
      const cue = this.cues[i];
      if (!cue?.text) continue;

      // 1. FULL SENTENCE PREFETCH: guarantees 0ms display on cue start!
      const sKey = `${targetLang}:${cue.text.trim()}`;
      if (!this.translationCache.has(sKey)) {
        this.requestTranslation(cue.text, targetLang);
      }

      const words = cue.text.match(/[а-яА-ЯёЁa-zA-Z0-9]+(?:-[а-яА-ЯёЁa-zA-Z0-9]+)?/gu) || [];
      if (words.length === 0) continue;

      // 2. Collocations local cache populate (instant local 0ms)
      const phrases = detectCollocations(words);
      for (const p of phrases) {
        const pKey = `${targetLang}:${p.rawText.toLowerCase()}`;
        if (!this.phraseCache.has(pKey)) {
          if (targetLang === 'uz' && p.translationUz) {
            this.phraseCache.set(pKey, { translatedText: p.translationUz, isPhrase: true });
          } else if (targetLang === 'en' && p.translationEn) {
            this.phraseCache.set(pKey, { translatedText: p.translationEn, isPhrase: true });
          }
        }
      }

      // 3. Words local instant dictionary & prefetch
      for (const w of words) {
        const clean = cleanToken(w);
        if (clean.length > 1) {
          this.prefetchWordDefinition(clean, targetLang);
        }
      }
    }
  }

  // --- Cue & Word Tokenizer Rendering ---

  private async updateCueDisplay(cue: SubtitleCue): Promise<void> {
    if (!this.primaryTextSpan) {
      if (this.textElement) this.textElement.textContent = cue.text;
      return;
    }

    // Tokenize words & collocations for interactive learner dictionary
    this.renderWordTokens(cue.text);

    const translateEnabled = this.settings.hoverTranslationEnabled !== false;
    const targetLang = this.settings.hoverTranslationLanguage || 'uz';

    if (translateEnabled) {
      // Immediate local prefetch for this cue's words
      const words = cue.text.match(/[а-яА-ЯёЁa-zA-Z0-9]+(?:-[а-яА-ЯёЁa-zA-Z0-9]+)?/gu) || [];
      for (const w of words) {
        const clean = cleanToken(w);
        if (clean.length > 1) {
          this.prefetchWordDefinition(clean, targetLang);
        }
      }

      const sKey = `${targetLang}:${cue.text.trim()}`;
      const isDualActive = this.isSentenceExpanded || this.settings.translationDisplayMode === 'dual';

      // Frame 0 synchronous render from cache (0ms latency!)
      if (this.translationCache.has(sKey)) {
        const cached = this.translationCache.get(sKey)!;
        if (cached && cached.trim().toLowerCase() !== cue.text.trim().toLowerCase()) {
          if (this.dualElement) {
            this.dualElement.textContent = cached;
            this.updateSentenceToggleDisplay();
          }
          if (this.translationTooltip) {
            this.translationTooltip.textContent = cached;
            if (this.isHovered && this.settings.translationDisplayMode === 'hover') {
              this.translationTooltip.style.display = 'block';
              this.translationTooltip.style.opacity = '1';
              this.translationTooltip.style.transform = 'translateX(-50%) translateY(-10px)';
            }
          }
        } else {
          this.translationCache.delete(sKey);
        }
      } else {
        if (isDualActive && this.dualElement) {
          this.dualElement.textContent = targetLang === 'uz' ? 'Tarjima qilinmoqda...' : 'Translating...';
          this.updateSentenceToggleDisplay();
        }
        // Fetch and update
        this.requestTranslation(cue.text, targetLang).then((translated) => {
          if ((!this.activeCue || this.activeCue.text === cue.text) && translated && translated.trim().toLowerCase() !== cue.text.trim().toLowerCase()) {
            if (this.dualElement) {
              this.dualElement.textContent = translated;
              this.updateSentenceToggleDisplay();
            }
            if (this.translationTooltip) {
              this.translationTooltip.textContent = translated;
              if (this.isHovered && this.settings.translationDisplayMode === 'hover') {
                this.translationTooltip.style.display = 'block';
                this.translationTooltip.style.opacity = '1';
                this.translationTooltip.style.transform = 'translateX(-50%) translateY(-10px)';
              }
            }
          }
        });
      }
    } else {
      if (this.dualElement) this.dualElement.style.display = 'none';
      if (this.translationTooltip) this.translationTooltip.style.display = 'none';
    }
  }

  private prefetchWordDefinition(word: string, targetLang: string): void {
    const clean = cleanToken(word);
    if (!clean || clean.length <= 1) return;
    const cacheKey = `${targetLang}:${clean}`;
    if (this.wordCache.has(cacheKey)) return;

    if (targetLang === 'uz' && INSTANT_UZBEK_WORDS[clean]) {
      const instant = INSTANT_UZBEK_WORDS[clean]!;
      this.wordCache.set(cacheKey, {
        translatedText: instant.uz,
        dictEntries: [{ pos: instant.pos, terms: [], base: instant.base }],
      });
      return;
    }

    // Preload non-instant words in background so hover is instant
    chrome.runtime.sendMessage({
      type: 'translate_text',
      payload: {
        text: clean,
        targetLang,
        isWord: true,
        sourceLang: this.settings.spokenLanguage || 'ru',
      },
    }).then((response) => {
      if (response && response.translatedText) {
        this.wordCache.set(cacheKey, response);
      }
    }).catch(() => {});
  }

  private renderWordTokens(text: string): void {
    if (!this.primaryTextSpan) return;
    this.primaryTextSpan.innerHTML = '';

    // 1. Split text into raw tokens preserving Russian/Latin letters, digits, dashes, and punctuation
    const rawTokens = text.split(/([а-яА-ЯёЁa-zA-Z0-9]+(?:-[а-яА-ЯёЁa-zA-Z0-9]+)?)/u);

    // 2. Extract words and map their positions
    const wordTokens: { token: string; rawIndex: number }[] = [];
    for (let i = 0; i < rawTokens.length; i++) {
      const t = rawTokens[i];
      if (t && /[а-яА-ЯёЁa-zA-Z0-9]/u.test(t)) {
        wordTokens.push({ token: t, rawIndex: i });
      }
    }

    // 3. Detect collocations and multi-word idioms across the sentence
    const detectedPhrases = detectCollocations(wordTokens.map((w) => w.token));
    const wordIndexToPhrase = new Map<number, { phraseId: string; phrase: DetectedPhrase }>();

    detectedPhrases.forEach((phrase, pIdx) => {
      const phraseId = `phr_${pIdx}`;
      phrase.wordIndices.forEach((wIdx) => {
        wordIndexToPhrase.set(wIdx, { phraseId, phrase });
      });
    });

    // 4. Render DOM spans
    let wordCounter = 0;
    for (let i = 0; i < rawTokens.length; i++) {
      const token = rawTokens[i];
      if (!token) continue;

      if (/[а-яА-ЯёЁa-zA-Z0-9]/u.test(token)) {
        const span = document.createElement('span');
        span.className = 'aheadsub-word';
        span.textContent = token;
        span.setAttribute('data-word', token);

        const phraseInfo = wordIndexToPhrase.get(wordCounter);
        if (phraseInfo) {
          span.setAttribute('data-phrase-id', phraseInfo.phraseId);
          span.setAttribute('data-phrase-text', phraseInfo.phrase.phraseText);
        }

        span.addEventListener('mouseenter', () =>
          this.onWordMouseEnter(token, span, phraseInfo?.phrase, phraseInfo?.phraseId)
        );
        span.addEventListener('mouseleave', () => this.onWordMouseLeave(span));

        this.primaryTextSpan.appendChild(span);
        wordCounter++;
      } else {
        this.primaryTextSpan.appendChild(document.createTextNode(token));
      }
    }
  }

  // --- Word-by-Word Learner Interactions ---

  private async onWordMouseEnter(
    word: string,
    span: HTMLElement,
    phraseInfo?: DetectedPhrase,
    phraseId?: string
  ): Promise<void> {
    const isWordMode = this.settings.translationDisplayMode === 'word' || !this.settings.translationDisplayMode;
    if (!isWordMode && this.settings.translationDisplayMode !== 'dual') {
      return; // If mode is 'hover', whole sentence tooltip handles hover instead
    }

    if (this.settings.hoverTranslationEnabled === false) return;

    this.activeHoveredWord = word;

    // Auto-pause video while inspecting word
    if (this.settings.autoPauseOnWordHover !== false && this.video && !this.video.paused) {
      this.video.pause();
      this.pausedByOverlay = true;
    }

    // Simultaneously highlight all words in this phrase
    if (phraseId && this.textElement) {
      this.textElement
        .querySelectorAll(`[data-phrase-id="${phraseId}"]`)
        .forEach((el) => el.classList.add('aheadsub-phrase-active'));
    }

    if (!this.wordTooltip || !this.container) return;

    // Position dictionary tooltip right above the hovered word, bounded within container
    const spanRect = span.getBoundingClientRect();
    const contRect = this.container.getBoundingClientRect();
    let left = spanRect.left - contRect.left + spanRect.width / 2;
    const minLeft = 140;
    const maxLeft = Math.max(minLeft, contRect.width - 140);
    left = Math.max(minLeft, Math.min(maxLeft, left));
    const bottom = contRect.bottom - spanRect.top + 8;

    this.wordTooltip.style.left = `${Math.round(left)}px`;
    this.wordTooltip.style.bottom = `${Math.round(bottom)}px`;
    this.wordTooltip.style.display = 'block';

    const cleanWord = cleanToken(word);
    const targetLang = this.settings.hoverTranslationLanguage || 'uz';

    // A. COLLOCATION / PHRASE HOVER
    if (phraseInfo) {
      const phraseKey = `${targetLang}:${phraseInfo.rawText.toLowerCase()}`;
      let phraseTranslation = phraseInfo.translationUz || '';
      if (targetLang !== 'uz' && phraseInfo.translationEn) {
        phraseTranslation = phraseInfo.translationEn;
      }

      if (this.phraseCache.has(phraseKey)) {
        phraseTranslation = this.phraseCache.get(phraseKey).translatedText || phraseTranslation;
      }

      const wordKey = `${targetLang}:${cleanWord}`;
      let wordTranslation = INSTANT_UZBEK_WORDS[cleanWord]?.uz || '';
      if (this.wordCache.has(wordKey)) {
        wordTranslation = this.wordCache.get(wordKey).translatedText || wordTranslation;
      }

      this.renderPhraseCard(phraseInfo, phraseTranslation, word, wordTranslation);

      if (!phraseTranslation || !wordTranslation) {
        this.fetchPhraseAndWordAsync(phraseInfo, cleanWord, targetLang, phraseKey, wordKey, word);
      }
      return;
    }

    // B. SINGLE WORD HOVER
    const cacheKey = `${targetLang}:${cleanWord}`;

    // Instant render from instant dictionary or cache if available
    if (targetLang === 'uz' && INSTANT_UZBEK_WORDS[cleanWord]) {
      const instant = INSTANT_UZBEK_WORDS[cleanWord]!;
      this.renderWordCard(word, {
        translatedText: instant.uz,
        dictEntries: [{ pos: instant.pos || '', terms: [], base: instant.base || cleanWord }],
      });
      return;
    }

    if (this.wordCache.has(cacheKey)) {
      this.renderWordCard(word, this.wordCache.get(cacheKey));
      return;
    }

    // Show sleek loading state
    this.wordTooltip.innerHTML = `
      <div style="font-size:11px; color:#C4B5FD; display:flex; align-items:center; gap:6px;">
        <span style="display:inline-block; animation:spin 1s linear infinite;">⏳</span>
        <span>${targetLang === 'uz' ? `"${word}" qidirilmoqda...` : `Looking up "${word}"...`}</span>
      </div>
    `;

    // Fetch rich dictionary definition from background worker
    try {
      const response: any = await chrome.runtime.sendMessage({
        type: 'translate_text',
        payload: {
          text: cleanWord,
          targetLang,
          isWord: true,
          sourceLang: this.settings.spokenLanguage || 'ru',
        },
      });

      if (response && response.translatedText) {
        this.wordCache.set(cacheKey, response);
        if (this.activeHoveredWord === word) {
          this.renderWordCard(word, response);
        }
      } else {
        if (this.activeHoveredWord === word) {
          this.wordTooltip.innerHTML = `<span style="font-size:11px; color:#94A3B8;">${targetLang === 'uz' ? 'Tarjima topilmadi' : 'No definition found'}</span>`;
        }
      }
    } catch {
      if (this.activeHoveredWord === word) {
        this.wordTooltip.innerHTML = `<span style="font-size:11px; color:#94A3B8;">${targetLang === 'uz' ? 'Tarjima xizmati band' : 'Lookup unavailable'}</span>`;
      }
    }
  }

  private renderPhraseCard(
    phraseInfo: DetectedPhrase,
    phraseTranslation: string,
    hoveredWord: string,
    hoveredWordTranslation?: string
  ): void {
    if (!this.wordTooltip) return;

    const count = phraseInfo.wordIndices.length;
    const isUzbek = this.settings.hoverTranslationLanguage === 'uz' || !this.settings.hoverTranslationLanguage;
    const badgeLabel = isUzbek ? "🔗 SO'Z BIRIKMASI / IBORA" : '🔗 COLLOCATION / PHRASE';
    const countBadge = count > 1 ? (isUzbek ? `[${count} so'z birga]` : `[${count} words together]`) : '';

    this.wordTooltip.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:4px;">
        <span style="font-size:0.75em; font-weight:700; text-transform:uppercase; background:linear-gradient(135deg, #8B5CF6, #EC4899); color:#FFFFFF; padding:2px 7px; border-radius:4px; letter-spacing:0.3px; box-shadow:0 2px 6px rgba(139,92,246,0.3);">
          ${badgeLabel}
        </span>
        ${countBadge ? `<span style="font-size:0.75em; color:#A78BFA; font-weight:600;">${countBadge}</span>` : ''}
      </div>
      <div style="font-size:1.08em; font-weight:700; color:#FFFFFF; line-height:1.25; margin-bottom:3px; word-break:break-word;">
        ${phraseInfo.phraseText}
      </div>
      <div style="font-size:1.02em; font-weight:600; color:#67E8F9; line-height:1.3; margin-bottom:5px; word-break:break-word;">
        ${phraseTranslation || (isUzbek ? 'Tarjima qilinmoqda...' : 'Translating...')}
      </div>
      ${hoveredWord ? `
        <div style="border-top:1px solid rgba(139,92,246,0.25); padding-top:4px; margin-top:3px; font-size:0.85em; color:#94A3B8; display:flex; align-items:center; justify-content:space-between; gap:6px; word-break:break-word;">
          <span>${isUzbek ? 'Siz tanlagan so‘z' : 'Selected word'}: <b style="color:#FDE047;">${hoveredWord}</b></span>
          ${hoveredWordTranslation ? `<span style="color:#CBD5E1; font-style:italic;">→ ${hoveredWordTranslation}</span>` : ''}
        </div>
      ` : ''}
    `;
  }

  private async fetchPhraseAndWordAsync(
    phraseInfo: DetectedPhrase,
    cleanWord: string,
    targetLang: string,
    phraseKey: string,
    wordKey: string,
    originalWord: string
  ): Promise<void> {
    try {
      const [phraseRes, wordRes]: [any, any] = await Promise.all([
        !this.phraseCache.has(phraseKey)
          ? chrome.runtime.sendMessage({
              type: 'translate_text',
              payload: {
                text: phraseInfo.phraseText,
                targetLang,
                isWord: true,
                sourceLang: this.settings.spokenLanguage || 'ru',
              },
            }).catch(() => null)
          : null,
        !this.wordCache.has(wordKey)
          ? chrome.runtime.sendMessage({
              type: 'translate_text',
              payload: {
                text: cleanWord,
                targetLang,
                isWord: true,
                sourceLang: this.settings.spokenLanguage || 'ru',
              },
            }).catch(() => null)
          : null,
      ]);

      if (phraseRes?.translatedText) {
        this.phraseCache.set(phraseKey, phraseRes);
      }
      if (wordRes?.translatedText) {
        this.wordCache.set(wordKey, wordRes);
      }

      if (this.activeHoveredWord === originalWord) {
        const updatedPhraseTrans = this.phraseCache.get(phraseKey)?.translatedText || phraseInfo.translationUz || '';
        const updatedWordTrans = this.wordCache.get(wordKey)?.translatedText || INSTANT_UZBEK_WORDS[cleanWord]?.uz || '';
        this.renderPhraseCard(phraseInfo, updatedPhraseTrans, originalWord, updatedWordTrans);
      }
    } catch {}
  }

  private renderWordCard(word: string, def: any): void {
    if (!this.wordTooltip) return;

    const primaryEntry = def.dictEntries && def.dictEntries.length > 0 ? def.dictEntries[0] : null;
    const pos = primaryEntry?.pos || '';
    const base = primaryEntry?.base || '';
    const terms = primaryEntry?.terms || [];
    const translation = def.translatedText || '—';

    // Proper name / character name detection: ONLY if the dictionary explicitly marks it as NAME or PROPN
    const isName = pos === 'NAME' || pos === 'PROPN';

    const isUzbek = this.settings.hoverTranslationLanguage === 'uz' || !this.settings.hoverTranslationLanguage;

    const posUzMap: Record<string, string> = {
      NOUN: 'OT',
      VERB: "FE'L",
      ADJ: 'SIFAT',
      ADV: 'RAVISH',
      PRON: 'OLMOSH',
      PREP: 'PREDLOG',
      CONJ: 'BOG‘LOVCHI',
      PART: 'YUKLAMA',
      INTJ: 'UNDOV',
      NUM: 'SON',
      NAME: 'ISM / NOM',
      PROPN: 'ATOQLI NOM',
    };

    const posDisplay = isName
      ? (isUzbek ? '👤 ATOQLI NOM' : '👤 PROPER NAME')
      : (isUzbek ? (posUzMap[pos] || pos) : pos);

    this.wordTooltip.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:4px;">
        <span style="font-weight:700; color:#FFFFFF; font-size:1.05em; letter-spacing:-0.2px;">${word}</span>
        ${isName ? `
          <span style="font-size:0.75em; font-weight:700; text-transform:uppercase; background:rgba(59,130,246,0.35); color:#93C5FD; padding:2px 6px; border-radius:3px; border:1px solid rgba(59,130,246,0.5);">${posDisplay}</span>
        ` : (pos ? `
          <span style="font-size:0.75em; font-weight:600; text-transform:uppercase; background:rgba(139,92,246,0.35); color:#D8B4FE; padding:2px 6px; border-radius:3px; border:1px solid rgba(139,92,246,0.5);">${posDisplay}</span>
        ` : '')}
      </div>
      ${base && base.toLowerCase() !== word.toLowerCase() ? `<div style="font-size:0.85em; color:#94A3B8; margin-bottom:3px; word-break:break-word;">${isUzbek ? 'Asos' : 'base'}: <span style="color:#6EE7B7; font-weight:600;">${base}</span></div>` : ''}
      <div style="font-weight:600; color:#67E8F9; font-size:1.02em; line-height:1.3; margin-bottom:${terms.length > 0 ? '4px' : '0'}; word-break:break-word;">
        ${translation}
      </div>
      ${terms.length > 0 ? `<div style="font-size:0.82em; color:#CBD5E1; opacity:0.85; line-height:1.2; word-break:break-word;">${isUzbek ? 'Sinonimlar' : 'synonyms'}: ${terms.slice(0, 3).join(', ')}</div>` : ''}
    `;
  }

  private onWordMouseLeave(span: HTMLElement): void {
    this.activeHoveredWord = null;

    if (this.textElement) {
      this.textElement.querySelectorAll('.aheadsub-phrase-active').forEach((el) => {
        el.classList.remove('aheadsub-phrase-active');
      });
    }

    if (this.wordTooltip) {
      this.wordTooltip.style.display = 'none';
    }

    // Auto-resume video if it was paused by overlay hover
    if (this.pausedByOverlay && this.video?.paused) {
      this.video.play().catch(() => {});
      this.pausedByOverlay = false;
    }
  }

  // --- Translation Request ---

  private async requestTranslation(text: string, targetLang: string): Promise<string> {
    const key = `${targetLang}:${text.trim()}`;
    if (this.translationCache.has(key)) {
      const cached = this.translationCache.get(key)!;
      if (cached && cached.trim().toLowerCase() !== text.trim().toLowerCase()) {
        return cached;
      }
      this.translationCache.delete(key);
    }

    try {
      const response: any = await chrome.runtime.sendMessage({
        type: 'translate_text',
        payload: {
          text,
          targetLang,
          sourceLang: this.settings.spokenLanguage || 'ru',
        },
      });
      if (
        response?.translatedText &&
        response.translatedText.trim().toLowerCase() !== text.trim().toLowerCase() &&
        !response.translatedText.includes('<') &&
        !response.translatedText.includes('GoogleSorry')
      ) {
        this.translationCache.set(key, response.translatedText.trim());
        return response.translatedText.trim();
      }
    } catch {}

    return '';
  }

  private stopRendering(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private findActiveCue(time: number): SubtitleCue | null {
    if (this.cues.length === 0) return null;

    if (this.activeCue && time >= this.activeCue.startTime && time <= this.activeCue.endTime) {
      return this.activeCue;
    }

    for (let i = 0; i < this.cues.length; i++) {
      const cue = this.cues[i]!;
      if (time >= cue.startTime && time <= cue.endTime) {
        return cue;
      }
      if (cue.startTime > time + 5) {
        break;
      }
    }

    return null;
  }
}
