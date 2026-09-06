// ============================================================
// AheadSub — VTT Generator
// Converts internal SubtitleCue format to WebVTT.
// ============================================================

import type { SubtitleCue } from '../types';

/**
 * Generate a complete WebVTT file from subtitle cues.
 */
export function generateVTT(cues: SubtitleCue[]): string {
  const sorted = [...cues].sort((a, b) => a.startTime - b.startTime);

  let vtt = 'WEBVTT\n';
  vtt += 'Kind: captions\n';
  vtt += 'Language: auto\n\n';

  for (const cue of sorted) {
    vtt += `${cue.id}\n`;
    vtt += `${formatTimestamp(cue.startTime)} --> ${formatTimestamp(cue.endTime)}\n`;
    vtt += `${cue.text}\n\n`;
  }

  return vtt;
}

/**
 * Format seconds to VTT timestamp: HH:MM:SS.mmm
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
    s.toString().padStart(2, '0') + '.' +
    ms.toString().padStart(3, '0')
  );
}
