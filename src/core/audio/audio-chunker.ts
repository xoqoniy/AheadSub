// ============================================================
// AheadSub — Audio Chunker
// Splits audio into overlapping chunks with VAD-aware boundaries.
// Deduplicates overlapping transcription results.
// ============================================================

import type { AudioChunk, SubtitleCue } from '../types';
import { AUDIO_CHUNK_DURATION_S, AUDIO_CHUNK_OVERLAP_S, WHISPER_SAMPLE_RATE } from '../constants';

/**
 * Split raw PCM audio into overlapping chunks for transcription.
 */
export function createAudioChunks(
  pcm: Float32Array,
  sampleRate: number = WHISPER_SAMPLE_RATE,
  chunkDuration: number = AUDIO_CHUNK_DURATION_S,
  overlapDuration: number = AUDIO_CHUNK_OVERLAP_S
): AudioChunk[] {
  const chunkSamples = Math.floor(chunkDuration * sampleRate);
  const overlapSamples = Math.floor(overlapDuration * sampleRate);
  const advanceSamples = chunkSamples - overlapSamples;

  const chunks: AudioChunk[] = [];
  const totalChunks = Math.max(1, Math.ceil((pcm.length - overlapSamples) / advanceSamples));

  for (let i = 0; i < totalChunks; i++) {
    const start = i * advanceSamples;
    const end = Math.min(start + chunkSamples, pcm.length);
    const chunkData = pcm.slice(start, end);
    const startTime = start / sampleRate;
    const endTime = end / sampleRate;

    chunks.push({
      pcmData: chunkData,
      sampleRate,
      startTime,
      endTime,
      chunkIndex: i,
      isLast: i === totalChunks - 1,
    });
  }

  return chunks;
}

/**
 * Deduplicate subtitle cues from overlapping chunks.
 * When two chunks overlap, the same speech may be transcribed twice.
 * We remove duplicates by comparing timestamps and text similarity.
 */
export function deduplicateOverlappingCues(cues: SubtitleCue[]): SubtitleCue[] {
  if (cues.length <= 1) return cues;

  // Sort by start time
  const sorted = [...cues].sort((a, b) => a.startTime - b.startTime);
  const result: SubtitleCue[] = [sorted[0]!];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const previous = result[result.length - 1]!;

    // Check for overlap
    if (current.startTime < previous.endTime) {
      // Overlapping cues — check if they're duplicates
      const textSimilarity = calculateSimilarity(
        normalizeText(previous.text),
        normalizeText(current.text)
      );

      if (textSimilarity > 0.6) {
        // Likely duplicate — keep the one with better timing
        // (earlier cue is usually from the "main" part of the chunk, not the overlap)
        continue;
      }

      // Different text but overlapping times — adjust timing
      const midpoint = (previous.endTime + current.startTime) / 2;
      previous.endTime = midpoint;
      current.startTime = midpoint;
    }

    result.push(current);
  }

  return result;
}

/**
 * Simple text similarity using Jaccard index on word sets.
 */
function calculateSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return intersection / union;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').trim();
}

/**
 * Detect silence in audio data.
 * Returns an array of non-silent regions.
 */
export function detectVoiceActivity(
  pcm: Float32Array,
  sampleRate: number,
  thresholdDb: number = -35,
  minSilenceMs: number = 300,
  minSpeechMs: number = 200
): { start: number; end: number }[] {
  const threshold = Math.pow(10, thresholdDb / 20);
  const windowSize = Math.floor(sampleRate * 0.02); // 20ms windows
  const minSilenceSamples = Math.floor(sampleRate * minSilenceMs / 1000);
  const minSpeechSamples = Math.floor(sampleRate * minSpeechMs / 1000);

  const regions: { start: number; end: number }[] = [];
  let inSpeech = false;
  let speechStart = 0;
  let silenceCount = 0;

  for (let i = 0; i < pcm.length; i += windowSize) {
    const end = Math.min(i + windowSize, pcm.length);

    // Calculate RMS energy
    let sum = 0;
    for (let j = i; j < end; j++) {
      sum += pcm[j]! * pcm[j]!;
    }
    const rms = Math.sqrt(sum / (end - i));

    if (rms > threshold) {
      if (!inSpeech) {
        speechStart = i;
        inSpeech = true;
      }
      silenceCount = 0;
    } else {
      silenceCount += windowSize;
      if (inSpeech && silenceCount >= minSilenceSamples) {
        const speechEnd = i - silenceCount + windowSize;
        if (speechEnd - speechStart >= minSpeechSamples) {
          regions.push({
            start: speechStart / sampleRate,
            end: speechEnd / sampleRate,
          });
        }
        inSpeech = false;
      }
    }
  }

  // Handle final speech region
  if (inSpeech) {
    regions.push({
      start: speechStart / sampleRate,
      end: pcm.length / sampleRate,
    });
  }

  return regions;
}
