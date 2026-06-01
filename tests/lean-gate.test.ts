import { describe, it, expect } from 'vitest';
import { gateSuggestion, isNearDuplicate } from '../lib/lean/gate';

describe('lean gate', () => {
  it('accepts a normal english tweet', () => {
    expect(gateSuggestion('Most "AI agents" are just a for-loop with extra steps. The hard part was never the loop.').ok).toBe(true);
  });

  it('rejects empty and too-short', () => {
    expect(gateSuggestion('').ok).toBe(false);
    expect(gateSuggestion('ok').ok).toBe(false);
  });

  it('rejects over length', () => {
    const long = 'a'.repeat(281);
    const r = gateSuggestion(long);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('280');
  });

  it('rejects arabic content (must be english only)', () => {
    const r = gateSuggestion('هذه تغريدة بالعربية وليست مسموحة في المحتوى المنشور');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('arabic_detected');
  });

  it('rejects json leakage', () => {
    expect(gateSuggestion('{"text":"hello there friend"}').ok).toBe(false);
    expect(gateSuggestion('"reply": "this is the model leaking structure"').ok).toBe(false);
  });

  it('rejects engagement bait', () => {
    expect(gateSuggestion('Hot take: AI will change everything forever and ever').ok).toBe(false);
    expect(gateSuggestion('This is huge for the whole industry right now').ok).toBe(false);
    expect(gateSuggestion('Pretty interesting stuff happening here. thoughts?').ok).toBe(false);
  });

  it('detects near duplicates', () => {
    const recent = ['Most AI agents are just a for loop with extra steps honestly'];
    expect(isNearDuplicate('Most AI agents are just a for loop with extra steps honestly', recent)).toBe(true);
    expect(isNearDuplicate('A completely different thought about design systems', recent)).toBe(false);
  });
});
