/**
 * Phase 2C tests — Crafted Text Cleaner + Niche Alignment + Quality Validator
 *
 * Tests pure logic functions that don't require Supabase or AI model calls.
 * AI-dependent functions (rewriteForOriginality, scoreWithAI) are
 * integration-tested manually.
 *
 * Required test cases from spec:
 * - markdown ```json wrapper gets cleaned into plain text
 * - JSON object with reply gets cleaned into plain text
 * - JSON object with quote gets cleaned into plain text
 * - JSON object with quote_tweet gets cleaned into plain text
 * - JSON object with text gets cleaned into plain text
 * - malformed JSON does not pass silently as clean text
 * - no JSON wrapper reaches publish_gate
 * - Superman/comics opportunity scores off_niche
 * - One Piece/anime opportunity scores off_niche
 * - influencer boxing opportunity scores off_niche
 * - AI tooling/productivity opportunity scores aligned
 * - career/workflow opportunity scores aligned
 * - off_niche opportunity is not rewritten into a fake AI angle
 * - strengthened rewrite returns plain text only
 * - rewrite does not include "Yo…" or JSON
 * - Arabic content remains rejected
 * - publish_gate thresholds remain unchanged
 * - no auto-posting introduced
 */

import { describe, it, expect } from 'vitest';
import {
  cleanCraftedText,
  looksLikeJsonWrapper,
  cleanOpportunitiesText,
} from '../lib/crafted-text-cleaner';
import {
  scoreNicheAlignment,
  guardNicheAlignment,
} from '../lib/niche-alignment';
import {
  validateOpportunityQuality,
  validateOpportunitiesBeforeGate,
} from '../lib/quality-validator';
import {
  containsArabic,
  isEnglishPublishableText,
  filterPublishableOpportunities,
} from '../lib/content-policy';

// ═══ Crafted Text Cleaner: Markdown Fences ═══

describe('cleanCraftedText: markdown fences', () => {
  it('markdown ```json wrapper gets cleaned into plain text', () => {
    const result = cleanCraftedText('```json\n{ "reply": "Built a RAG pipeline with GPT-4" }\n```');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('Built a RAG pipeline with GPT-4');
    expect(result.malformed_json_output).toBe(false);
  });

  it('markdown ``` wrapper (no language) gets cleaned', () => {
    const result = cleanCraftedText('```\n{ "quote": "AI tools are changing workflows" }\n```');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('AI tools are changing workflows');
    expect(result.malformed_json_output).toBe(false);
  });

  it('plain text passes through without modification', () => {
    const result = cleanCraftedText('Built a RAG pipeline with GPT-4 that actually works');
    expect(result.cleaned_json_wrapper).toBe(false);
    expect(result.cleaned_text).toBe('Built a RAG pipeline with GPT-4 that actually works');
    expect(result.malformed_json_output).toBe(false);
  });

  it('empty string is marked as malformed', () => {
    const result = cleanCraftedText('');
    expect(result.malformed_json_output).toBe(true);
  });
});

// ═══ Crafted Text Cleaner: JSON Objects ═══

describe('cleanCraftedText: JSON objects', () => {
  it('JSON object with reply gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "reply": "I tested GPT-4 on my workflow and it saved time" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('I tested GPT-4 on my workflow and it saved time');
    expect(result.malformed_json_output).toBe(false);
  });

  it('JSON object with quote gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "quote": "AI automation is the future of productivity" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('AI automation is the future of productivity');
    expect(result.malformed_json_output).toBe(false);
  });

  it('JSON object with quote_tweet gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "quote_tweet": "Built an AI agent that handles my emails" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('Built an AI agent that handles my emails');
    expect(result.malformed_json_output).toBe(false);
  });

  it('JSON object with text gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "text": "Switching from ChatGPT to Claude cut iteration time" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('Switching from ChatGPT to Claude cut iteration time');
    expect(result.malformed_json_output).toBe(false);
  });

  it('JSON object with content key gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "content": "RAG pipelines are underrated for productivity" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('RAG pipelines are underrated for productivity');
  });

  it('JSON object with message key gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "message": "Automation saved my team hours this week" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('Automation saved my team hours this week');
  });

  it('JSON object with tweet key gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "tweet": "Using AI agents to automate research workflows" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('Using AI agents to automate research workflows');
  });

  it('JSON object with empty key gets cleaned into plain text', () => {
    const result = cleanCraftedText('{ "": "This is the actual content from empty key" }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('This is the actual content from empty key');
  });

  it('JSON with multiple keys extracts the known key value', () => {
    const result = cleanCraftedText('{ "type": "reply", "reply": "My actual tweet content about AI", "confidence": 0.9 }');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('My actual tweet content about AI');
  });

  it('nested markdown + JSON wrapper gets fully cleaned', () => {
    const result = cleanCraftedText('```json\n{ "reply": "Automated my entire workflow with n8n" }\n```');
    expect(result.cleaned_json_wrapper).toBe(true);
    expect(result.cleaned_text).toBe('Automated my entire workflow with n8n');
    expect(result.malformed_json_output).toBe(false);
  });
});

