import { describe, it, expect } from 'vitest';
import {
  stripNoiseAnnotations,
  isNoiseOrBlankText,
  calculateAudioRMS,
} from '../noise-filter';

describe('noise-filter module', () => {
  describe('stripNoiseAnnotations', () => {
    it('strips sound/noise annotations inside brackets or parentheses', () => {
      expect(stripNoiseAnnotations('(dramatic music playing)')).toBe('');
      expect(stripNoiseAnnotations('(screaming)')).toBe('');
      expect(stripNoiseAnnotations('(sighs) I understand.')).toBe('I understand.');
      expect(stripNoiseAnnotations('[coughing] Excuse me.')).toBe('Excuse me.');
      expect(stripNoiseAnnotations('(soft chuckles)')).toBe('');
      expect(stripNoiseAnnotations('(indistinct chatter)')).toBe('');
    });

    it('preserves spoken conversational dialogue inside parentheses', () => {
      expect(stripNoiseAnnotations('(What happened?)')).toBe('(What happened?)');
      expect(stripNoiseAnnotations('(Что произошло?)')).toBe('(Что произошло?)');
    });
  });

  describe('isNoiseOrBlankText', () => {
    it('identifies background noise, hallucinations, and silence as noise', () => {
      expect(isNoiseOrBlankText('(screaming)')).toBe(true);
      expect(isNoiseOrBlankText('(dramatic music playing)')).toBe(true);
      expect(isNoiseOrBlankText('sighs')).toBe(true);
      expect(isNoiseOrBlankText('[BLANK_AUDIO]')).toBe(true);
      expect(isNoiseOrBlankText('laughter')).toBe(true);
      expect(isNoiseOrBlankText('  ')).toBe(true);
    });

    it('returns false for actual spoken sentences and dialogue', () => {
      expect(isNoiseOrBlankText('Hello, welcome to the show.')).toBe(false);
      expect(isNoiseOrBlankText('(What happened?)')).toBe(false);
      expect(isNoiseOrBlankText('Я не знаю что делать.')).toBe(false);
    });
  });

  describe('calculateAudioRMS', () => {
    it('returns 0 for empty or silent audio samples', () => {
      const silence = new Float32Array(1000).fill(0);
      expect(calculateAudioRMS(silence)).toBe(0);
    });

    it('calculates RMS volume for active audio samples', () => {
      const active = new Float32Array([0.1, -0.1, 0.1, -0.1]);
      expect(calculateAudioRMS(active)).toBeCloseTo(0.1);
    });
  });
});
