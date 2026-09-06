// ============================================================
// AheadSub — MPEG-2 TS to PCM Audio Demuxer & Decoder
// Extracts ADTS AAC elementary streams from MPEG-2 TS segments
// and decodes them to 16kHz mono Float32 PCM for Whisper AI
// using hardware-accelerated WebCodecs AudioDecoder.
// ============================================================

import muxjs from 'mux.js';
import { WHISPER_SAMPLE_RATE } from '../constants';

const ADTS_SAMPLING_FREQUENCIES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * Extracts raw ADTS AAC elementary stream packets from MPEG-2 TS bytes.
 */
export function extractAudioFromTs(tsBytes: Uint8Array): Promise<Uint8Array[]> {
  return new Promise((resolve) => {
    const packetStream = new (muxjs as any).mp2t.TransportPacketStream();
    const parseStream = new (muxjs as any).mp2t.TransportParseStream();
    const elementaryStream = new (muxjs as any).mp2t.ElementaryStream();

    packetStream.pipe(parseStream).pipe(elementaryStream);

    const audioBuffers: Uint8Array[] = [];

    elementaryStream.on('data', (data: any) => {
      if (data.type === 'audio' && data.data && data.data.length > 0) {
        audioBuffers.push(new Uint8Array(data.data));
      }
    });

    try {
      packetStream.push(tsBytes);
      packetStream.flush();
    } catch (e) {
      console.warn('[AheadSub Demuxer] Error parsing TS packet:', e);
    }

    resolve(audioBuffers);
  });
}

/**
 * Parses a contiguous ADTS byte buffer into individual complete ADTS frames.
 */
export function extractAdtsFrames(adtsBuffer: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let i = 0;

  while (i + 7 <= adtsBuffer.length) {
    // Look for ADTS syncword: 12 bits of 1s (0xFFF)
    if (adtsBuffer[i] === 0xFF && (adtsBuffer[i + 1]! & 0xF0) === 0xF0) {
      // Frame length is 13 bits across bytes 3, 4, 5
      const frameLength =
        ((adtsBuffer[i + 3]! & 0x03) << 11) |
        (adtsBuffer[i + 4]! << 3) |
        ((adtsBuffer[i + 5]! & 0xE0) >> 5);

      if (frameLength < 7 || i + frameLength > adtsBuffer.length) {
        // Frame truncated or invalid
        break;
      }

      frames.push(adtsBuffer.subarray(i, i + frameLength));
      i += frameLength;
    } else {
      i++;
    }
  }

  return frames;
}

/**
 * Decodes a sequence of ADTS AAC frames into 16kHz mono Float32 PCM.
 * Uses the WebCodecs AudioDecoder API.
 */
export async function decodeAdtsFrames(frames: Uint8Array[]): Promise<Float32Array> {
  if (frames.length === 0) return new Float32Array(0);

  const first = frames[0]!;
  const sampleRateIndex = (first[2]! & 0x3C) >> 2;
  const sampleRate = ADTS_SAMPLING_FREQUENCIES[sampleRateIndex] || 44100;
  const channelCount = ((first[2]! & 1) << 2) | ((first[3]! & 0xC0) >> 6) || 2;

  // Use WebCodecs AudioDecoder if available
  if (typeof AudioDecoder !== 'undefined') {
    return await decodeWithWebCodecs(frames, sampleRate, channelCount);
  }

  throw new Error('WebCodecs AudioDecoder is not supported in this environment');
}

/**
 * Internal WebCodecs decoder implementation.
 */
