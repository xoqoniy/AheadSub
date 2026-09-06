import { describe, it, expect } from 'vitest';
import { detectCollocations, cleanToken, RUSSIAN_COLLOCATIONS } from '../../collocations';

describe('collocations engine', () => {
  it('cleanToken strips punctuation and lowercases tokens', () => {
    expect(cleanToken('Привет,')).toBe('привет');
    expect(cleanToken('«герой!»')).toBe('герой');
    expect(cleanToken('кабинет...')).toBe('кабинет');
  });

  it('detects 2-word collocations in sentence tokens', () => {
    const tokens = ['Мы', 'пошли', 'в', 'кабинет', 'ректора'];
    const detected = detectCollocations(tokens);

    expect(detected.length).toBeGreaterThan(0);
    const match = detected.find((d) => d.rawText === 'в кабинет ректора' || d.rawText === 'кабинет ректора');
    expect(match).toBeDefined();
    expect(match?.translationUz).toBeDefined();
  });

  it('detects instant Uzbek words and phrases in dictionary', () => {
    expect(RUSSIAN_COLLOCATIONS['главный герой']).toBeDefined();
    expect(RUSSIAN_COLLOCATIONS['главный герой']?.uz).toBe('Bosh qahramon');
  });
});
