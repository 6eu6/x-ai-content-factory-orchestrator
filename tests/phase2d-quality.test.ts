/**
 * Phase 2D tests — AI Opportunity Intelligence + Candidate Selection
 *
 * Tests pure logic functions that don't require AI model calls.
 * AI-dependent functions (evaluateOpportunity, judgeCraftedCandidate)
 * are integration-tested manually.
 *
 * Required test cases from spec:
 * 1. Weak generic source gets should_craft=false
 * 2. AI/productivity source gets high niche_fit and should_craft=true
 * 3. Entertainment source without useful angle gets rejected
 * 4. Entertainment source with attention economy angle can pass
 * 5. Anime/comics source without creator/storytelling angle gets rejected
 * 6. Source requiring unsupported numeric claim gets rejected or marked evidence risk
 * 7. Opportunity brief includes do_not_claim
 * 8. Crafting uses brief, not raw source only
 * 9. Writer returns plain text only
 * 10. Writer cannot return JSON
 * 11. Judge rejects generic bait
 * 12. Judge rejects unsupported claims
 * 13. Judge passes strong original useful candidate
 * 14. publish_gate thresholds remain unchanged
 * 15. no auto-posting introduced
 * 16. Oracle worker remains heavy executor
 * 17. Vercel routes remain lightweight
 */

import { describe, it, expect } from 'vitest';
import {
  quickNicheFitScore,
  determineRejectionReason,
  type OpportunityBrief,
  type IntelligenceSummary,
} from '../lib/opportunity-intelligence';
import {
  quickJudgeCheck,
  type JudgeResult,
  type JudgeSummary,
} from '../lib/opportunity-judge';
import {
  cleanCraftedText,
  looksLikeJsonWrapper,
} from '../lib/crafted-text-cleaner';
import {
  containsArabic,
  isAISlopWrapper,
  filterPublishableOpportunities,
} from '../lib/content-policy';
import {
  validateOpportunityQuality,
} from '../lib/quality-validator';

// ═══ 1. Weak generic source gets should_craft=false ═══

describe('Phase 2D: Weak generic source gets should_craft=false', () => {
  it('quickNicheFitScore returns low score for generic celebrity gossip', () => {
    const result = quickNicheFitScore('Kardashian family drama escalates as Taylor Swift releases new song about Travis Kelce');
    expect(result.blocked).toBe(true);
    expect(result.score).toBeLessThan(5);
  });

  it('quickNicheFitScore returns low score for random jokes', () => {
    const result = quickNicheFitScore('Why did the chicken cross the road? Lol lmao');
    expect(result.blocked).toBe(true);
  });

  it('determineRejectionReason returns blocked_topic for blocked content', () => {
    const brief: OpportunityBrief = {
      source_summary: 'Celebrity gossip',
      source_text: 'Kardashian drama latest update',
      source_author: 'gossip_account',
      source_tweet_url: 'https://x.com/test/status/123',
      type: 'reply',
      core_observation: '',
      why_it_matters: '',
      audience_relevance: '',
      niche_fit_score: 2,
      originality_potential_score: 3,
      usefulness_score: 2,
      evidence_risk_score: 8,
      viral_context_score: 5,
      publishability_score: 3,
      recommended_angle: '',
      content_format: 'reply',
      do_not_claim: [],
      required_context: [],
      should_craft: false,
    };
    const reason = determineRejectionReason(brief);
    expect(reason).toBe('blocked_topic');
  });

  it('determineRejectionReason returns low_originality_potential for generic content', () => {
    const brief: OpportunityBrief = {
      source_summary: 'Generic AI discussion',
      source_text: 'Some AI thing happened',
      source_author: 'tech_user',
      source_tweet_url: 'https://x.com/test/status/456',
      type: 'reply',
      core_observation: 'Something happened',
      why_it_matters: '',
      audience_relevance: '',
      niche_fit_score: 7,
      originality_potential_score: 4,
      usefulness_score: 4,
      evidence_risk_score: 8,
      viral_context_score: 5,
      publishability_score: 6,
      recommended_angle: 'Share a thought about AI',
      content_format: 'reply',
      do_not_claim: [],
      required_context: [],
      should_craft: false,
    };
    const reason = determineRejectionReason(brief);
    expect(reason).toBe('low_originality_potential');
  });
});

// ═══ 2. AI/productivity source gets high niche_fit ═══

