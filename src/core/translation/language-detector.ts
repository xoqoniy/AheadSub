// ============================================================
// AheadSub — Language Detector
// Uses Whisper's built-in language detection to identify
// the spoken language in audio.
// ============================================================

import { SUPPORTED_LANGUAGES } from '../constants';

/**
 * Detect the spoken language from the first transcription result.
 * Whisper returns a language code with each transcription.
 */
export function detectLanguageFromResult(
  whisperLanguage: string | undefined
): { code: string; name: string; confidence: number } {
  if (!whisperLanguage) {
    return { code: 'unknown', name: 'Unknown', confidence: 0 };
  }

  // Whisper returns ISO 639-1 codes
  const code = whisperLanguage.toLowerCase();
  const name = SUPPORTED_LANGUAGES[code] || whisperLanguage;

  return {
    code,
    name,
    confidence: 0.9, // Whisper's language detection is generally reliable
  };
}

/**
 * Check if translation is needed between spoken and subtitle languages.
 */
export function needsTranslation(spokenLang: string, subtitleLang: string): boolean {
  if (spokenLang === 'auto' || subtitleLang === 'auto') return false; // Can't determine yet
  if (!spokenLang || !subtitleLang) return false;
  return spokenLang !== subtitleLang;
}

/**
 * Get the Whisper language code for the transcription task.
 * Returns undefined for auto-detect.
 */
export function getWhisperLanguageCode(language: string): string | undefined {
  if (language === 'auto') return undefined;
  return language;
}
