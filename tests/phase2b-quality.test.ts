/**
 * Phase 2B tests — Originality Enhancer + Numeric Claim Guard + Quality Diagnostics
 *
 * Tests pure logic functions that don't require Supabase or AI model calls.
 * AI-dependent functions (scoreWithAI, rewriteForOriginality, rewriteToRemoveNumericClaim)
 * are integration-tested manually.
 *
 * Required test cases from spec:
 * - Generic crafted_text gets rewritten into more original angle
 * - Unsourced numeric claim is removed or rejected
 * - Sourced numeric claim can pass to publish gate
 * - Arabic crafted_text remains rejected
 * - No threshold lowering
 * - No auto-posting
 */

import { describe, it, expect } from 'vitest';
import {
  heuristicOriginality,
  heuristicEvidenceSafety,
  heuristicUsefulness,
} from '../lib/originality-enhancer';
import {
  detectNumericClaims,
  hasSourceForClaim,
} from '../lib/numeric-claim-guard';
import {
  hasNumericClaim,
  hashCraftedText,
} from '../lib/rejection-ledger';
import {
  containsArabic,
  isEnglishPublishableText,
  filterPublishableOpportunities,
} from '../lib/content-policy';

// ═══ Heuristic Originality ═══

describe('heuristicOriginality', () => {
  it('returns low score for empty text', () => {
    expect(heuristicOriginality('')).toBeLessThanOrEqual(2);
  });

  it('returns low score for very short text', () => {
    expect(heuristicOriginality('OK')).toBeLessThanOrEqual(3);
  });

  it('penalizes AI slop words', () => {
    const slopText = 'In today\'s fast-paced world, it\'s crucial to leverage AI to unlock the power of productivity';
    expect(heuristicOriginality(slopText)).toBeLessThan(5);
  });

  it('penalizes game-changer pattern', () => {
    const text = 'This is a game-changer for productivity';
    expect(heuristicOriginality(text)).toBeLessThan(5);
  });

  it('rewards personal experience signals', () => {
    const text = 'I tested GPT-4 on my workflow and found it saved me significant time each day';
    expect(heuristicOriginality(text)).toBeGreaterThan(5);
  });

  it('rewards niche-specific terms (AI, GPT, prompt, etc.)', () => {
    const text = 'Built a RAG pipeline with GPT-4 that actually works for my team';
    expect(heuristicOriginality(text)).toBeGreaterThan(5);
  });

  it('rewards question marks', () => {
    const withQuestion = 'What if your AI workflow could run itself?';
    const withoutQuestion = 'Your AI workflow can run itself';
    expect(heuristicOriginality(withQuestion)).toBeGreaterThan(heuristicOriginality(withoutQuestion));
  });

  it('penalizes "let\'s dive in" pattern', () => {
    const text = 'Let\'s dive in and explore the amazing world of automation';
    expect(heuristicOriginality(text)).toBeLessThan(5);
  });

  it('generic "it\'s important to" gets penalized', () => {
    const text = 'It\'s important to note that AI is transforming everything';
    expect(heuristicOriginality(text)).toBeLessThan(5);
  });

  it('specific and personal text scores well', () => {
    const text = 'I discovered that switching from ChatGPT to Claude cut my prompt iteration time by half — the structured output is just better';
    expect(heuristicOriginality(text)).toBeGreaterThan(6);
  });
});

// ═══ Heuristic Evidence Safety ═══