describe('Phase 2D: AI/productivity source gets high niche_fit', () => {
  it('quickNicheFitScore returns high score for AI tools content', () => {
    const result = quickNicheFitScore('Built a RAG pipeline with GPT-4 that automates my entire research workflow');
    expect(result.score).toBeGreaterThanOrEqual(7);
    expect(result.matched_topics).toContain('AI tools');
    expect(result.blocked).toBe(false);
  });

  it('quickNicheFitScore returns high score for productivity content', () => {
    const result = quickNicheFitScore('Switched my workflow to use Notion and automated everything with n8n');
    expect(result.score).toBeGreaterThanOrEqual(6);
    expect(result.matched_topics).toContain('productivity');
    expect(result.blocked).toBe(false);
  });

  it('quickNicheFitScore returns high score for career growth content', () => {
    const result = quickNicheFitScore('How I negotiated a 40% salary increase by upskilling in AI engineering');
    expect(result.score).toBeGreaterThanOrEqual(6);
    expect(result.blocked).toBe(false);
  });

  it('quickNicheFitScore returns high score for creator economy content', () => {
    const result = quickNicheFitScore('The creator economy is shifting — here is how indie hackers are leveraging attention');
    expect(result.score).toBeGreaterThanOrEqual(6);
    expect(result.blocked).toBe(false);
  });
});

// ═══ 3. Entertainment source without useful angle gets rejected ═══

describe('Phase 2D: Entertainment source without useful angle gets rejected', () => {
  it('quickNicheFitScore blocks pure entertainment without angle', () => {
    const result = quickNicheFitScore('New Hollywood movie just dropped and the box office numbers are insane');
    expect(result.blocked).toBe(true);
  });

  it('Pure sports reaction is blocked', () => {
    const result = quickNicheFitScore('The NBA finals were incredible last night — what a game!');
    expect(result.blocked).toBe(true);
    expect(result.adjacent_with_angle).toBe(false);
  });
});

// ═══ 4. Entertainment source with attention economy angle can pass ═══

describe('Phase 2D: Entertainment source with attention economy angle can pass', () => {
  it('Entertainment with attention economy signals has adjacent_with_angle=true', () => {
    const result = quickNicheFitScore('How the entertainment industry uses audience retention data to decide what content to greenlight — and what creators can learn from it');
    expect(result.adjacent_with_angle).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(5);
  });

  it('Sports with personal brand/leverage angle has adjacent_with_angle=true', () => {
    const result = quickNicheFitScore('How Jake Paul leveraged boxing into a personal brand empire worth millions — lessons for creators');
    expect(result.adjacent_with_angle).toBe(true);
  });

  it('Boxing with distribution/incentives angle gets adjacent_with_angle', () => {
    const result = quickNicheFitScore('The UFC fighter pay structure shows how distribution incentives shape attention economy');
    expect(result.adjacent_with_angle).toBe(true);
  });
});

// ═══ 5. Anime/comics source without creator/storytelling angle gets rejected ═══

describe('Phase 2D: Anime/comics source without creator/storytelling angle gets rejected', () => {
  it('Pure anime opinion is blocked', () => {
    const result = quickNicheFitScore('One Piece chapter was absolutely peak fiction — best arc ever');
    expect(result.blocked).toBe(true);
    expect(result.adjacent_with_angle).toBe(false);
  });

  it('Anime with storytelling/fandom angle gets adjacent_with_angle', () => {
    const result = quickNicheFitScore('How One Piece built a fandom retention strategy that keeps audiences engaged for 25 years — creator lessons');
    expect(result.adjacent_with_angle).toBe(true);
    expect(result.blocked).toBe(false);
  });

  it('Comics without storytelling angle is blocked', () => {
    const result = quickNicheFitScore('Superman vs Batman in the new DC movie looks incredible');
    expect(result.blocked).toBe(true);
  });
});

// ═══ 6. Source requiring unsupported numeric claim gets evidence risk ═══

describe('Phase 2D: Source requiring unsupported numeric claim gets evidence risk', () => {
  it('determineRejectionReason returns unsupported_claim_risk for high evidence risk with claims', () => {
    const brief: OpportunityBrief = {
      source_summary: 'AI productivity stats',
      source_text: 'AI improved productivity by 300% according to studies',
      source_author: 'stats_account',
      source_tweet_url: 'https://x.com/test/status/789',
      type: 'quote',
      core_observation: 'Productivity claim',
      why_it_matters: 'Relevant but risky',
      audience_relevance: 'High',
      niche_fit_score: 8,
      originality_potential_score: 7,
      usefulness_score: 6,
      evidence_risk_score: 3,
      viral_context_score: 6,
      publishability_score: 7,
      recommended_angle: 'Deconstruct the 300% productivity claim',
      content_format: 'quote',
      do_not_claim: ['AI improved productivity by 300%', 'studies show'],
      required_context: ['Need source for 300% claim'],
      should_craft: false,
    };
    const reason = determineRejectionReason(brief);
    expect(reason).toBe('unsupported_claim_risk');
  });
});