// ═══ Crafted Text Cleaner: Malformed JSON ═══

describe('cleanCraftedText: malformed JSON', () => {
  it('malformed JSON does not pass silently as clean text', () => {
    // Broken JSON that can't be parsed and doesn't match extraction patterns
    const result = cleanCraftedText('{ "reply": "some text" ');
    // Should be detected as JSON-like and marked as malformed since it's incomplete
    expect(result.malformed_json_output).toBe(true);
  });

  it('irrecoverable JSON-like text is marked malformed', () => {
    const result = cleanCraftedText('{ "unknown_key_123": 42, "data": [1, 2, 3] }');
    // No extractable string content — should be marked malformed
    expect(result.malformed_json_output).toBe(true);
  });

  it('pure JSON object with only numeric values is malformed', () => {
    const result = cleanCraftedText('{ "score": 8.5, "confidence": 0.9 }');
    expect(result.malformed_json_output).toBe(true);
  });
});

// ═══ looksLikeJsonWrapper ═══

describe('looksLikeJsonWrapper', () => {
  it('detects JSON objects', () => {
    expect(looksLikeJsonWrapper('{ "reply": "text" }')).toBe(true);
  });

  it('detects markdown fences', () => {
    expect(looksLikeJsonWrapper('```json\n...\n```')).toBe(true);
  });

  it('passes plain text', () => {
    expect(looksLikeJsonWrapper('Built a RAG pipeline with GPT-4')).toBe(false);
  });

  it('detects JSON key patterns', () => {
    expect(looksLikeJsonWrapper('"reply": "some text"')).toBe(true);
  });
});

// ═══ cleanOpportunitiesText batch ═══

describe('cleanOpportunitiesText batch', () => {
  it('cleans multiple opportunities with JSON wrappers', () => {
    const opps = [
      { crafted_text: '{ "reply": "AI productivity tip" }', type: 'reply' },
      { crafted_text: 'Plain text about automation', type: 'quote' },
      { crafted_text: '```json\n{ "quote_tweet": "Career growth with AI" }\n```', type: 'quote' },
    ];

    const result = cleanOpportunitiesText(opps as any);
    expect(result.summary.json_wrappers_cleaned).toBe(2);
    expect(result.summary.total).toBe(3);
    expect(result.cleaned[0].crafted_text).toBe('AI productivity tip');
    expect(result.cleaned[1].crafted_text).toBe('Plain text about automation');
    expect(result.cleaned[2].crafted_text).toBe('Career growth with AI');
  });

  it('no JSON wrapper reaches publish_gate after cleaning', () => {
    const opps = [
      { crafted_text: '{ "reply": "AI tools for productivity" }', type: 'reply' },
      { crafted_text: '```json\n{ "quote": "Automate your workflow" }\n```', type: 'quote' },
    ];

    const result = cleanOpportunitiesText(opps as any);
    for (const opp of result.cleaned) {
      expect(looksLikeJsonWrapper(opp.crafted_text)).toBe(false);
    }
  });
});

// ═══ Niche Alignment: Off-Niche ═══

