import { describe, it, expect } from 'vitest';
import { generateSRT } from '../srt-generator';
import type { SubtitleCue } from '../../types';

describe('srt-generator', () => {
  it('generates a valid SRT string with 1-based sequential cue indexing', () => {
    const cues: SubtitleCue[] = [
      {
        id: 'custom-id-99',
        startTime: 0.5,
        endTime: 3.123,
        text: 'First SRT cue',
        words: [],
      },
      {
        id: 'custom-id-100',
        startTime: 4.0,
        endTime: 6.543,
        text: 'Second SRT cue',
        words: [],
      },
    ];

    const srt = generateSRT(cues);
    expect(srt).toContain('1\n00:00:00,500 --> 00:00:03,123\nFirst SRT cue');
    expect(srt).toContain('2\n00:00:04,000 --> 00:00:06,543\nSecond SRT cue');
  });

  it('formats SRT comma millisecond separator without overflow', () => {
    const cues: SubtitleCue[] = [
      {
        id: 'cue-overflow',
        startTime: 59.9999,
        endTime: 60.0,
        text: 'Overflow test',
        words: [],
      },
    ];

    const srt = generateSRT(cues);
    expect(srt).toContain('00:01:00,000 --> 00:01:00,000');
    expect(srt).not.toContain('1000');
  });
});
