# AheadSub

**Ahead-of-Time Subtitle Generation for HTML5 Videos**

A Chrome Extension (Manifest V3) that generates accurately synchronized subtitles for web videos **before** the viewer reaches that point in playback, using local Whisper AI speech recognition.

> ⚡ This is NOT live captioning. AheadSub processes audio ahead of playback so subtitles are ready with **zero delay**.

---

## Features

- **Mode A — Full Pre-Generation**: Fetches complete audio and transcribes the entire video before playback
- **Mode B — Ahead Buffer**: Maintains a rolling transcription buffer 30-60 seconds ahead of playback
- **Mode C — Real-time Fallback**: Falls back gracefully when ahead-of-time processing isn't possible
- **Local Whisper AI**: All speech recognition runs locally in your browser — no data uploaded
- **Word-Level Timestamps**: Precise subtitle timing using Whisper's word-level timestamp support
- **Multi-Language**: Auto-detects spoken language, supports 20+ languages
- **Translation**: Optional local or cloud translation between languages
- **Smart Caching**: IndexedDB caching means previously transcribed videos load instantly
- **VTT/SRT Export**: Export generated subtitles as standard subtitle files
- **Site Adapters**: Extensible adapter architecture for site-specific video players

## Installation

### Prerequisites
- Node.js 18+ and npm
- Chrome 116+ (for WebGPU support) or Chrome 108+ (WASM fallback)

### Build & Install

```bash
# Clone and install dependencies
cd ChromeExtension
npm install

# Build the extension
npm run build
```

### Load in Chrome

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/` directory
5. The AheadSub icon appears in your toolbar

---

## Usage

1. **Visit any page with a video** (YouTube, AnimeLIB, Kodik, direct HTML5 video, etc.)
2. **Click the AheadSub icon** in the toolbar
3. **Configure settings**:
   - Spoken language: Auto-detect or manual
   - Subtitle language: Choose target language
   - Mode: Generate ahead (recommended) / Ahead buffer / Real-time
   - Model: Tiny/Base/Small/Medium
4. **Click "Generate subtitles"**
5. **Watch the progress**: See processing progress and how far ahead subtitles are ready
6. **Play the video**: Subtitles appear at their correct timestamps with zero delay

### Manual VTT/SRT Loading

You can also load existing subtitle files:
1. Click the AheadSub popup
2. Click **Load VTT/SRT**
3. Select a `.vtt` or `.srt` file
4. Subtitles will be overlaid on the active video

---

## Architecture

```
src/
├── background/           # MV3 Service Worker — orchestration
│   └── service-worker.ts
├── content/              # Injected into web pages
│   ├── index.ts          # Entry point
│   ├── media-detector.ts # Finds <video> elements
│   ├── subtitle-overlay.ts # Custom subtitle renderer
│   ├── sync-engine.ts    # Video↔Audio↔Subtitle sync
│   └── vtt-parser.ts     # VTT/SRT parsing
├── popup/                # Extension popup UI
│   ├── popup.html
│   ├── popup.ts
│   └── popup.css
├── offscreen/            # Offscreen document (DOM context for workers)
│   ├── offscreen.html
│   └── offscreen.ts
├── options/              # Settings page
│   ├── options.html/ts/css
├── workers/              # Web Workers for heavy processing
│   └── transcription-worker.ts  # Whisper inference
├── core/                 # Shared logic
│   ├── types.ts          # TypeScript interfaces
│   ├── messages.ts       # Chrome messaging system
│   ├── constants.ts      # Configuration
│   ├── audio/
│   │   ├── audio-extractor.ts  # Fetches/decodes audio
│   │   └── audio-chunker.ts    # Splits audio, deduplicates
│   ├── transcription/
│   │   ├── transcription-engine.ts  # Pipeline orchestrator
│   │   └── cue-builder.ts          # Word→cue conversion
│   ├── translation/
│   │   ├── language-detector.ts
│   │   └── translator.ts           # Local + cloud translation
│   ├── subtitles/
│   │   ├── vtt-generator.ts
│   │   └── srt-generator.ts
│   ├── cache/
│   │   └── subtitle-cache.ts  # IndexedDB persistence
│   └── pipeline/
│       ├── ahead-pipeline.ts    # Mode A
│       ├── buffer-pipeline.ts   # Mode B
│       └── realtime-pipeline.ts # Mode C
└── adapters/             # Site-specific video handling
    ├── adapter-interface.ts
    ├── adapter-registry.ts
    ├── generic-html5.ts   # Works on any page
    └── kodik.ts           # AnimeLIB/Kodik player
