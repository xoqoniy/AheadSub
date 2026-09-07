// ============================================================
// AheadSub — Noise & Hallucination Filter
// Filters non-speech noise annotations, audio hallucinations,
// and background sound descriptions (e.g. music, laughter, sighs).
// ============================================================

export const NOISE_KEYWORDS_REGEX =
  /[\(\[\{][^\)\]\}]*\b(music|silence|noise|laughter|laughing|laughs|laugh|applause|sobbing|coughing|cough|sound|sounds|tag|unk|blank_audio|speaking_foreign|voice|voices|gasp|gasping|sigh|sighs|screaming|scream|screams|crying|cries|groan|groans|cheering|cheer|whispering|whisper|whispers|chuckle|chuckles|breathing|breath|chatter|indistinct|static|background|singing|playing|inaudible|unintelligible)\b[^\)\]\}]*[\)\]\}]/gi;

export const STANDALONE_NOISE_TOKENS =
  /\b(BLANK_AUDIO|MUSIC|SILENCE|NOISE|LAUGHTER|APPLAUSE|SOBBING|COUGHING|SOUND|TAG|UNK|SPEAKING_FOREIGN)\b/gi;

export const NOISE_WORDS = new Set([
  'blank_audio', 'music', 'silence', 'noise', 'laughter', 'laughing', 'laughs', 'laugh',
  'applause', 'sobbing', 'coughing', 'cough', 'sound', 'sounds', 'tag', 'unk',
  'speaking_foreign', 'voice', 'voices', 'gasp', 'gasping', 'sigh', 'sighs',
  'screaming', 'scream', 'screams', 'crying', 'cries', 'groan', 'groans',
  'cheering', 'cheer', 'whispering', 'whisper', 'whispers', 'chuckle', 'chuckles',
  'breathing', 'breath', 'chatter', 'indistinct', 'static', 'background',
  'singing', 'playing', 'inaudible', 'unintelligible'
]);

/**
 * Strip parenthesized/bracketed non-verbal noise descriptions from cue text.
 * Preserves actual spoken dialogue in parentheses like "(What happened?)".
 */
export function stripNoiseAnnotations(text: string): string {
  if (!text) return '';
  let clean = text.replace(NOISE_KEYWORDS_REGEX, '');
  clean = clean.replace(STANDALONE_NOISE_TOKENS, '');
  return clean.replace(/\s+/g, ' ').trim();
}

/**
 * Check if text consists entirely of noise annotations, silence, or noise words.
 */
export function isNoiseOrBlankText(text: string): boolean {
  if (!text || !text.trim()) return true;
  const clean = stripNoiseAnnotations(text);
  if (clean.length === 0) return true;

  // Extract all words (letters only)
  const words = clean
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (words.length > 0 && words.every((w) => NOISE_WORDS.has(w))) {
    return true;
  }

  return false;
}

/**
 * Calculate Root Mean Square (RMS) volume energy of a PCM Float32 audio chunk.
 */
export function calculateAudioRMS(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquare = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumSquare += s * s;
  }
  return Math.sqrt(sumSquare / samples.length);
}