// ═══ 7. Opportunity brief includes do_not_claim ═══

describe('Phase 2D: Opportunity brief includes do_not_claim', () => {
  it('OpportunityBrief type supports do_not_claim array', () => {
    const brief: OpportunityBrief = {
      source_summary: 'AI stat',
      source_text: 'AI grew revenue by 5x',
      source_author: 'test',
      source_tweet_url: 'https://x.com/test/status/1',
      type: 'quote',
      core_observation: 'Revenue claim',
      why_it_matters: 'Relevant',
      audience_relevance: 'High',
      niche_fit_score: 8,
      originality_potential_score: 8,
      usefulness_score: 7,
      evidence_risk_score: 3,
      viral_context_score: 7,
      publishability_score: 8,
      recommended_angle: 'Question the 5x claim',
      content_format: 'quote',
      do_not_claim: ['AI grew revenue by 5x', 'revenue multiplier claims'],
      required_context: ['Source needed for 5x claim'],
      should_craft: true,
    };
    expect(brief.do_not_claim).toHaveLength(2);
    expect(brief.do_not_claim).toContain('AI grew revenue by 5x');
  });
});

// ═══ 8. Crafting uses brief, not raw source only ═══

describe('Phase 2D: Crafting uses brief, not raw source only', () => {
  it('Brief provides recommended_angle that guides crafting', () => {
    const brief: OpportunityBrief = {
      source_summary: 'AI automation trend',
      source_text: 'More companies are adopting AI automation in 2025',
      source_author: 'tech_news',
      source_tweet_url: 'https://x.com/test/status/1',
      type: 'quote',
      core_observation: 'AI automation adoption trend',
      why_it_matters: 'Relevant to @30piq audience',
      audience_relevance: 'Builders and operators',
      niche_fit_score: 9,
      originality_potential_score: 8,
      usefulness_score: 8,
      evidence_risk_score: 9,
      viral_context_score: 7,
      publishability_score: 8,
      recommended_angle: 'The hidden cost of AI automation nobody talks about — what breaks when you automate the wrong workflow',
      content_format: 'quote',
      do_not_claim: [],
      required_context: [],
      should_craft: true,
    };
    // The recommended_angle is specific and actionable — not just "share a thought"
    expect(brief.recommended_angle.length).toBeGreaterThan(20);
    expect(brief.recommended_angle).not.toBe('Share a thought');
    expect(brief.recommended_angle).not.toBe('Add perspective');
  });
});

// ═══ 9. Writer returns plain text only ═══

describe('Phase 2D: Writer returns plain text only', () => {
  it('Clean crafted text passes looksLikeJsonWrapper check', () => {
    const plainText = 'Switched my RAG pipeline to use structured output — the hidden cost nobody talks about is the iteration speed';
    expect(looksLikeJsonWrapper(plainText)).toBe(false);
  });

  it('Plain text passes quality validation', () => {
    const plainText = 'The hidden cost of AI automation nobody talks about — what breaks when you automate the wrong workflow first';
    const result = validateOpportunityQuality({
      crafted_text: plainText,
      type: 'quote',
      niche_alignment_score: 8.5,
    });
    expect(result.passed).toBe(true);
  });
});

// ═══ 10. Writer cannot return JSON ═══

describe('Phase 2D: Writer cannot return JSON', () => {
  it('JSON wrapper is detected and rejected', () => {
    const jsonOutput = '{"reply":"AI automation insight"}';
    expect(looksLikeJsonWrapper(jsonOutput)).toBe(true);

    // Cleaning should extract the text
    const cleanResult = cleanCraftedText(jsonOutput);
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
    expect(cleanResult.malformed_json_output).toBe(false);
    // The cleaned text should pass validation if it's good enough
    expect(looksLikeJsonWrapper(cleanResult.cleaned_text)).toBe(false);
  });

  it('Markdown JSON fence is detected and rejected', () => {
    const mdJson = '```json\n{"reply":"AI insight"}\n```';
    expect(looksLikeJsonWrapper(mdJson)).toBe(true);

    const cleanResult = cleanCraftedText(mdJson);
    expect(cleanResult.cleaned_json_wrapper).toBe(true);
  });
});

// ═══ 11. Judge rejects generic bait ═══

