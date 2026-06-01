import { describe, it, expect } from 'vitest';
import { detectMediaType } from '../lib/lean/harvest';

describe('media detection', () => {
  it('detects video over photo', () => {
    const t = { extended_entities: { media: [{ type: 'photo' }, { type: 'video' }] } };
    expect(detectMediaType(t)).toBe('video');
  });
  it('detects animated gif', () => {
    expect(detectMediaType({ extended_entities: { media: [{ type: 'animated_gif' }] } })).toBe('gif');
  });
  it('detects photo', () => {
    expect(detectMediaType({ entities: { media: [{ type: 'photo' }] } })).toBe('photo');
  });
  it('falls back to text when no media', () => {
    expect(detectMediaType({ text: 'just words' })).toBe('text');
    expect(detectMediaType({})).toBe('text');
  });
});