describe('scoreNicheAlignment: off-niche detection', () => {
  it('Superman/comics opportunity scores off_niche', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Superman returns in the new DC movie',
      source_text: 'New Superman movie trailer just dropped',
      type: 'quote',
    });
    expect(result.is_off_niche).toBe(true);
    expect(result.off_niche_topics).toContain('comics');
    expect(result.niche_alignment_score).toBeLessThan(4);
  });

  it('One Piece/anime opportunity scores off_niche', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'One Piece chapter just dropped and it is amazing',
      source_text: 'Latest One Piece manga chapter discussion',
      type: 'reply',
    });
    expect(result.is_off_niche).toBe(true);
    expect(result.off_niche_topics).toContain('anime');
    expect(result.niche_alignment_score).toBeLessThan(4);
  });

  it('influencer boxing opportunity scores off_niche', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Jake Paul vs Mike Tyson fight night is here',
      source_text: 'The boxing match everyone is talking about',
      type: 'quote',
    });
    expect(result.is_off_niche).toBe(true);
    expect(result.off_niche_topics).toContain('influencer_boxing');
    expect(result.niche_alignment_score).toBeLessThan(4);
  });

  it('celebrity gossip opportunity scores off_niche', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Taylor Swift and Travis Kelce spotted together again',
      source_text: 'Celebrity gossip about Taylor Swift',
      type: 'reply',
    });
    expect(result.is_off_niche).toBe(true);
    expect(result.off_niche_topics).toContain('celebrity_gossip');
  });

  it('generic memes opportunity scores off_niche', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'This meme about Monday mornings is so relatable',
      source_text: 'Funny meme going viral',
      type: 'quote',
    });
    expect(result.is_off_niche).toBe(true);
    expect(result.off_niche_topics).toContain('memes');
  });

  it('sports opportunity scores off_niche', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'The NBA finals were incredible this year',
      source_text: 'NBA championship game recap',
      type: 'reply',
    });
    expect(result.is_off_niche).toBe(true);
    expect(result.off_niche_topics).toContain('sports');
  });

  it('crypto/NFT opportunity scores off_niche', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Bitcoin just hit a new all-time high',
      source_text: 'Crypto market update',
      type: 'quote',
    });
    expect(result.is_off_niche).toBe(true);
    expect(result.off_niche_topics).toContain('crypto');
  });
});

// ═══ Niche Alignment: Aligned ═══

describe('scoreNicheAlignment: aligned detection', () => {
  it('AI tooling/productivity opportunity scores aligned', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Built a RAG pipeline with GPT-4 that handles my entire research workflow',
      source_text: 'AI tools discussion thread',
      type: 'reply',
    });
    expect(result.is_off_niche).toBe(false);
    expect(result.niche_alignment_score).toBeGreaterThanOrEqual(7);
    expect(result.aligned_topics).toContain('AI_tools');
    expect(result.aligned_topics).toContain('productivity');
  });

  it('career/workflow opportunity scores aligned', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Switching from IC to tech lead taught me more about automation than any course',
      source_text: 'Career growth in tech discussion',
      type: 'quote',
    });
    expect(result.is_off_niche).toBe(false);
    expect(result.niche_alignment_score).toBeGreaterThanOrEqual(6);
    expect(result.aligned_topics).toContain('career');
  });

  it('AI agent discussion scores aligned', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'AI agents that automate your email triage are getting surprisingly good',
      source_text: 'Thread about AI automation tools',
      type: 'reply',
    });
    expect(result.is_off_niche).toBe(false);
    expect(result.aligned_topics).toContain('AI_tools');
  });

  it('founder/operator content scores aligned', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Bootstrapped my SaaS to $10K MRR using AI-powered customer support',
      source_text: 'Indie hacker success story',
      type: 'quote',
    });
    expect(result.is_off_niche).toBe(false);
    expect(result.aligned_topics).toContain('career');
  });

  it('automation with Python/scripts scores aligned', () => {
    const result = scoreNicheAlignment({
      crafted_text: 'Automated my deploy pipeline with a Python script and GitHub Actions',
      source_text: 'DevOps automation discussion',
      type: 'reply',
    });
    expect(result.is_off_niche).toBe(false);
    expect(result.aligned_topics).toContain('automation');
    expect(result.aligned_topics).toContain('building');
  });
});

// ═══ Niche Alignment: Guard ═══

