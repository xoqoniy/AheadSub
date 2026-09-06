// ============================================================
// AheadSub — Cue Builder
// Converts word-level timestamps into readable subtitle cues
// with proper segmentation, phrasing, and timing.
// ============================================================

import type { SubtitleCue, TranscriptionWord } from '../types';
import {
  MIN_CUE_DURATION_S,
  MAX_CUE_DURATION_S,
  MAX_CHARS_PER_SECOND,
} from '../constants';

interface CueBuildOptions {
  maxCharsPerLine: number;
  maxLines: number;
  minCueDuration: number;
  maxCueDuration: number;
  maxCharsPerSecond: number;
}

const DEFAULT_OPTIONS: CueBuildOptions = {
  maxCharsPerLine: 42,
  maxLines: 2,
  minCueDuration: MIN_CUE_DURATION_S,
  maxCueDuration: MAX_CUE_DURATION_S,
  maxCharsPerSecond: MAX_CHARS_PER_SECOND,
};

/**
 * Build subtitle cues from word-level timestamps.
 * Groups words into natural phrases considering:
 * - Sentence boundaries
 * - Pauses between words
 * - Maximum characters per line
 * - Reading speed
 */
export function buildCuesFromWords(
  words: TranscriptionWord[],
  baseId: string = 'cue',
  options: Partial<CueBuildOptions> = {}
): SubtitleCue[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (words.length === 0) return [];

  const cues: SubtitleCue[] = [];
  let currentWords: TranscriptionWord[] = [];
  let currentText = '';
  let cueIndex = 0;

  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    const prevWord = i > 0 ? words[i - 1]! : null;

    const testText = currentText ? `${currentText} ${word.word}` : word.word;
    const currentStart = currentWords.length > 0 ? currentWords[0]!.start : word.start;
    const currentDuration = word.end - currentStart;

    // Determine if we should start a new cue
    const shouldBreak = shouldStartNewCue(
      currentText,
      word,
      prevWord,
      currentDuration,
      opts
    );

    if (shouldBreak && currentWords.length > 0) {
      // Emit current cue
      cues.push(createCue(currentWords, `${baseId}-${cueIndex}`, opts));
      cueIndex++;
      currentWords = [];
      currentText = '';
    }

    currentWords.push(word);
    currentText = currentText ? `${currentText} ${word.word}` : word.word;
  }

  // Emit remaining words
  if (currentWords.length > 0) {
    cues.push(createCue(currentWords, `${baseId}-${cueIndex}`, opts));
  }

  return cues;
}

/**
 * Determine whether to start a new cue before this word.
 */
function shouldStartNewCue(
  currentText: string,
  word: TranscriptionWord,
  prevWord: TranscriptionWord | null,
  currentDuration: number,
  opts: CueBuildOptions
): boolean {
  if (!currentText) return false;

  const maxChars = opts.maxCharsPerLine * opts.maxLines;
  const testLength = currentText.length + 1 + word.word.length;

  // Would exceed character limit
  if (testLength > maxChars) return true;

  // Would exceed max duration
  if (currentDuration > opts.maxCueDuration) return true;

  // Significant pause between words (> 500ms)
  if (prevWord && (word.start - prevWord.end) > 0.5) return true;

  // End of sentence + reasonable length
  if (prevWord && isEndOfSentence(prevWord.word) && currentText.length >= opts.maxCharsPerLine / 2) {
    return true;
  }

  return false;
}

/**
 * Create a SubtitleCue from a group of words.
 */
function createCue(
  words: TranscriptionWord[],
  id: string,
  opts: CueBuildOptions
): SubtitleCue {
  const text = words.map(w => w.word).join(' ').trim();
  const startTime = words[0]!.start;
  const endTime = words[words.length - 1]!.end;

  // Ensure minimum duration
  const duration = Math.max(endTime - startTime, opts.minCueDuration);
  const adjustedEnd = startTime + duration;

  // Format text for display (line breaks)
  const displayText = formatForDisplay(text, opts.maxCharsPerLine, opts.maxLines);

  return {
    id,
    startTime,
    endTime: adjustedEnd,
    text: displayText,
    words: words.map(w => ({ ...w })),
  };
}

/**
 * Format text for subtitle display with line breaks.
 */
function formatForDisplay(text: string, maxChars: number, maxLines: number): string {
  if (text.length <= maxChars || maxLines === 1) return text;

  // Try to split into lines at natural break points
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;

    if (testLine.length > maxChars && currentLine) {
      lines.push(currentLine);
      currentLine = word;

      if (lines.length >= maxLines) {
        // Append remaining words to last line
        const remaining = words.slice(words.indexOf(word)).join(' ');
        lines[lines.length - 1] = remaining;
        break;
      }
    } else {
      currentLine = testLine;
    }
  }

  if (currentLine && lines.length < maxLines) {
    lines.push(currentLine);
  }

  // If only one line, try to balance two lines
  if (lines.length === 1 && text.length > maxChars * 0.6 && maxLines >= 2) {
    return balancedTwoLines(text);
  }

  return lines.join('\n');
}

/**
 * Split text into two balanced lines.
 */
function balancedTwoLines(text: string): string {
  const midpoint = Math.floor(text.length / 2);

  // Find the nearest space to the midpoint
  let bestSplit = -1;
  for (let offset = 0; offset < midpoint; offset++) {
    if (text[midpoint + offset] === ' ') {
      bestSplit = midpoint + offset;
      break;
    }
    if (midpoint - offset >= 0 && text[midpoint - offset] === ' ') {
      bestSplit = midpoint - offset;
      break;
    }
  }

  if (bestSplit < 0) return text;

  return text.substring(0, bestSplit).trim() + '\n' + text.substring(bestSplit).trim();
}

/**
 * Check if a word ends a sentence.
 */
function isEndOfSentence(word: string): boolean {
  return /[.!?。！？…]$/.test(word);
}
