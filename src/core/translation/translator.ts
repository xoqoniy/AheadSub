// ============================================================
// AheadSub — Translator
// Handles translation of subtitle cues from one language
// to another. Supports local (Transformers.js) and optional
// cloud translation APIs.
// ============================================================

import type { SubtitleCue, AheadSubSettings } from '../types';

export type TranslationMode = 'local' | 'cloud' | 'none';

export interface TranslatorConfig {
  mode: TranslationMode;
  sourceLang: string;
  targetLang: string;
  cloudApiKey?: string;
  cloudApiProvider?: 'google' | 'deepl';
}

/**
 * Translate subtitle cues from source language to target language.
 * Preserves original timestamps.
 */
export async function translateCues(
  cues: SubtitleCue[],
  config: TranslatorConfig
): Promise<SubtitleCue[]> {
  if (config.mode === 'none') return cues;
  if (config.sourceLang === config.targetLang) return cues;

  // Batch the text for efficiency
  const texts = cues.map(c => c.text);

  let translations: string[];

  if (config.mode === 'cloud' && config.cloudApiKey) {
    translations = await translateCloud(texts, config);
  } else {
    translations = await translateLocal(texts, config);
  }

  // Create translated cues with preserved timestamps
  return cues.map((cue, i) => ({
    ...cue,
    originalText: cue.text,
    text: translations[i] || cue.text,
    // Keep all timing information unchanged
    words: cue.words, // Original word-level timestamps preserved
  }));
}

/**
 * Local translation using Transformers.js with Helsinki-NLP OPUS-MT models.
 * Note: These models are large (~200MB) and must be downloaded on first use.
 */
async function translateLocal(
  texts: string[],
  config: TranslatorConfig
): Promise<string[]> {
  try {
    const { pipeline } = await import('@huggingface/transformers');

    // Determine the OPUS-MT model for this language pair
    const modelId = getOpusMTModel(config.sourceLang, config.targetLang);

    if (!modelId) {
      console.warn(
        `[AheadSub] No local translation model available for ${config.sourceLang} → ${config.targetLang}. ` +
        `Returning original text.`
      );
      return texts;
    }

    const translator = await pipeline('translation', modelId, {
      device: 'wasm',
    });

    const results: string[] = [];

    // Translate in batches to avoid memory issues
    const batchSize = 10;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async (text) => {
          const result: any = await translator(text);
          return result[0]?.translation_text || text;
        })
      );
      results.push(...batchResults);
    }

    return results;
  } catch (error) {
    console.error('[AheadSub] Local translation failed:', error);
    return texts; // Return originals on failure
  }
}

/**
 * Cloud translation using Google Translate or DeepL API.
 */
async function translateCloud(
  texts: string[],
  config: TranslatorConfig
): Promise<string[]> {
  if (config.cloudApiProvider === 'deepl') {
    return translateDeepL(texts, config);
  }
  return translateGoogle(texts, config);
}

async function translateGoogle(texts: string[], config: TranslatorConfig): Promise<string[]> {
  try {
    const response = await fetch(
      `https://translation.googleapis.com/language/translate/v2`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: texts,
          source: config.sourceLang,
          target: config.targetLang,
          key: config.cloudApiKey,
          format: 'text',
        }),
      }
    );

    if (!response.ok) {
      throw new Error(`Google Translate API error: ${response.status}`);
    }

    const data = await response.json();
    return data.data.translations.map((t: any) => t.translatedText);
  } catch (error) {
    console.error('[AheadSub] Google Translate failed:', error);
    return texts;
  }
}

async function translateDeepL(texts: string[], config: TranslatorConfig): Promise<string[]> {
  try {
    const response = await fetch('https://api-free.deepl.com/v2/translate', {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${config.cloudApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: texts,
        source_lang: config.sourceLang.toUpperCase(),
        target_lang: config.targetLang.toUpperCase(),
      }),
    });

    if (!response.ok) {
      throw new Error(`DeepL API error: ${response.status}`);
    }

    const data = await response.json();
    return data.translations.map((t: any) => t.text);
  } catch (error) {
    console.error('[AheadSub] DeepL translation failed:', error);
    return texts;
  }
}

/**
 * Get the Helsinki-NLP OPUS-MT model ID for a language pair.
 * Returns null if no model is available.
 */
function getOpusMTModel(source: string, target: string): string | null {
  // Common OPUS-MT models available on Hugging Face
  const modelMap: Record<string, string> = {
    'ja-en': 'Helsinki-NLP/opus-mt-ja-en',
    'en-ja': 'Helsinki-NLP/opus-mt-en-jap',
    'ja-ru': 'Helsinki-NLP/opus-mt-ja-ru',
    'ru-en': 'Helsinki-NLP/opus-mt-ru-en',
    'en-ru': 'Helsinki-NLP/opus-mt-en-ru',
    'zh-en': 'Helsinki-NLP/opus-mt-zh-en',
    'en-zh': 'Helsinki-NLP/opus-mt-en-zh',
    'ko-en': 'Helsinki-NLP/opus-mt-ko-en',
    'en-ko': 'Helsinki-NLP/opus-mt-en-ko',
    'de-en': 'Helsinki-NLP/opus-mt-de-en',
    'en-de': 'Helsinki-NLP/opus-mt-en-de',
    'fr-en': 'Helsinki-NLP/opus-mt-fr-en',
    'en-fr': 'Helsinki-NLP/opus-mt-en-fr',
    'es-en': 'Helsinki-NLP/opus-mt-es-en',
    'en-es': 'Helsinki-NLP/opus-mt-en-es',
  };

  // Direct pair
  const key = `${source}-${target}`;
  if (modelMap[key]) return modelMap[key]!;

  // Try via English pivot
  // Source → English, then English → Target
  // (Actual pivot would need two-step translation)
  const toEn = `${source}-en`;
  const fromEn = `en-${target}`;
  if (modelMap[toEn] && modelMap[fromEn]) {
    // Return the first leg — caller would need to chain
    return modelMap[toEn]!;
  }

  return null;
}