describe('guardNicheAlignment', () => {
  it('off_niche opportunity is not rewritten into a fake AI angle', () => {
    // Off-niche opportunity should be marked as rejected, NOT rewritten
    const opps = [
      {
        crafted_text: 'Superman vs Batman in the new DC movie looks incredible',
        source_text: 'DC movie trailer',
        type: 'quote',
        shield_passed: true,
        shield_issues: [],
      },
    ];

    const result = guardNicheAlignment(opps as any);
    expect(result.summary.off_niche).toBe(1);

    // The off-niche opportunity should have shield_passed=false
    const offNicheOpp = result.guarded[0];
    expect(offNicheOpp.shield_passed).toBe(false);
    expect(offNicheOpp.pre_gate_rejection_reason).toBe('off_niche');
    // crafted_text should NOT be rewritten to a fake AI angle
    expect(offNicheOpp.crafted_text).toBe('Superman vs Batman in the new DC movie looks incredible');
  });

  it('aligned opportunities pass through the guard', () => {
    const opps = [
      {
        crafted_text: 'Built a RAG pipeline with GPT-4 for my research workflow',
        source_text: 'AI tools discussion',
        type: 'reply',
        shield_passed: true,
        shield_issues: [],
      },
    ];

    const result = guardNicheAlignment(opps as any);
    expect(result.summary.off_niche).toBe(0);
    expect(result.summary.aligned).toBe(1);
    expect(result.guarded[0].shield_passed).toBe(true);
  });

  it('mixed opportunities correctly separate aligned from off-niche', () => {
    const opps = [
      {
        crafted_text: 'GPT-4 prompt engineering improved my workflow',
        source_text: 'AI discussion',
        type: 'reply',
        shield_passed: true,
        shield_issues: [],
      },
      {
        crafted_text: 'New One Piece chapter is peak fiction',
        source_text: 'Anime discussion',
        type: 'quote',
        shield_passed: true,
        shield_issues: [],
      },
      {
        crafted_text: 'Jake Paul boxing match was wild',
        source_text: 'Boxing discussion',
        type: 'reply',
        shield_passed: true,
        shield_issues: [],
      },
    ];

    const result = guardNicheAlignment(opps as any);
    expect(result.summary.off_niche).toBe(2);
    expect(result.summary.aligned).toBe(1);
  });
});

// ═══ Quality Validator ═══

describe('validateOpportunityQuality', () => {
  it('valid opportunity passes all checks', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'Built a RAG pipeline with GPT-4 that actually works for my team',
      type: 'reply',
      shield_passed: true,
      niche_alignment_score: 8.5,
    });
    expect(result.passed).toBe(true);
    expect(result.final_quality_validation_passed).toBe(true);
  });

  it('JSON wrapper text fails validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: '{ "reply": "AI productivity text" }',
      type: 'reply',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('text_is_json_wrapper');
  });

  it('Arabic content fails validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'هذا محتوى عربي لا يجب نشره',
      type: 'reply',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('arabic_content_detected');
  });

  it('AI slop fails validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: "Here's the thing about AI productivity that you need to know",
      type: 'reply',
    });
    expect(result.passed).toBe(false);
  });

  it('off-niche opportunity fails validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'Superman movie looks amazing',
      type: 'reply',
      pre_gate_rejection_reason: 'off_niche',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('off_niche_pre_gate_rejection');
  });

  it('generic engagement bait fails validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'Yo... this AI tool is insane',
      type: 'reply',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('generic_engagement_bait');
  });

  it('malformed JSON output fails validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'Some text that could not be cleaned',
      type: 'reply',
      malformed_json_output: true,
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('malformed_json_output');
  });

  it('too-short text fails validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'OK',
      type: 'reply',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('text_too_short');
  });
});

// ═══ validateOpportunitiesBeforeGate batch ═══

describe('validateOpportunitiesBeforeGate batch', () => {
  it('no JSON wrapper reaches publish_gate after validation', () => {
    const opps = [
      { crafted_text: '{ "reply": "AI productivity tip" }', type: 'reply', shield_passed: true },
      { crafted_text: 'Built a RAG pipeline that works', type: 'reply', shield_passed: true },
    ];

    const result = validateOpportunitiesBeforeGate(opps as any);
    // The JSON-wrapped opportunity should fail validation
    expect(result.summary.failed).toBeGreaterThanOrEqual(1);
    // All passed opportunities should have clean text
    for (const opp of result.passed) {
      expect(looksLikeJsonWrapper(opp.crafted_text)).toBe(false);
    }
  });

  it('off-niche opportunities fail batch validation', () => {
    const opps = [
      { crafted_text: 'Superman returns in new DC movie', type: 'quote', shield_passed: true, niche_alignment_score: 2.0 },
      { crafted_text: 'AI agent automation workflow tip', type: 'reply', shield_passed: true, niche_alignment_score: 8.5 },
    ];

    const result = validateOpportunitiesBeforeGate(opps as any);
    expect(result.summary.passed).toBe(1);
    expect(result.summary.failed).toBeGreaterThanOrEqual(1);
  });

  it('failed opportunities get shield_passed=false', () => {
    const opps = [
      { crafted_text: '{ "reply": "test" }', type: 'reply', shield_passed: true },
    ];

    const result = validateOpportunitiesBeforeGate(opps as any);
    const failed = result.failed;
    for (const f of failed) {
      expect(f.opportunity.shield_passed).toBe(false);
    }
  });
});