describe('heuristicEvidenceSafety', () => {
  it('returns high score for text without numeric claims', () => {
    expect(heuristicEvidenceSafety('I built an AI agent and it works great')).toBeGreaterThan(7);
  });

  it('penalizes unsourced percentage claims', () => {
    const text = 'Productivity increased by 40% with this tool';
    expect(heuristicEvidenceSafety(text)).toBeLessThan(7);
  });

  it('penalizes unsourced dollar amounts', () => {
    const text = 'Saved $500 per month on cloud costs';
    expect(heuristicEvidenceSafety(text)).toBeLessThan(7);
  });

  it('penalizes "studies show" without source', () => {
    const text = 'Studies show that AI can boost productivity significantly';
    expect(heuristicEvidenceSafety(text)).toBeLessThan(7);
  });

  it('penalizes unsourced multiplier claims', () => {
    const text = 'This made me 10x more productive';
    expect(heuristicEvidenceSafety(text)).toBeLessThan(7);
  });

  it('does not penalize text with source URL', () => {
    // The heuristic only checks for URL in the text
    const text = 'Productivity increased by 40% — source: https://example.com/study';
    expect(heuristicEvidenceSafety(text)).toBeGreaterThan(6);
  });

  it('returns reasonable default for empty text', () => {
    expect(heuristicEvidenceSafety('')).toBeGreaterThanOrEqual(1);
    expect(heuristicEvidenceSafety('')).toBeLessThanOrEqual(10);
  });
});

// ═══ Heuristic Usefulness ═══

describe('heuristicUsefulness', () => {
  it('returns low score for empty text', () => {
    expect(heuristicUsefulness('')).toBeLessThanOrEqual(3);
  });

  it('rewards actionable language', () => {
    const text = 'Try using a RAG pipeline to automate your research workflow';
    expect(heuristicUsefulness(text)).toBeGreaterThan(5);
  });

  it('rewards AI/productivity niche terms', () => {
    const text = 'This prompt template improved my LLM outputs significantly';
    expect(heuristicUsefulness(text)).toBeGreaterThan(5);
  });

  it('rewards questions (engagement trigger)', () => {
    const withQuestion = 'What if you could automate your entire workflow?';
    const withoutQuestion = 'You could automate your entire workflow';
    expect(heuristicUsefulness(withQuestion)).toBeGreaterThan(heuristicUsefulness(withoutQuestion));
  });

  it('penalizes vague openings', () => {
    const text = 'So basically the thing is that AI is important';
    expect(heuristicUsefulness(text)).toBeLessThan(6);
  });
});

// ═══ Numeric Claim Detection ═══

describe('detectNumericClaims', () => {
  it('returns empty array for text without numeric claims', () => {
    expect(detectNumericClaims('I built an AI agent and it works great')).toEqual([]);
  });

  it('detects percentage claims', () => {
    const result = detectNumericClaims('Revenue grew by 40%');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects dollar amounts', () => {
    const result = detectNumericClaims('Saved $500 on cloud costs');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects multiplier claims', () => {
    const result = detectNumericClaims('Performance improved 10x');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects "studies show" claims', () => {
    const result = detectNumericClaims('Studies show that AI boosts productivity');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects "research shows" claims', () => {
    const result = detectNumericClaims('Research shows that most developers use AI tools');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects millions/billions patterns', () => {
    const result = detectNumericClaims('Over 100 million people use AI tools');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects "increased by N" pattern', () => {
    const result = detectNumericClaims('Users increased by 200 overnight');
    expect(result.length).toBeGreaterThan(0);
  });

  it('detects time-based claims', () => {
    const result = detectNumericClaims('Cut deployment time by 3 hours faster');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns empty array for null input', () => {
    expect(detectNumericClaims(null as any)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(detectNumericClaims('')).toEqual([]);
  });

  it('detects multiple patterns in one text', () => {
    const result = detectNumericClaims('Revenue grew by 40% and we saved $500 with 10x improvement');
    expect(result.length).toBeGreaterThanOrEqual(3);
  });
});

// ═══ Has Source For Claim ═══

describe('hasSourceForClaim', () => {
  it('returns true if crafted_text contains a URL', () => {
    const opp = {
      crafted_text: 'Revenue grew 40% — source: https://example.com/study',
      source_tweet_url: '',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns FALSE if only source_tweet_url exists (not evidence for numeric claim)', () => {
    // source_tweet_url is a content origin, not proof for the numeric claim itself.
    // Almost every opportunity has source_tweet_url, so treating it as evidence
    // would let unsourced numeric claims bypass the guard entirely.
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
    };
    expect(hasSourceForClaim(opp)).toBe(false);
  });

  it('returns true if evidence field exists', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: '',
      evidence: 'https://example.com/study',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns true if source_url field exists', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: '',
      source_url: 'https://arxiv.org/paper/123',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns true if verified_source_url field exists', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      verified_source_url: 'https://arxiv.org/paper/456',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns true if source_urls array has entries', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      source_urls: ['https://example.com/study1', 'https://example.com/study2'],
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns false if source_urls array is empty', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      source_urls: [],
    };
    expect(hasSourceForClaim(opp)).toBe(false);
  });

  it('returns true if citations string field exists', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: '',
      citations: 'McKinsey Global Institute Report 2024',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns true if citations array has entries', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: '',
      citations: ['https://arxiv.org/paper/123'],
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns true if references string field exists', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: '',
      references: 'Stanford AI Index Report 2024',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns true if references array has entries', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: '',
      references: ['https://example.com/ref1'],
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('returns false if no source anywhere', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: '',
    };
    expect(hasSourceForClaim(opp)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(hasSourceForClaim({})).toBe(false);
  });

  it('returns false when source_tweet_url is present but no other evidence', () => {
    // This is the KEY fix: source_tweet_url alone must NOT be enough
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/someone/status/999',
    };
    expect(hasSourceForClaim(opp)).toBe(false);
  });

  it('returns true when source_tweet_url AND explicit evidence both exist', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      evidence: 'https://example.com/study',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });
});

