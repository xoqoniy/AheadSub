// ============================================================
// AheadSub — VTT Parser
// Parses WebVTT files into internal SubtitleCue format.
// Also supports SRT parsing.
// ============================================================

import type { SubtitleCue } from '../core/types';

/**
 * Parse a WebVTT string into SubtitleCue array.
 */
export function parseVTT(vttContent: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let i = 0;

  // Skip BOM
  if (lines[0]?.charCodeAt(0) === 0xFEFF) {
    lines[0] = lines[0].substring(1);
  }

  // Skip WEBVTT header
  if (lines[i]?.startsWith('WEBVTT')) {
    i++;
    // Skip header metadata until blank line
    while (i < lines.length && lines[i]?.trim() !== '') {
      i++;
    }
    i++; // skip blank line
  }

  while (i < lines.length) {
    // Skip blank lines
    while (i < lines.length && lines[i]?.trim() === '') {
      i++;
    }
    if (i >= lines.length) break;

    // Try to read a cue
    let cueId = '';

    // Check if this line is a cue ID (doesn't contain -->)
    if (lines[i] && !lines[i].includes('-->')) {
      cueId = lines[i].trim();
      i++;
    }

    // Parse timestamp line
    if (i >= lines.length || !lines[i]?.includes('-->')) {
      i++;
      continue;
    }

    const timestampLine = lines[i]!;
    i++;

    const timestamps = parseTimestampLine(timestampLine);
    if (!timestamps) continue;

    // Collect text lines until blank line
    const textLines: string[] = [];
    while (i < lines.length && lines[i]?.trim() !== '') {
      textLines.push(lines[i]!.trim());
      i++;
    }

    const text = textLines.join('\n');
    if (text) {
      cues.push({
        id: cueId || `cue-${cues.length}`,
        startTime: timestamps.start,
        endTime: timestamps.end,
        text: stripVTTTags(text),
        words: [],
      });
    }
  }

  return cues;
}

/**
 * Parse an SRT string into SubtitleCue array.
 */
export function parseSRT(srtContent: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = srtContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 2) continue;

    let lineIdx = 0;

    // First line might be the index number
    const firstLine = lines[lineIdx]!.trim();
    let cueId = '';
    if (/^\d+$/.test(firstLine)) {
      cueId = firstLine;
      lineIdx++;
    }

    // Timestamp line
    if (lineIdx >= lines.length) continue;
    const timestampLine = lines[lineIdx]!;
    lineIdx++;

    // SRT uses comma instead of period for ms
    const timestamps = parseTimestampLine(timestampLine.replace(/,/g, '.'));
    if (!timestamps) continue;

    // Text lines
    const textLines = lines.slice(lineIdx);
    const text = textLines.join('\n').trim();

    if (text) {
      cues.push({
        id: cueId || `cue-${cues.length}`,
        startTime: timestamps.start,
        endTime: timestamps.end,
        text: stripHTMLTags(text),
        words: [],
      });
    }
  }

  return cues;
}

/**
 * Parse a timestamp line like "00:01:23.456 --> 00:01:26.789"
 */
function parseTimestampLine(line: string): { start: number; end: number } | null {
  const match = line.match(
    /(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(\d{1,2}:)?(\d{2}):(\d{2})[.,](\d{3})/
  );

  if (!match) return null;

  const startHours = match[1] ? parseInt(match[1]) : 0;
  const startMinutes = parseInt(match[2]!);
  const startSeconds = parseInt(match[3]!);
  const startMs = parseInt(match[4]!);

  const endHours = match[5] ? parseInt(match[5]) : 0;
  const endMinutes = parseInt(match[6]!);
  const endSeconds = parseInt(match[7]!);
  const endMs = parseInt(match[8]!);

  const start = startHours * 3600 + startMinutes * 60 + startSeconds + startMs / 1000;
  const end = endHours * 3600 + endMinutes * 60 + endSeconds + endMs / 1000;

  return { start, end };
}

/**
 * Strip VTT formatting tags like <b>, <i>, <c.class>, etc.
 */
function stripVTTTags(text: string): string {
  return text.replace(/<\/?[^>]+>/g, '').trim();
}

/**
 * Strip HTML tags from SRT text.
 */
function stripHTMLTags(text: string): string {
  return text.replace(/<\/?[^>]+>/g, '').trim();
}

/**
 * Format seconds to VTT timestamp string.
 */
export function formatVTTTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

/**
 * Format seconds to SRT timestamp string (uses comma).
 */
export function formatSRTTimestamp(seconds: number): string {
  return formatVTTTimestamp(seconds).replace('.', ',');
}
