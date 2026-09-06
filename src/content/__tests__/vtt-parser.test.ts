import { describe, it, expect } from 'vitest';
import { parseVTT, parseSRT, formatVTTTimestamp, formatSRTTimestamp } from '../vtt-parser';

describe('vtt-parser & srt-parser', () => {
  describe('parseVTT', () => {
    it('parses standard WebVTT content with headers and cue IDs', () => {
      const vtt = `WEBVTT
Kind: captions
Language: en

cue-1
00:00:01.000 --> 00:00:04.500
Welcome to AheadSub.

cue-2
00:00:05.000 --> 00:00:09.200
Subtitles generated on-device.`;

      const cues = parseVTT(vtt);
      expect(cues).toHaveLength(2);
      expect(cues[0]?.id).toBe('cue-1');
      expect(cues[0]?.startTime).toBe(1.0);
      expect(cues[0]?.endTime).toBe(4.5);
      expect(cues[0]?.text).toBe('Welcome to AheadSub.');

      expect(cues[1]?.id).toBe('cue-2');
      expect(cues[1]?.startTime).toBe(5.0);
      expect(cues[1]?.endTime).toBe(9.2);
    });

    it('parses WebVTT timestamps without hour prefixes (MM:SS.mmm)', () => {
      const vtt = `WEBVTT

01:15.500 --> 01:20.000
No hours in timestamp.`;

      const cues = parseVTT(vtt);
      expect(cues).toHaveLength(1);
      expect(cues[0]?.startTime).toBe(75.5);
      expect(cues[0]?.endTime).toBe(80.0);
      expect(cues[0]?.text).toBe('No hours in timestamp.');
    });

    it('strips WebVTT styling/formatting tags from cue text', () => {
      const vtt = `WEBVTT

00:00:00.000 --> 00:00:02.000
<v Speaker 1><b>Bold text</b> and <i>italic</i> content.`;

      const cues = parseVTT(vtt);
      expect(cues[0]?.text).toBe('Bold text and italic content.');
    });
  });

  describe('parseSRT', () => {
    it('parses standard SRT format with comma separators', () => {
      const srt = `1
00:00:01,000 --> 00:00:03,500
First SRT line.

2
00:00:04,000 --> 00:00:07,800
Second SRT line.`;

      const cues = parseSRT(srt);
      expect(cues).toHaveLength(2);
      expect(cues[0]?.id).toBe('1');
      expect(cues[0]?.startTime).toBe(1.0);
      expect(cues[0]?.endTime).toBe(3.5);
      expect(cues[0]?.text).toBe('First SRT line.');
    });
  });

  describe('formatVTTTimestamp & formatSRTTimestamp', () => {
    it('formats timestamps with padded double digits and millisecond precision', () => {
      expect(formatVTTTimestamp(3661.05)).toBe('01:01:01.050');
      expect(formatSRTTimestamp(3661.05)).toBe('01:01:01,050');
    });
  });
});
