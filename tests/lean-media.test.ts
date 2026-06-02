import { describe, it, expect } from 'vitest';
import { detectMediaType, extractMediaUrl } from '../lib/lean/harvest';

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

describe('media url extraction (for vision)', () => {
  it('extracts photo url', () => {
    expect(extractMediaUrl({ extended_entities: { media: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/x.jpg' }] } })).toBe('https://pbs.twimg.com/x.jpg');
  });
  it('extracts the thumbnail for a video/gif', () => {
    expect(extractMediaUrl({ extended_entities: { media: [{ type: 'video', media_url_https: 'https://pbs.twimg.com/poster.jpg' }] } })).toBe('https://pbs.twimg.com/poster.jpg');
  });
  it('returns null when there is no media', () => {
    expect(extractMediaUrl({ text: 'no media' })).toBeNull();
  });
});
