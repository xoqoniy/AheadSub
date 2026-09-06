import { describe, it, expect } from 'vitest';
import { buildCuesFromWords } from '../cue-builder';
import type { TranscriptionWord } from '../../types';

describe('cue-builder', () => {
  it('returns empty array when given no words', () => {
    expect(buildCuesFromWords([])).toEqual([]);
  });

  it('groups words into natural subtitle cues within max character and pause boundaries', () => {
    const words: TranscriptionWord[] = [
      { word: 'Hello', start: 0.0, end: 0.5, confidence: 0.9 },
      { word: 'everyone,', start: 0.6, end: 1.0, confidence: 0.9 },
      { word: 'welcome', start: 1.1, end: 1.5, confidence: 0.9 },
      { word: 'to', start: 1.6, end: 1.8, confidence: 0.9 },
      { word: 'AheadSub.', start: 1.9, end: 2.5, confidence: 0.9 },
    ];

    const cues = buildCuesFromWords(words, 'test-cue');
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[0]?.startTime).toBe(0.0);
    expect(cues[0]?.text).toContain('Hello');
  });

  it('splits cues when there is a significant audio pause (> 500ms)', () => {
    const words: TranscriptionWord[] = [
      { word: 'First', start: 0.0, end: 0.5, confidence: 0.9 },
      { word: 'phrase.', start: 0.6, end: 1.0, confidence: 0.9 },
      // 1.5 second pause
      { word: 'Second', start: 2.5, end: 3.0, confidence: 0.9 },
      { word: 'phrase.', start: 3.1, end: 3.5, confidence: 0.9 },
    ];

    const cues = buildCuesFromWords(words, 'pause-cue');
    expect(cues).toHaveLength(2);
    expect(cues[0]?.text).toContain('First phrase.');
    expect(cues[1]?.text).toContain('Second phrase.');
    expect(cues[1]?.startTime).toBe(2.5);
  });
});