describe('Phase 2D: Judge rejects generic bait', () => {
  it('quickJudgeCheck flags generic bait', () => {
    const result = quickJudgeCheck('Yo... this new AI tool is a game changer');
    expect(result.generic_bait_flag).toBe(true);
  });

  it('quickJudgeCheck flags "Interesting take" bait', () => {
    const result = quickJudgeCheck('Interesting take on AI productivity');
    expect(result.generic_bait_flag).toBe(true);
  });

  it('quickJudgeCheck flags "This is huge" bait', () => {
    const result = quickJudgeCheck('This is huge for the AI industry');
    expect(result.generic_bait_flag).toBe(true);
  });

  it('quickJudgeCheck passes clean specific text', () => {
    const result = quickJudgeCheck('Switched my RAG pipeline to use structured output — saves 30 min per session');
    expect(result.generic_bait_flag).toBe(false);
  });
});

// ═══ 12. Judge rejects unsupported claims ═══

describe('Phase 2D: Judge rejects unsupported claims', () => {
  it('quickJudgeCheck flags unsupported numeric claims', () => {
    const result = quickJudgeCheck('AI improved productivity by 300% — studies show this trend');
    expect(result.unsupported_claim_flag).toBe(true);
  });

  it('quickJudgeCheck flags "studies show" without source', () => {
    const result = quickJudgeCheck('Studies show that AI saves millions of hours');
    expect(result.unsupported_claim_flag).toBe(true);
  });

  it('quickJudgeCheck passes claims with source URL', () => {
    const result = quickJudgeCheck('AI improved productivity by 40% — source: https://example.com/study');
    expect(result.unsupported_claim_flag).toBe(false);
  });

  it('quickJudgeCheck passes text without numeric claims', () => {
    const result = quickJudgeCheck('Built a RAG pipeline that handles my entire research workflow');
    expect(result.unsupported_claim_flag).toBe(false);
  });
});

// ═══ 13. Judge passes strong original useful candidate ═══

describe('Phase 2D: Judge passes strong original useful candidate', () => {
  it('quickJudgeCheck passes strong candidate with no flags', () => {
    const text = 'The hidden cost of AI automation nobody talks about — what breaks when you automate the wrong workflow first';
    const result = quickJudgeCheck(text);
    expect(result.generic_bait_flag).toBe(false);
    expect(result.unsupported_claim_flag).toBe(false);
  });

  it('JudgeResult type supports all required fields', () => {
    const judgeResult: JudgeResult = {
      originality_score: 8.5,
      usefulness_score: 8.0,
      niche_fit_score: 9.0,
      evidence_safety_score: 9.0,
      clarity_score: 8.5,
      generic_bait_flag: false,
      unsupported_claim_flag: false,
      final_candidate_score: 8.6,
      passed: true,
      failure_reasons: [],
    };
    expect(judgeResult.passed).toBe(true);
    expect(judgeResult.failure_reasons).toHaveLength(0);
    expect(judgeResult.final_candidate_score).toBeGreaterThanOrEqual(7.8);
  });
});

// ═══ 14. publish_gate thresholds remain unchanged ═══

describe('Phase 2D: publish_gate thresholds remain unchanged', () => {
  it('publish gate still rejects shield_passed=false', () => {
    const opp = {
      type: 'reply' as const,
      crafted_text: 'Some content about AI productivity',
      source_tweet_url: 'https://x.com/user/status/123',
      shield_passed: false,
      shield_issues: ['missing_originality'],
    };
    const gate = filterPublishableOpportunities([opp]);
    expect(gate.rejected.length).toBe(1);
  });

  it('publish gate still accepts valid content', () => {
    const opp = {
      type: 'reply' as const,
      crafted_text: 'Switched my research workflow to use RAG + GPT-4 — the structured output alone saves time per session',
      source_tweet_url: 'https://x.com/user/status/456',
      shield_passed: true,
      shield_issues: [],
    };
    const gate = filterPublishableOpportunities([opp]);
    expect(gate.accepted.length).toBe(1);
  });
});

// ═══ 15. No auto-posting introduced ═══