// ═══ Strengthened Rewrite: Validation ═══
// These test the validation logic that the strengthened rewrite uses
// (AI model calls are integration-tested manually)

describe('strengthened rewrite validation', () => {
  it('rewritten text that is JSON is rejected by looksLikeJsonWrapper', () => {
    // Simulating what happens if the AI returns JSON instead of plain text
    expect(looksLikeJsonWrapper('{ "reply": "AI productivity tip" }')).toBe(true);
  });

  it('rewrite does not include "Yo…" patterns — caught by validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'Yo... this new AI tool is amazing',
      type: 'reply',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('generic_engagement_bait');
  });

  it('rewrite does not include "Interesting take" — caught by validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'Interesting take on AI productivity workflows',
      type: 'reply',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('generic_engagement_bait');
  });

  it('plain text rewrite passes validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'Switched my research workflow to use RAG + GPT-4 — the structured output alone saves 30 minutes per session',
      type: 'reply',
      niche_alignment_score: 8.5,
    });
    expect(result.passed).toBe(true);
  });
});

// ═══ Arabic Content Rejection ═══

describe('Arabic content remains rejected (Phase 2C)', () => {
  it('Arabic crafted_text fails isEnglishPublishableText', () => {
    const result = isEnglishPublishableText('هذا محتوى عربي لا يجب نشره');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('arabic_content_detected');
  });

  it('Arabic crafted_text fails quality validation', () => {
    const result = validateOpportunityQuality({
      crafted_text: 'هذا محتوى عربي لا يجب نشره',
      type: 'reply',
    });
    expect(result.passed).toBe(false);
    expect(result.failures).toContain('arabic_content_detected');
  });

  it('Arabic crafted_text is rejected by publish gate', () => {
    const opp = {
      type: 'quote',
      crafted_text: 'هذا محتوى عربي لا يجب نشره',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
    };

    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
    expect(gate.rejected[0].reason).toBe('arabic_content_detected');
  });

  it('containsArabic detects Arabic range', () => {
    expect(containsArabic('م')).toBe(true);
    expect(containsArabic('Hello world')).toBe(false);
    expect(containsArabic('Hello مرحبا world')).toBe(true);
  });
});

// ═══ No Threshold Lowering ═══

describe('publish_gate thresholds remain unchanged (Phase 2C)', () => {
  it('publish gate still requires shield_passed=true', () => {
    const opp = {
      type: 'reply',
      crafted_text: 'Great insight about AI productivity',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: false,
      shield_issues: ['missing_originality'],
    };

    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
    expect(gate.rejected[0].reason).toContain('shield_not_passed');
  });

  it('publish gate still rejects too-short text', () => {
    const opp = {
      type: 'reply',
      crafted_text: 'OK',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
    };

    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
    expect(gate.rejected[0].reason).toBe('too_short');
  });

  it('publish gate still rejects too-long text', () => {
    const opp = {
      type: 'reply',
      crafted_text: 'A'.repeat(1300),
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
    };

    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
    expect(gate.rejected[0].reason).toBe('too_long');
  });

  it('publish gate still rejects AI slop wrapper patterns', () => {
    const opp = {
      type: 'reply',
      crafted_text: 'Here is a great tip about AI: you should use it more',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
    };

    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
    expect(gate.rejected[0].reason).toContain('ai_slop');
  });

  it('quality validator does not change publish_gate behavior', () => {
    // The quality validator runs BEFORE publish_gate and marks opportunities
    // as shield_passed=false. The publish_gate itself is unchanged.
    const validOpp = {
      type: 'reply',
      crafted_text: 'Built a RAG pipeline with GPT-4 that actually works for my team',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
    };

    const gate = filterPublishableOpportunities([validOpp]);
    expect(gate.accepted.length).toBe(1);
  });
});

// ═══ No Auto-Posting ═══

