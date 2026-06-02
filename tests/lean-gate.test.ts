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

  it('rejects arabic content in an english profile', () => {
    const r = gateSuggestion('هذه تغريدة بالعربية وليست مسموحة في المحتوى المنشور', 280, 'en');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('arabic_in_english_profile');
  });

  it('accepts arabic content in an arabic profile but rejects english there', () => {
    expect(gateSuggestion('أدوات الذكاء الاصطناعي الجديدة تغيّر طريقة بناء المنتجات فعلاً', 280, 'ar').ok).toBe(true);
    const r = gateSuggestion('This is english but the profile expects arabic content', 280, 'ar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('expected_arabic');
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

  it('blocks fabricated statistics with no source', () => {
    expect(gateSuggestion('Studies show AI agents cut support costs dramatically for teams').ok).toBe(false);
    expect(gateSuggestion('This makes engineers 10x faster at writing boilerplate code').ok).toBe(false);
    expect(gateSuggestion('Productivity increased by 40% after switching their whole stack').ok).toBe(false);
  });

  it('allows a numeric claim when a source link is present', () => {
    expect(gateSuggestion('Adoption grew by 30% per their report https://example.com/report here').ok).toBe(true);
  });

  it('detects near duplicates', () => {
    const recent = ['Most AI agents are just a for loop with extra steps honestly'];
    expect(isNearDuplicate('Most AI agents are just a for loop with extra steps honestly', recent)).toBe(true);
    expect(isNearDuplicate('A completely different thought about design systems', recent)).toBe(false);
  });
});
