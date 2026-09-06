import { describe, it, expect } from 'vitest';
import { generateVTT } from '../vtt-generator';
import type { SubtitleCue } from '../../types';

describe('vtt-generator', () => {
  it('generates a valid WEBVTT string from cues', () => {
    const cues: SubtitleCue[] = [
      {
        id: 'cue-0',
        startTime: 1.25,
        endTime: 4.5,
        text: 'Hello world',
        words: [],
      },
      {
        id: 'cue-1',
        startTime: 5.0,
        endTime: 8.75,
        text: 'Second line of subtitles',
        words: [],
      },
    ];

    const vtt = generateVTT(cues);
    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('cue-0');
    expect(vtt).toContain('00:00:01.250 --> 00:00:04.500');
    expect(vtt).toContain('Hello world');
    expect(vtt).toContain('00:00:05.000 --> 00:00:08.750');
    expect(vtt).toContain('Second line of subtitles');
  });

  it('correctly handles millisecond rounding near integer boundaries', () => {
    const cues: SubtitleCue[] = [
      {
        id: 'cue-boundary',
        startTime: 1.9999,
        endTime: 2.0,
        text: 'Boundary test',
        words: [],
      },
    ];

    const vtt = generateVTT(cues);
    expect(vtt).toContain('00:00:02.000 --> 00:00:02.000');
    expect(vtt).not.toContain('00:00:01.1000');
  });

  it('sorts cues chronologically by start time', () => {
    const cues: SubtitleCue[] = [
      { id: 'cue-2', startTime: 10, endTime: 12, text: 'Later', words: [] },
      { id: 'cue-1', startTime: 2, endTime: 4, text: 'Earlier', words: [] },
    ];

    const vtt = generateVTT(cues);
    const earlierIndex = vtt.indexOf('Earlier');
    const laterIndex = vtt.indexOf('Later');
    expect(earlierIndex).toBeGreaterThan(-1);
    expect(laterIndex).toBeGreaterThan(-1);
    expect(earlierIndex).toBeLessThan(laterIndex);
  });
});