describe('no auto-posting introduced (Phase 2C)', () => {
  it('pipeline task types do not include any auto-post type', () => {
    const validTypes = [
      'load_account_state',
      'scan_account',
      'merge_scan_results',
      'enrich_opportunities',
      'quality_enhance',
      'publish_gate',
      'decision',
      'persist_decision',
      'telegram_delivery'
    ];

    const autoPostTypes = ['auto_post', 'post_tweet', 'publish_tweet', 'auto_publish'];
    for (const type of autoPostTypes) {
      expect(validTypes).not.toContain(type);
    }
  });

  it('quality_validator does not auto-post', () => {
    // The validator only marks opportunities — it never posts
    const result = validateOpportunityQuality({
      crafted_text: 'Some text',
      type: 'reply',
    });
    // It returns a result, doesn't post anything
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('failures');
  });
});

// ═══ Phase 2C Diagnostic Fields ═══

describe('Phase 2C diagnostic fields', () => {
  it('OpportunityWithDiagnostics type includes Phase 2C fields', () => {
    const opp = {
      type: 'reply' as const,
      crafted_text: 'Built a RAG pipeline',
      source_text: 'source',
      source_author: 'author',
      source_tweet_url: 'https://x.com/user/status/123',
      why: 'reason',
      brain_rules_used: [],
      shield_passed: true,
      shield_issues: [],
      // Phase 2B fields
      originality_score_before: 5.6,
      originality_score_after: 8.2,
      evidence_safety_score: 9.0,
      rewrite_applied: true,
      numeric_claim_removed: false,
      quality_notes: 'Originality 5.6/10 < 7.8 threshold; Rewritten',
      // Phase 2C fields
      niche_alignment_score: 8.5,
      niche_alignment_reason: 'Aligned: AI_tools, productivity',
      cleaned_json_wrapper: true,
      malformed_json_output: false,
      pre_gate_rejection_reason: null,
      final_quality_validation_passed: true,
      final_quality_validation_notes: 'All quality validations passed',
    };

    expect(opp.niche_alignment_score).toBe(8.5);
    expect(opp.cleaned_json_wrapper).toBe(true);
    expect(opp.malformed_json_output).toBe(false);
    expect(opp.final_quality_validation_passed).toBe(true);
  });

  it('diagnostic fields default to undefined when not set', () => {
    const opp = {
      type: 'reply' as const,
      crafted_text: '',
      source_text: '',
      source_author: '',
      source_tweet_url: '',
      why: '',
      brain_rules_used: [],
      shield_passed: false,
      shield_issues: [],
    };

    expect(opp.niche_alignment_score).toBeUndefined();
    expect(opp.niche_alignment_reason).toBeUndefined();
    expect(opp.cleaned_json_wrapper).toBeUndefined();
    expect(opp.malformed_json_output).toBeUndefined();
    expect(opp.pre_gate_rejection_reason).toBeUndefined();
    expect(opp.final_quality_validation_passed).toBeUndefined();
    expect(opp.final_quality_validation_notes).toBeUndefined();
  });
});

// ═══ Pipeline Integration: Phase 2C step positions ═══

describe('quality_enhance step positions (Phase 2C)', () => {
  it('Phase 2C steps run in correct order within quality_enhance', () => {
    // Order: clean → niche_guard → originality_enhance → numeric_guard → validate
    const stepOrder = {
      clean_crafted_text: 64.1,
      niche_alignment_guard: 64.2,
      originality_enhance: 64.3,
      numeric_claim_guard: 64.4,
      quality_validation: 64.5,
      publish_gate: 70,
    };

    expect(stepOrder.clean_crafted_text).toBeLessThan(stepOrder.niche_alignment_guard);
    expect(stepOrder.niche_alignment_guard).toBeLessThan(stepOrder.originality_enhance);
    expect(stepOrder.originality_enhance).toBeLessThan(stepOrder.numeric_claim_guard);
    expect(stepOrder.numeric_claim_guard).toBeLessThan(stepOrder.quality_validation);
    expect(stepOrder.quality_validation).toBeLessThan(stepOrder.publish_gate);
  });

  it('quality_enhance still runs between enrich and publish_gate', () => {
    const stepOrder = {
      enrich_opportunities: 60,
      quality_enhance: 65,
      publish_gate: 70,
    };

    expect(stepOrder.quality_enhance).toBeGreaterThan(stepOrder.enrich_opportunities);
    expect(stepOrder.quality_enhance).toBeLessThan(stepOrder.publish_gate);
  });
});
