import { describe, it, expect } from 'vitest';
import { isVagueOpportunity } from '../lib/lean/opportunity';
import { isResearchable } from '../lib/lean/research';

describe('radar vagueness gate', () => {
  it('rejects a short meme tweet (the "make no mistakes" case)', () => {
    expect(isVagueOpportunity('make no mistakes', 'photo', { role: 'meme_reaction', description: 'a deadpan man at a laptop' })).toBe(true);
  });
  it('rejects very short text with no concrete vision', () => {
    expect(isVagueOpportunity('big if true', 'text', null)).toBe(true);
  });
  it('allows a substantive text tweet', () => {
    expect(isVagueOpportunity('OpenAI just shipped structured outputs for the API and it changes how we build agents end to end', 'text', null)).toBe(false);
  });
  it('allows a short tweet when vision found a concrete demo', () => {
    expect(isVagueOpportunity('look at this', 'video', { role: 'demo', description: 'a screen recording demonstrating a new VS Code AI autocomplete feature in action' })).toBe(false);
  });
});

describe('deep-research researchable guard', () => {
  it('rejects vague short fragments', () => {
    expect(isResearchable('make no mistakes')).toBe(false);
    expect(isResearchable('Mythos, regulate something.')).toBe(false);
  });
  it('accepts a concrete topic', () => {
    expect(isResearchable('How does OpenAI structured outputs JSON schema enforcement work in the API')).toBe(true);
  });
});