async function decodeWithWebCodecs(
  frames: Uint8Array[],
  sampleRate: number,
  channelCount: number
): Promise<Float32Array> {
  const pcmBuffers: Float32Array[] = [];
  let actualSampleRate = sampleRate;

  const decoder = new AudioDecoder({
    output(audioData: AudioData) {
      try {
        actualSampleRate = audioData.sampleRate;
        const numFrames = audioData.numberOfFrames;
        const numChannels = audioData.numberOfChannels;
        const mono = new Float32Array(numFrames);

        // WebCodecs specification mandates that conversion from any format to 'f32-planar' MUST be supported
        audioData.copyTo(mono, { planeIndex: 0, format: 'f32-planar' });

        if (numChannels > 1) {
          const ch1 = new Float32Array(numFrames);
          audioData.copyTo(ch1, { planeIndex: 1, format: 'f32-planar' });
          for (let j = 0; j < numFrames; j++) {
            mono[j] = (mono[j]! + ch1[j]!) * 0.5;
          }
        }

        pcmBuffers.push(mono);
      } catch (err) {
        console.warn('[AheadSub WebCodecs] copyTo error:', err);
      } finally {
        audioData.close();
      }
    },
    error(e) {
      console.warn('[AheadSub WebCodecs] AudioDecoder error:', e);
    },
  });

  decoder.configure({
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: channelCount,
  });

  let timestamp = 0;
  for (const frame of frames) {
    if (decoder.state === 'closed') break;
    decoder.decode(
      new EncodedAudioChunk({
        type: 'key',
        timestamp,
        data: frame,
      })
    );
    // AAC standard frame is 1024 samples
    timestamp += Math.round((1024 / sampleRate) * 1_000_000);
  }

  if (decoder.state !== 'closed') {
    try {
      await decoder.flush();
    } catch (e) {
      console.warn('[AheadSub WebCodecs] Flush error:', e);
    }
  }

  if (decoder.state !== 'closed') {
    decoder.close();
  }

  // Concatenate mono chunks
  const totalLength = pcmBuffers.reduce((sum, b) => sum + b.length, 0);
  const combined = new Float32Array(totalLength);
  let offset = 0;
  for (const b of pcmBuffers) {
    combined.set(b, offset);
    offset += b.length;
  }

  // Resample to 16kHz if needed
  if (actualSampleRate !== WHISPER_SAMPLE_RATE) {
    return resampleAudio(combined, actualSampleRate, WHISPER_SAMPLE_RATE);
  }

  return combined;
}

let fallbackAudioContext: AudioContext | null = null;

async function fallbackDecodeAdts(combinedBytes: Uint8Array): Promise<Float32Array> {
  try {
    if (!fallbackAudioContext) {
      fallbackAudioContext = new AudioContext({ sampleRate: WHISPER_SAMPLE_RATE });
    }
    const copy = new ArrayBuffer(combinedBytes.byteLength);
    new Uint8Array(copy).set(combinedBytes);
    const audioBuffer = await fallbackAudioContext.decodeAudioData(copy);
    const mono = new Float32Array(audioBuffer.length);
    const ch0 = audioBuffer.getChannelData(0);
    if (audioBuffer.numberOfChannels > 1) {
      const ch1 = audioBuffer.getChannelData(1);
      for (let i = 0; i < audioBuffer.length; i++) {
        mono[i] = (ch0[i]! + ch1[i]!) * 0.5;
      }
    } else {
      mono.set(ch0);
    }

    if (audioBuffer.sampleRate !== WHISPER_SAMPLE_RATE) {
      return resampleAudio(mono, audioBuffer.sampleRate, WHISPER_SAMPLE_RATE);
    }
    return mono;
  } catch (e) {
    console.warn('[AheadSub] AudioContext ADTS decode fallback failed:', e);
    return new Float32Array(0);
  }
}

/**
 * Decodes a complete MPEG-2 TS segment into 16kHz mono Float32 PCM.
 */
export async function decodeTsSegment(tsBytes: Uint8Array): Promise<Float32Array> {
  const audioPackets = await extractAudioFromTs(tsBytes);
  if (audioPackets.length === 0) return new Float32Array(0);

  const totalLength = audioPackets.reduce((sum, b) => sum + b.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const b of audioPackets) {
    combined.set(b, offset);
    offset += b.byteLength;
  }

  const frames = extractAdtsFrames(combined);
  let pcm: any = new Float32Array(0);

  if (frames.length > 0) {
    try {
      pcm = await decodeAdtsFrames(frames);
    } catch (err) {
      console.warn('[AheadSub] WebCodecs decode failed, attempting fallback:', err);
    }
  }

  if (!pcm || pcm.length === 0) {
    pcm = await fallbackDecodeAdts(combined);
  }

  if (pcm && pcm.length > 0) {
    normalizeAudio(pcm as Float32Array);
  }

  return pcm as Float32Array;
}

/**
 * Normalizes Float32 audio volume so quiet dialogue is boosted for Whisper AI.
 */
export function normalizeAudio(data: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]!);
    if (abs > max) max = abs;
  }
  // If audio is quiet (peak under 0.8), boost to 0.95
  if (max > 0.01 && max < 0.8) {
    const scale = 0.95 / max;
    for (let i = 0; i < data.length; i++) {
      data[i] = data[i]! * scale;
    }
  }
  return data;
}

/**
 * Resamples Float32 audio from fromRate to toRate using linear interpolation.
 */
export function resampleAudio(
  data: Float32Array,
  fromRate: number,
  toRate: number
): Float32Array {
  if (fromRate === toRate) return data;

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
