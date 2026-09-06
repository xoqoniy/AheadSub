// ============================================================
// AheadSub — SRT Generator
// Converts internal SubtitleCue format to SubRip (SRT).
// ============================================================

import type { SubtitleCue } from '../types';

/**
 * Generate a complete SRT file from subtitle cues.
 */
export function generateSRT(cues: SubtitleCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startTime - b.startTime);
  let srt = '';

  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i]!;
    srt += `${i + 1}\n`;
    srt += `${formatTimestamp(cue.startTime)} --> ${formatTimestamp(cue.endTime)}\n`;
    srt += `${cue.text}\n\n`;
  }

  return srt;
}

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm (comma separator).
 */
function formatTimestamp(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return (
    h.toString().padStart(2, '0') + ':' +
    m.toString().padStart(2, '0') + ':' +
    s.toString().padStart(2, '0') + ',' +
    ms.toString().padStart(3, '0')
  );
}
