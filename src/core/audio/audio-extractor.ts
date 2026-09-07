// ============================================================
// AheadSub — Audio Extractor
// Handles fetching and extracting audio from various sources.
// Converts to PCM Float32 at 16kHz mono for Whisper.
// ============================================================

import type { AudioAccessResult, AudioChunk } from '../types';
import { AudioAccessMethod } from '../types';
import { WHISPER_SAMPLE_RATE, AUDIO_CHUNK_DURATION_S, AUDIO_CHUNK_OVERLAP_S } from '../constants';
import muxjs from 'mux.js';
import { decodeTsSegment, normalizeAudio } from './ts-demuxer';

export interface HlsKeyInfo {
  method: string;
  keyUrl?: string;
  iv?: Uint8Array;
}

export interface HlsSegment {
  url: string;
  duration: number;
  keyInfo?: HlsKeyInfo;
  sequenceNumber: number;
}

export class AudioExtractor {
  private audioContext: AudioContext | null = null;
  private keyCache: Map<string, CryptoKey> = new Map();

  constructor() {
    // AudioContext created lazily (requires user gesture)
  }

  /**
   * Extract complete audio from a direct URL.
   * Returns audio chunks for sequential processing.
   */
  async extractFromURL(
    url: string,
    onChunk: (chunk: AudioChunk) => Promise<void>,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Failed to fetch audio: ${response.status} ${response.statusText}`);
    }

    const contentLength = parseInt(response.headers.get('content-length') || '0');
    const reader = response.body?.getReader();

    if (!reader) {
      throw new Error('Response body is not readable');
    }

    // Read entire response (for decoding)
    const chunks: Uint8Array[] = [];
    let loaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(loaded, contentLength);
    }

    // Combine chunks
    const audioData = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      audioData.set(chunk, offset);
      offset += chunk.length;
    }

    // Decode to PCM
    const pcm = await this.decodeAudioData(audioData.buffer);
    normalizeAudio(pcm);

    // Split into chunks with overlap
    await this.splitIntoChunks(pcm, onChunk);
  }

  /**
   * Extract audio from an HLS manifest.
   * Fetches segments and decodes them sequentially.
   */
  async extractFromHLS(
    manifestUrl: string,
    onChunk: (chunk: AudioChunk) => Promise<void>,
    onProgress?: (segmentIndex: number, totalSegments: number, manifestDuration?: number) => void
  ): Promise<void> {
    // Fetch and parse the master playlist
    const manifest = await this.parseHLSManifest(manifestUrl);
    const segments = manifest.segments;

    if (segments.length === 0) {
      throw new Error('No audio segments found in HLS manifest');
    }

    const manifestTotalDuration = segments.reduce((sum, s) => sum + (s.duration || 0), 0);
    console.log(`[AheadSub Extractor] Manifest parsed: ${segments.length} segments, estimated duration: ${manifestTotalDuration.toFixed(1)}s`);

    let accumulatedPCM = new Float32Array(0);
    let accumulatedTime = 0;
    let chunkIndex = 0;
    const chunkSamples = AUDIO_CHUNK_DURATION_S * WHISPER_SAMPLE_RATE;
    const overlapSamples = AUDIO_CHUNK_OVERLAP_S * WHISPER_SAMPLE_RATE;

    // Initial progress ping so UI immediately shows duration and 0%
    onProgress?.(0, segments.length, manifestTotalDuration);

    // Fetch init segment if present (for fMP4)
    let initSegmentBuffer: Uint8Array | null = null;
    if (manifest.initUrl) {
      try {
        const res = await fetch(manifest.initUrl);
        if (res.ok) {
          initSegmentBuffer = new Uint8Array(await res.arrayBuffer());
        }
      } catch (e) {
        console.warn('[AheadSub] Failed to fetch fMP4 init segment:', e);
      }
    }

    let consecutiveFailures = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      onProgress?.(i, segments.length, manifestTotalDuration);

      try {
        let response: Response | null = null;
        try {
          response = await fetch(segment.url, { referrerPolicy: 'no-referrer' });
        } catch {
          response = await fetch(segment.url);
        }

        if (!response || !response.ok) {
          consecutiveFailures++;
          if (consecutiveFailures >= 5) {
            throw new Error(`HLS segment fetch failed (${response?.status || 403}). Switching to live tab capture.`);
          }
          continue;
        }

        consecutiveFailures = 0;
        let rawBytes = new Uint8Array(await response.arrayBuffer());

        // Decrypt AES-128 if encrypted
        if (segment.keyInfo?.method === 'AES-128' && segment.keyInfo.keyUrl) {
          try {
            let cryptoKey = this.keyCache.get(segment.keyInfo.keyUrl);
            if (!cryptoKey) {
              const keyRes = await fetch(segment.keyInfo.keyUrl, { credentials: 'include' });
              if (keyRes.ok) {
                const keyBuf = await keyRes.arrayBuffer();
                cryptoKey = await crypto.subtle.importKey(
                  'raw',
                  keyBuf,
                  { name: 'AES-CBC' },
                  false,
                  ['decrypt']
                );
                this.keyCache.set(segment.keyInfo.keyUrl, cryptoKey);
              }
            }
            if (cryptoKey) {
              let iv: BufferSource | undefined = segment.keyInfo.iv as BufferSource | undefined;
              if (!iv) {
                const ivBuf = new ArrayBuffer(16);
                new DataView(ivBuf).setUint32(12, segment.sequenceNumber, false);
                iv = new Uint8Array(ivBuf);
              }

              // Ensure data buffer is 16-byte block aligned
              let toDecrypt: ArrayBuffer;
              const remainder = rawBytes.byteLength % 16;
              if (remainder !== 0) {
                const aligned = rawBytes.byteLength - remainder;
                toDecrypt = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + aligned);
              } else {
                toDecrypt = rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength);
              }

              const decrypted = await crypto.subtle.decrypt(
                { name: 'AES-CBC', iv },
                cryptoKey,
                toDecrypt
              );
              rawBytes = new Uint8Array(decrypted);
            }
          } catch (decryptErr) {
            console.warn(`[AheadSub] Failed to decrypt segment ${i}:`, decryptErr);
          }
        }

        let pcm: Float32Array = new Float32Array(0);

        // Check magic bytes to distinguish MPEG-2 TS vs fMP4
        const isTs = rawBytes[0] === 0x47 || segment.url.toLowerCase().includes('.ts');

        if (isTs) {
          pcm = await decodeTsSegment(rawBytes);
          if ((!pcm || pcm.length === 0) && rawBytes.byteLength > 0) {
            try {
              pcm = await this.decodeAudioData(rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength));
            } catch {}
          }
        } else {
          // fMP4 segment with init
          if (initSegmentBuffer) {
            const combined = new Uint8Array(initSegmentBuffer.byteLength + rawBytes.byteLength);
            combined.set(initSegmentBuffer, 0);
            combined.set(rawBytes, initSegmentBuffer.byteLength);
            try {
              pcm = await this.decodeAudioData(combined.buffer);
            } catch {
              pcm = await decodeTsSegment(combined);
            }
          } else {
            try {
              pcm = await this.decodeAudioData(rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength));
            } catch {
              pcm = await decodeTsSegment(rawBytes);
            }
          }
        }

        if (!pcm || pcm.length === 0) {
          console.warn(`[AheadSub] Segment ${i} yielded 0 PCM samples`);
          continue;
        }

        // Accumulate PCM data
        const newAccumulated = new Float32Array(accumulatedPCM.length + pcm.length);
        newAccumulated.set(accumulatedPCM);
        newAccumulated.set(pcm, accumulatedPCM.length);
        accumulatedPCM = newAccumulated;

        // Emit chunks when we have enough data
        while (accumulatedPCM.length >= chunkSamples) {
          const chunkData = accumulatedPCM.slice(0, chunkSamples);
          normalizeAudio(chunkData);
          const startTime = accumulatedTime;

          await onChunk({
            pcmData: chunkData,
            sampleRate: WHISPER_SAMPLE_RATE,
            startTime,
            endTime: startTime + AUDIO_CHUNK_DURATION_S,
            chunkIndex: chunkIndex++,
            isLast: false,
          });

          // Advance with overlap
          const advance = chunkSamples - overlapSamples;
          accumulatedPCM = accumulatedPCM.slice(advance);
          accumulatedTime += advance / WHISPER_SAMPLE_RATE;
        }
      } catch (e) {
        console.warn(`[AheadSub] Failed to process segment ${i}:`, e);
        continue;
      }
    }

    // Emit remaining data as final chunk
    if (accumulatedPCM.length > 0) {
      normalizeAudio(accumulatedPCM);
      await onChunk({
        pcmData: accumulatedPCM,
        sampleRate: WHISPER_SAMPLE_RATE,
        startTime: accumulatedTime,
        endTime: accumulatedTime + accumulatedPCM.length / WHISPER_SAMPLE_RATE,
        chunkIndex: chunkIndex,
        isLast: true,
      });
    }

    if (accumulatedPCM.length === 0 && chunkIndex === 0) {
      throw new Error(
        'Audio streams could not be extracted (0 samples decoded). The stream may use DRM or an unsupported codec. Please try switching player servers (e.g. HD-1 or VidPlay).'
      );
    }
  }

  /**
   * Decode raw audio data to mono Float32 PCM at 16kHz.
   */
  async decodeAudioData(data: ArrayBuffer): Promise<Float32Array> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
    }

    const audioBuffer = await this.audioContext.decodeAudioData(data.slice(0));

    // Mix to mono
    let mono: Float32Array;
    if (audioBuffer.numberOfChannels === 1) {
      mono = audioBuffer.getChannelData(0);
    } else {
      mono = new Float32Array(audioBuffer.length);
      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const channelData = audioBuffer.getChannelData(ch);
        for (let i = 0; i < audioBuffer.length; i++) {
          mono[i]! += channelData[i]! / audioBuffer.numberOfChannels;
        }
      }
    }

    // Resample if needed
    if (audioBuffer.sampleRate !== WHISPER_SAMPLE_RATE) {
      return this.resample(mono, audioBuffer.sampleRate, WHISPER_SAMPLE_RATE);
    }

    return mono;
  }

  /**
   * Split a PCM buffer into overlapping chunks.
   */
  private async splitIntoChunks(
    pcm: Float32Array,
    onChunk: (chunk: AudioChunk) => Promise<void>
  ): Promise<void> {
    const chunkSamples = AUDIO_CHUNK_DURATION_S * WHISPER_SAMPLE_RATE;
    const overlapSamples = AUDIO_CHUNK_OVERLAP_S * WHISPER_SAMPLE_RATE;
    const advanceSamples = chunkSamples - overlapSamples;
    const totalChunks = Math.ceil(pcm.length / advanceSamples);

    for (let i = 0; i < totalChunks; i++) {
      const start = i * advanceSamples;
      const end = Math.min(start + chunkSamples, pcm.length);
      const chunkData = pcm.slice(start, end);
      const startTime = start / WHISPER_SAMPLE_RATE;
      const endTime = end / WHISPER_SAMPLE_RATE;

      await onChunk({
        pcmData: chunkData,
        sampleRate: WHISPER_SAMPLE_RATE,
        startTime,
        endTime,
        chunkIndex: i,
        isLast: i === totalChunks - 1,
      });
    }
  }

  /**
   * Parse an HLS manifest and return segment URLs.
   */
  private async parseHLSManifest(
    manifestUrl: string
  ): Promise<{ initUrl?: string; mediaSequence?: number; segments: HlsSegment[] }> {
    const response = await fetch(manifestUrl);
    const text = await response.text();

    // Check if this master playlist contains dedicated audio streams
    // RFC 8216: attributes can appear in any order (e.g. GROUP-ID before TYPE)
    const mediaLines = text.match(/#EXT-X-MEDIA:[^\r\n]+/gi) || [];
    const audioLines = mediaLines.filter((l) => /TYPE=["']?AUDIO["']?/i.test(l));
    if (audioLines.length > 0) {
      const withUri = audioLines.filter((al) => /URI=["']?([^"',\s]+)["']?/i.test(al));
      if (withUri.length > 0) {
        let chosenAudioLine = withUri.find((al) => /DEFAULT=YES/i.test(al)) || withUri[0]!;
        for (const al of withUri) {
          if (/LANGUAGE="en"|NAME=".*?(?:English|Dub).*?"/i.test(al)) {
            chosenAudioLine = al;
            break;
          }
        }
        const uriMatch = chosenAudioLine.match(/URI=["']?([^"',\s]+)["']?/i);
        if (uriMatch && uriMatch[1]) {
          const audioPlaylistUrl = this.resolveUrl(uriMatch[1], manifestUrl);
          console.log('[AheadSub Extractor] Loading dedicated audio track from HLS:', audioPlaylistUrl);
          return this.parseHLSManifest(audioPlaylistUrl);
        }
      }
    }

    // Check if this is a master playlist
    if (text.includes('#EXT-X-STREAM-INF')) {
      const variantUrls = this.extractVariantUrls(text, manifestUrl);
      if (variantUrls.length > 0) {
        const chosenVariant = variantUrls[Math.min(1, variantUrls.length - 1)] || variantUrls[0]!;
        console.log('[AheadSub Extractor] Loading HLS variant for audio:', chosenVariant);
        return this.parseHLSManifest(chosenVariant);
      }
    }

    // Media playlist — extract segments and keys
    const segments: HlsSegment[] = [];
    const lines = text.split('\n');

    let mediaSequence = 0;
    let currentKeyInfo: HlsKeyInfo | undefined = undefined;
    let currentDuration = 0;
    let initUrl: string | undefined = undefined;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim();

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        const match = line.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
        if (match && match[1]) {
          mediaSequence = parseInt(match[1], 10);
        }
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/i);
        const method = methodMatch ? methodMatch[1]!.toUpperCase() : 'NONE';
        if (method === 'AES-128') {
          const uriMatch = line.match(/URI="([^"]+)"/i);
          const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+)/i);
          const keyUrl = uriMatch && uriMatch[1] ? this.resolveUrl(uriMatch[1], manifestUrl) : undefined;
          let iv: Uint8Array | undefined = undefined;
          if (ivMatch && ivMatch[1]) {
            iv = this.parseHexIV(ivMatch[1]);
          }
          currentKeyInfo = { method: 'AES-128', keyUrl, iv };
        } else {
          currentKeyInfo = undefined;
        }
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const match = line.match(/URI="([^"]+)"/);
        if (match && match[1]) {
          initUrl = this.resolveUrl(match[1], manifestUrl);
        }
      } else if (line.startsWith('#EXTINF:')) {
        const match = line.match(/#EXTINF:(\d+\.?\d*)/);
        if (match) {
          currentDuration = parseFloat(match[1]!);
        }
      } else if (line && !line.startsWith('#')) {
        const segmentUrl = this.resolveUrl(line, manifestUrl);
        const seq = mediaSequence + segments.length;
        segments.push({
          url: segmentUrl,
          duration: currentDuration,
          keyInfo: currentKeyInfo ? { ...currentKeyInfo } : undefined,
          sequenceNumber: seq,
        });
        currentDuration = 0;
      }
    }

    return { initUrl, mediaSequence, segments };
  }

  private parseHexIV(hex: string): Uint8Array {
    const clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
    const padded = clean.padStart(32, '0').slice(0, 32);
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      bytes[i] = parseInt(padded.substr(i * 2, 2), 16) || 0;
    }
    return bytes;
  }

  private extractVariantUrls(masterPlaylist: string, baseUrl: string): string[] {
    const urls: string[] = [];
    const lines = masterPlaylist.split('\n');

    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith('#EXT-X-STREAM-INF')) {
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j]?.trim();
          if (!nextLine) continue;
          if (nextLine.startsWith('#')) continue;
          urls.push(this.resolveUrl(nextLine, baseUrl));
          break;
        }
      }
    }

    return urls;
  }

  private resolveUrl(relativeUrl: string, baseUrl: string): string {
    if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
      return relativeUrl;
    }
    try {
      return new URL(relativeUrl, baseUrl).href;
    } catch {
      return relativeUrl;
    }
  }

  private resample(data: Float32Array, fromRate: number, toRate: number): Float32Array {
    const ratio = fromRate / toRate;
    const newLength = Math.round(data.length / ratio);
    const result = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const low = Math.floor(srcIndex);
      const high = Math.min(low + 1, data.length - 1);
      const frac = srcIndex - low;
      result[i] = data[low]! * (1 - frac) + data[high]! * frac;
    }

    return result;
  }

  destroy(): void {
    this.audioContext?.close();
    this.audioContext = null;
  }
}