```

### Processing Modes

| Mode | When Used | Latency |
|------|-----------|---------|
| **A: Full Pre-Generation** | Direct URL or HLS/DASH manifest accessible | Zero — subtitles ready before playback |
| **B: Ahead Buffer** | Audio stream capturable but not pre-fetchable | Near-zero — 30-60s buffer maintained ahead |
| **C: Real-time** | Only live audio capture available | 5-10s processing delay |

### How Local Whisper Works

1. **Model download**: On first use, the Whisper model (40-780MB depending on size) is downloaded from Hugging Face's CDN and cached in the browser
2. **Hardware detection**: Checks for WebGPU (preferred) → WASM+SIMD → WASM (fallback)
3. **Worker isolation**: All inference runs in a dedicated Web Worker via Transformers.js
4. **Chunked processing**: Audio is split into 30s overlapping chunks
5. **Word timestamps**: Whisper returns word-level timestamps for precise subtitle timing
6. **Cue building**: Words are grouped into natural subtitle phrases respecting character limits and reading speed

---

## Supported Models

| Model | Size | Quality | Speed |
|-------|------|---------|-------|
| Tiny | ~40MB | Basic | Very fast |
| Base | ~75MB | Good | Fast |
| **Small** | ~250MB | **Recommended** | Balanced |
| Medium | ~780MB | Best | Slower |

Models are downloaded from `onnx-community/whisper-*_timestamped` on Hugging Face.

---

## Browser Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| **CORS restrictions** | Can't fetch cross-origin video URLs | Falls back to captureStream or tab capture |
| **Cross-origin iframes** | Can't access Kodik iframe content directly | Uses adapter system, tries manifest discovery |
| **DRM/EME** | Encrypted media cannot be captured | Shows clear error message |
| **Service worker lifecycle** | MV3 workers are ephemeral | Offscreen document bridges the gap |
| **Memory limits** | Large models use significant RAM | Chunk processing, model size selection |

---

## Adding Site Adapters

Create a new file in `src/adapters/`:

```typescript
import type { SiteAdapter } from './adapter-interface';
import type { MediaInfo, AudioAccessResult } from '../core/types';

export class MySiteAdapter implements SiteAdapter {
  name = 'My Site';
  priority = 200; // Lower than 1000 (generic)

  canHandle(url: string): boolean {
    return url.includes('mysite.com');
  }

  async getMediaInfo(video: HTMLVideoElement, doc: Document): Promise<MediaInfo> {
    // Extract video metadata
  }

  async getAudioAccess(video: HTMLVideoElement, doc: Document): Promise<AudioAccessResult> {
    // Determine best audio access method
  }
}
```

Register in `src/adapters/adapter-registry.ts`:
```typescript
import { MySiteAdapter } from './my-site';
this.register(new MySiteAdapter());
```

---

## Debugging Media Extraction

1. Open Chrome DevTools on the video page
2. Network tab → Filter: `.m3u8`, `.mpd`, `media`, `video`, `audio`
3. Check the Console for `[AheadSub]` log messages
4. Look for:
   - Direct video URLs (Mode A possible)
   - HLS manifests (Mode A possible)
   - blob: URLs (might need MSE interception)
   - No accessible source (Mode B/C only)

### Testing AnimeLIB/Kodik

1. Open an AnimeLIB episode page
2. Open DevTools → Network tab
3. Look for `.m3u8` requests from Kodik's CDN
4. The Kodik adapter attempts to discover these URLs automatically
5. If cross-origin restrictions prevent access, Mode B/C will be used

---

## Privacy & Security

- **All processing is local** by default
- Audio data never leaves your browser unless you explicitly enable cloud translation
- Whisper models are cached locally after first download
- No analytics, no tracking, no telemetry
- Cloud translation (optional) only sends subtitle text, never audio

---

## Development

```bash
npm run dev      # Vite dev server with HMR
npm run build    # Production build to dist/
npm run test     # Run tests
npm run lint     # Lint check
```

---

## License

MIT
