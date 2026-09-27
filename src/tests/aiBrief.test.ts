import { describe, it, expect } from 'vitest';
import { clampScore, coerceBrief, extractJson } from '@/lib/services/aiBrief';

const MODEL = 'openai/gpt-oss-120b';

describe('extractJson', () => {
  it('parses a clean object', () => {
    expect(extractJson('{"summary":"a","score":40}')).toEqual({ summary: 'a', score: 40 });
  });

  it('recovers an object wrapped in markdown fences', () => {
    const raw = '```json\n{"summary":"a","score":10,"factors":[]}\n```';
    expect(extractJson(raw)).toEqual({ summary: 'a', score: 10, factors: [] });
  });

  it('recovers an object narrated on both sides', () => {
    const raw = 'Sure, here is the brief:\n{"summary":"a","score":7}\nHope that helps!';
    expect(extractJson(raw)).toEqual({ summary: 'a', score: 7 });
  });

  it('keeps braces that appear inside string values', () => {
    const raw = '{"summary":"wants a 2 BHK {under construction}","score":5}';
    expect(extractJson(raw).summary).toBe('wants a 2 BHK {under construction}');
  });

  it('throws on a truncated reasoning response', () => {
    expect(() => extractJson('{"summary":"half a th')).toThrow();
  });
});

describe('clampScore', () => {
  it('clamps above the range', () => {
    expect(clampScore(140)).toBe(100);
  });

  it('clamps below the range', () => {
    expect(clampScore(-4)).toBe(0);
  });

  it('rounds to an integer', () => {
    expect(clampScore(67.6)).toBe(68);
  });
});

describe('coerceBrief', () => {
  it('normalises a well-formed brief', () => {
    const b = coerceBrief(
      { summary: '  Wants a 2 BHK.  ', score: 72, factors: [' website lead ', 'budget stated'] },
      MODEL,
    );
    expect(b.summary).toBe('Wants a 2 BHK.');
    expect(b.score).toBe(72);
    expect(b.factors).toEqual(['website lead', 'budget stated']);
    expect(b.source).toBe('groq');
    expect(b.model).toBe(MODEL);
    expect(Date.parse(b.generatedAt)).not.toBeNaN();
  });

  it('rejects a response with no summary instead of storing a blank brief', () => {
    expect(() => coerceBrief({ score: 50, factors: [] }, MODEL)).toThrow(/no summary/i);
  });

  it('rejects a non-string summary', () => {
    expect(() => coerceBrief({ summary: 42 }, MODEL)).toThrow(/no summary/i);
  });

  it('falls back to 0 for a missing or unparseable score', () => {
    expect(coerceBrief({ summary: 'a' }, MODEL).score).toBe(0);
    expect(coerceBrief({ summary: 'a', score: 'very high' }, MODEL).score).toBe(0);
  });

  it('clamps an out-of-range score the model invented', () => {
    expect(coerceBrief({ summary: 'a', score: 1000 }, MODEL).score).toBe(100);
  });

  it('drops non-string and blank factors', () => {
    const b = coerceBrief({ summary: 'a', factors: ['ok', '', 7, null, 'fine'] }, MODEL);
    expect(b.factors).toEqual(['ok', 'fine']);
  });

  it('keeps at most five factors', () => {
    const b = coerceBrief({ summary: 'a', factors: ['1', '2', '3', '4', '5', '6', '7'] }, MODEL);
    expect(b.factors).toHaveLength(5);
  });

  it('survives a missing factors array', () => {
    expect(coerceBrief({ summary: 'a' }, MODEL).factors).toEqual([]);
  });
});