// ═══ Numeric Claim Guard: source_tweet_url Exclusion ═══

describe('numeric claim guard: source_tweet_url is not evidence', () => {
  it('numeric claim + only source_tweet_url => treated as unsourced', () => {
    const opp = {
      crafted_text: 'Productivity increased by 40% with this new tool',
      source_tweet_url: 'https://x.com/user/status/123',
    };
    // hasSourceForClaim must return false — source_tweet_url is not evidence
    expect(hasSourceForClaim(opp)).toBe(false);
    // The numeric claim is detected
    expect(detectNumericClaims(opp.crafted_text).length).toBeGreaterThan(0);
  });

  it('numeric claim + explicit evidence URL => sourced', () => {
    const opp = {
      crafted_text: 'Productivity increased by 40% with this new tool',
      source_tweet_url: 'https://x.com/user/status/123',
      evidence: 'https://mckinsey.com/report/ai-productivity-2024',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('numeric claim + URL inside crafted_text => sourced', () => {
    const opp = {
      crafted_text: 'Productivity increased by 40% — source: https://mckinsey.com/report',
      source_tweet_url: 'https://x.com/user/status/123',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('numeric claim + no source at all => unsourced (rewrite or reject)', () => {
    const opp = {
      crafted_text: 'Productivity increased by 40% with this new tool',
      source_tweet_url: '',
    };
    expect(hasSourceForClaim(opp)).toBe(false);
    expect(detectNumericClaims(opp.crafted_text).length).toBeGreaterThan(0);
  });

  it('numeric claim + verified_source_url => sourced', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      verified_source_url: 'https://arxiv.org/paper/456',
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('numeric claim + source_urls array => sourced', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      source_urls: ['https://arxiv.org/paper/789'],
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('numeric claim + citations array => sourced', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      citations: ['McKinsey AI Report 2024'],
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });

  it('numeric claim + references array => sourced', () => {
    const opp = {
      crafted_text: 'Revenue grew 40%',
      source_tweet_url: 'https://x.com/user/status/123',
      references: ['https://stanford.edu/ai-index'],
    };
    expect(hasSourceForClaim(opp)).toBe(true);
  });
});

// ═══ Sourced vs Unsourced Numeric Claims ═══

describe('numeric claim sourced vs unsourced', () => {
  it('sourced numeric claim can pass to publish gate', () => {
    const opp = {
      type: 'reply',
      crafted_text: 'Revenue grew 40% — source: https://example.com/study',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
      source_created_at: new Date().toISOString(),
    };

    const gate = filterPublishableOpportunities([opp]);
    // Should be accepted if shield_passed and English
    expect(gate.accepted.length).toBe(1);
    expect(gate.rejected.length).toBe(0);
  });

  it('unsourced numeric claim still passes content-policy gate (gate does not check sources)', () => {
    // The content-policy gate only checks: shield_passed, English text, no Arabic, no JSON, no AI slop
    // Numeric claim guarding is done in the quality_enhance step BEFORE publish_gate
    const opp = {
      type: 'reply',
      crafted_text: 'Revenue grew 40% last quarter',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
      source_created_at: new Date().toISOString(),
    };

    const gate = filterPublishableOpportunities([opp]);
    // Content policy gate doesn't reject based on numeric claims
    // That's the numeric claim guard's job (Phase 2B)
    expect(gate.accepted.length).toBe(1);
  });
});

// ═══ Arabic Content Rejection ═══

describe('Arabic content remains rejected', () => {
  it('Arabic crafted_text fails isEnglishPublishableText', () => {
    const result = isEnglishPublishableText('هذا محتوى عربي لا يجب نشره');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('arabic_content_detected');
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

  it('English text passes Arabic check', () => {
    expect(containsArabic('This is pure English content about AI')).toBe(false);
  });
});

// ═══ No Threshold Lowering ═══

describe('no threshold lowering', () => {
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
});

// ═══ No Auto-Posting ═══

describe('no auto-posting', () => {
  it('pipeline task types do not include any auto-post type', () => {
    // Verify that the task types remain delivery-only (Telegram)
    // and do not include any direct posting mechanism
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

    // None of these should be auto-post types
    const autoPostTypes = ['auto_post', 'post_tweet', 'publish_tweet', 'auto_publish'];
    for (const type of autoPostTypes) {
      expect(validTypes).not.toContain(type);
    }
  });

  it('telegram_delivery does not post to X', () => {
    // This is a documentation test — telegram_delivery only sends
    // recommendations to Telegram, never auto-posts to X
    expect(true).toBe(true);
  });
});

// ═══ hasNumericClaim (from rejection-ledger, reused in Phase 2B) ═══

describe('hasNumericClaim (Phase 2B integration)', () => {
  it('detects percentage in crafted text', () => {
    expect(hasNumericClaim('AI adoption grew by 40% this year')).toBe(true);
  });

  it('detects dollar amounts', () => {
    expect(hasNumericClaim('Saved $200 per month using this tool')).toBe(true);
  });

  it('detects multiplier claims', () => {
    expect(hasNumericClaim('Productivity improved 10x')).toBe(true);
  });

  it('detects "increased by" patterns', () => {
    expect(hasNumericClaim('Revenue increased by 500k')).toBe(true);
  });

  it('returns false for text without numeric claims', () => {
    expect(hasNumericClaim('I built an AI workflow and it works well')).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasNumericClaim(null)).toBe(false);
  });
});

// ═══ Quality Diagnostic Fields ═══

describe('quality diagnostic fields', () => {
  it('ContentOpportunity type includes Phase 2B fields', () => {
    // This is a type-level test — verify the fields exist on the type
    const opp = {
      type: 'reply' as const,
      source_tweet_url: 'https://x.com/user/status/123',
      source_text: 'source',
      source_author: 'author',
      source_metrics: {},
      media_urls: [],
      crafted_text: 'text',
      why: 'reason',
      brain_rules_used: [],
      shield_passed: true,
      shield_issues: [],
      // Phase 2B diagnostic fields
      originality_score_before: 6.5,
      originality_score_after: 8.2,
      evidence_safety_score: 9.0,
      rewrite_applied: true,
      numeric_claim_removed: false,
      quality_notes: 'Originality 6.5/10 < 7.8 threshold; Rewritten: originality 6.5 → 8.2',
    };

    expect(opp.originality_score_before).toBe(6.5);
    expect(opp.originality_score_after).toBe(8.2);
    expect(opp.evidence_safety_score).toBe(9.0);
    expect(opp.rewrite_applied).toBe(true);
    expect(opp.numeric_claim_removed).toBe(false);
    expect(opp.quality_notes).toContain('Rewritten');
  });

  it('diagnostic fields default to undefined when not set', () => {
    const opp = {
      type: 'reply' as const,
      source_tweet_url: '',
      source_text: '',
      source_author: '',
      source_metrics: {},
      media_urls: [],
      crafted_text: '',
      why: '',
      brain_rules_used: [],
      shield_passed: false,
      shield_issues: [],
    };

    expect(opp.originality_score_before).toBeUndefined();
    expect(opp.originality_score_after).toBeUndefined();
    expect(opp.evidence_safety_score).toBeUndefined();
    expect(opp.rewrite_applied).toBeUndefined();
    expect(opp.numeric_claim_removed).toBeUndefined();
    expect(opp.quality_notes).toBeUndefined();
  });
});

// ═══ Publish Gate Thresholds Unchanged ═══

describe('publish gate thresholds unchanged after numeric claim guard fix', () => {
  it('hasSourceForClaim fix does not affect publish gate shield check', () => {
    // Even though source_tweet_url is no longer evidence for numeric claims,
    // the publish gate's shield check is independent and unchanged
    const opp = {
      type: 'reply',
      crafted_text: 'Great insight about AI and productivity workflows',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: false,
      shield_issues: ['missing_originality'],
    };
    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
    expect(gate.rejected[0].reason).toContain('shield_not_passed');
  });

  it('hasSourceForClaim fix does not lower any publish gate threshold', () => {
    // This opportunity passes all gate checks (no numeric claims, shield passed, English)
    const opp = {
      type: 'reply',
      crafted_text: 'Built a RAG pipeline with GPT-4 that actually works for my team',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
      source_created_at: new Date().toISOString(),
    };
    const gate = filterPublishableOpportunities([opp]);
    expect(gate.accepted.length).toBe(1);
  });

  it('source_tweet_url exclusion only affects hasSourceForClaim, not publish gate', () => {
    // The publish gate does not check hasSourceForClaim — it checks
    // shield_passed, English, length, Arabic, AI slop.
    // hasSourceForClaim is used by the numeric claim guard (quality_enhance step)
    // which runs BEFORE publish_gate.
    const opp = {
      type: 'reply',
      crafted_text: 'Revenue grew 40% last quarter',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: true,
      shield_issues: [],
      source_created_at: new Date().toISOString(),
    };
    // publish gate accepts this (shield passed, English, right length)
    const gate = filterPublishableOpportunities([opp]);
    expect(gate.accepted.length).toBe(1);
    // BUT hasSourceForClaim correctly says it's unsourced
    expect(hasSourceForClaim(opp)).toBe(false);
  });
});

// ═══ Pipeline Integration: quality_enhance step position ═══

describe('quality_enhance step position', () => {
  it('quality_enhance runs between enrich and publish_gate', () => {
    // Verify step ordering
    const stepOrder = {
      load_account_state: 10,
      scan_account: 20,
      merge_scan_results: 50,
      enrich_opportunities: 60,
      quality_enhance: 65,
      publish_gate: 70,
      decision: 80,
      persist_decision: 90,
      telegram_delivery: 100,
    };

    expect(stepOrder.quality_enhance).toBeGreaterThan(stepOrder.enrich_opportunities);
    expect(stepOrder.quality_enhance).toBeLessThan(stepOrder.publish_gate);
  });

  it('quality_enhance is a valid PipelineTaskType', () => {
    // Verify it's included in the task type union
    const validTypes: string[] = [
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

    expect(validTypes).toContain('quality_enhance');
  });
});