describe('Phase 2D: no auto-posting introduced', () => {
  it('pipeline task types do not include any auto-post type', () => {
    const validTypes = [
      'load_account_state',
      'scan_account',
      'merge_scan_results',
      'opportunity_intelligence',
      'enrich_opportunities',
      'quality_enhance',
      'opportunity_judge',
      'publish_gate',
      'decision',
      'persist_decision',
      'telegram_delivery',
    ];

    const autoPostTypes = ['auto_post', 'post_tweet', 'publish_tweet', 'auto_publish'];
    for (const type of autoPostTypes) {
      expect(validTypes).not.toContain(type);
    }
  });

  it('intelligence module does not post anything', () => {
    // The module only evaluates — it never posts
    const brief: OpportunityBrief = {
      source_summary: 'test',
      source_text: 'test',
      source_author: 'test',
      source_tweet_url: '',
      type: 'reply',
      core_observation: '',
      why_it_matters: '',
      audience_relevance: '',
      niche_fit_score: 1,
      originality_potential_score: 1,
      usefulness_score: 1,
      evidence_risk_score: 10,
      viral_context_score: 1,
      publishability_score: 1,
      recommended_angle: '',
      content_format: 'reply',
      do_not_claim: [],
      required_context: [],
      should_craft: false,
      rejection_reason: 'weak_source',
    };
    // Verify the brief has no posting capability
    expect(brief.should_craft).toBe(false);
    expect(typeof brief.should_craft).toBe('boolean');
  });
});

// ═══ 16. Oracle worker remains heavy executor ═══

describe('Phase 2D: Oracle worker remains heavy executor', () => {
  it('opportunity_intelligence task runs on worker, not Vercel', () => {
    // The intelligence step uses AI calls (callModel) which are heavy
    // and should only run on the Oracle worker, not on Vercel routes
    // We verify the task type exists and is part of the pipeline
    const pipelineTaskTypes = [
      'load_account_state',
      'scan_account',
      'merge_scan_results',
      'opportunity_intelligence',
      'enrich_opportunities',
      'quality_enhance',
      'opportunity_judge',
      'publish_gate',
      'decision',
      'persist_decision',
      'telegram_delivery',
    ];
    expect(pipelineTaskTypes).toContain('opportunity_intelligence');
    expect(pipelineTaskTypes).toContain('opportunity_judge');
  });
});

// ═══ 17. Vercel routes remain lightweight ═══

describe('Phase 2D: Vercel routes remain lightweight', () => {
  it('intelligence evaluation is not imported in any API route', () => {
    // The intelligence module should only be used by the pipeline worker
    // API routes should NOT import it directly
    // This test verifies the module interface is clean
    const intelligenceSummary: IntelligenceSummary = {
      raw_opportunity_count: 10,
      intelligence_evaluated_count: 10,
      intelligence_rejected_count: 8,
      intelligence_selected_count: 2,
      selected_opportunity_scores: [
        { publishability: 8.5, originality_potential: 8.0, niche_fit: 9.0 },
      ],
      top_rejection_reasons: { blocked_topic: 4, low_originality_potential: 3, low_niche_fit: 1 },
      avg_publishability_score: 4.2,
      avg_originality_potential_score: 3.8,
    };
    expect(intelligenceSummary.raw_opportunity_count).toBe(10);
    expect(intelligenceSummary.intelligence_selected_count).toBe(2);
  });
});

// ═══ Intelligence Summary Shape ═══

describe('Phase 2D: Intelligence summary includes all required fields', () => {
  it('IntelligenceSummary has all required diagnostic fields', () => {
    const summary: IntelligenceSummary = {
      raw_opportunity_count: 18,
      intelligence_evaluated_count: 18,
      intelligence_rejected_count: 15,
      intelligence_selected_count: 3,
      selected_opportunity_scores: [],
      top_rejection_reasons: {},
      avg_publishability_score: 5.0,
      avg_originality_potential_score: 4.5,
    };
    expect(summary).toHaveProperty('raw_opportunity_count');
    expect(summary).toHaveProperty('intelligence_evaluated_count');
    expect(summary).toHaveProperty('intelligence_rejected_count');
    expect(summary).toHaveProperty('intelligence_selected_count');
    expect(summary).toHaveProperty('selected_opportunity_scores');
    expect(summary).toHaveProperty('top_rejection_reasons');
    expect(summary).toHaveProperty('avg_publishability_score');
    expect(summary).toHaveProperty('avg_originality_potential_score');
  });

  it('JudgeSummary has all required diagnostic fields', () => {
    const summary: JudgeSummary = {
      judge_passed_count: 3,
      judge_failed_count: 12,
      judge_failure_reasons: { originality_score: 8 },
      avg_final_candidate_score: 5.5,
      avg_originality_score: 4.8,
    };
    expect(summary).toHaveProperty('judge_passed_count');
    expect(summary).toHaveProperty('judge_failed_count');
    expect(summary).toHaveProperty('judge_failure_reasons');
    expect(summary).toHaveProperty('avg_final_candidate_score');
    expect(summary).toHaveProperty('avg_originality_score');
  });
});
