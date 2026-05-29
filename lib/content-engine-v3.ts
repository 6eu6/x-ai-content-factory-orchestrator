import { callModel, parseModelJson, TaskType } from './model-router';
import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';
import {
  getXUserByUsername,
  getXUserTimeline,
  searchXTweets,
  scoreXTweet,
  analyzeXTweet,
  fetchTwitterApiJson,
  twitterApiBase,
  extractTweets
} from './x';
import { learnFromCrawlerItems } from './learning-memory';
import { shieldCheck, quickShieldCheck } from './account-shield';
import { insertIfMissing } from './db-helpers';
import { queryBrainForContent } from './brain-query';

/**
 * Content Engine v3 — Crawl-based content engine, not generation-based
 *
 * Principle: No AI content generation (avoid AI slop). Instead:
 * 1. Crawl X and analyze real accounts and tweets
 * 2. Store patterns in the brain (strict rules)
 * 3. Discover real engagement opportunities (reply, quote, source-based thread)
 * 4. Craft content based on brain rules only
 * 5. Load real media from tweets (photos, video, GIF) — for analysis only, never send
 *
 * v3.1: Deep analysis uses real AI (not hardcoded)
 */

// ═══ Output Types ═══

export type ContentOpportunity = {
  type: 'quote' | 'reply' | 'thread' | 'article' | 'repo_tweet';
  source_tweet_url: string;
  source_text: string;
  source_author: string;
  source_metrics: Record<string, number>;
  media_urls: MediaFromTweet[];
  crafted_text: string;
  why: string;           // Why this opportunity matters
  brain_rules_used: string[];  // Brain rules used
  shield_passed: boolean;
  shield_issues: string[];
  // Phase 6: rule performance weight (optional, set by enrich-opportunities)
  avg_brain_rule_weight?: number;
  rule_performance_summary?: {
    matched_rules: number;
    avg_weight: number;
    strongest_rule: string | null;
    weakest_rule: string | null;
  };
  // Phase 2B: quality diagnostics (optional, set by quality_enhance step)
  originality_score_before?: number;
  originality_score_after?: number | null;
  evidence_safety_score?: number;
  rewrite_applied?: boolean;
  numeric_claim_removed?: boolean;
  quality_notes?: string;
  // Phase 2C: niche alignment and cleaning diagnostics
  niche_alignment_score?: number;
  niche_alignment_reason?: string;
  cleaned_json_wrapper?: boolean;
  malformed_json_output?: boolean;
  pre_gate_rejection_reason?: string;
  final_quality_validation_passed?: boolean;
  final_quality_validation_notes?: string;
};

export type MediaFromTweet = {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  alt_text: string;
};

export type ScanResult = {
  accounts_scanned: number;         // DEPRECATED: use actual_accounts_scanned
  actual_accounts_scanned: number;  // Real accounts scanned from DB
  manual_tweets_loaded: number;     // Manually loaded tweet analyses
  tweets_analyzed: number;
  viral_tweets_found: number;
  opportunities: ContentOpportunity[];
  brain_updates: {
    algorithm_rules: number;
    style_patterns: number;
    media_patterns: number;
  };
  media_downloaded: number;
  light_mode?: boolean;
  debug_log: string[];  // Diagnostic log for server logs only
};

export type DeepAnalysis = {
  viralReason: string;
  stylePattern: string;
  adaptation: string;
  mediaImpact: string;
  timingInsight: string;
  tweetTypeInsight: string;
  engagementQuality: string;
  // v3.2: Multi-angle analysis fields
  psychologicalTrigger: string;      // Psychological mechanism that triggered virality
  audienceProfile: string;            // Who engaged and why
  conversationContext: string;        // Conversation/replies context
  preciseConcept: string;             // Transferable precise concept
  conceptEvidence: string;            // Concrete evidence from data
  confidenceLevel: 'high' | 'medium' | 'low'; // Confidence level based on evidence quantity
};

// ═══ Crawling & Analysis ═══

export type ScanOptions = {
  /** Light mode: skip deep AI analysis (callModel), only store basic metrics.
   *  Designed for frequent lightweight cron runs. Deep analysis stays in daily-run. */
  lightMode?: boolean;
};

/**
 * Crawls saved X accounts and analyzes their tweets
 * + Analyzes manually added tweets
 */
export async function scanXAccounts(maxAccounts = 5, tweetsPerAccount = 10, options: ScanOptions = {}): Promise<ScanResult> {
  const supabase = supabaseAdmin();
  const debugLog: string[] = [];
  let brainUpdates = { algorithmRules: 0, stylePatterns: 0, mcpOpportunities: 0 };
  const lightMode = options.lightMode === true;

  // 1. Fetch saved accounts — smart query prefers unchecked and highest priority
  let accounts: any[] = [];

  // Attempt 1: smart query — prefers unchecked accounts (last_checked=null)
  // then oldest checked, then highest priority by tier
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('handle, tier, notes, last_checked, followers, category')
      .order('last_checked', { ascending: true, nullsFirst: true })
      .order('tier', { ascending: true })
      .limit(maxAccounts);

    if (error) {
      debugLog.push(`[accounts] smart query failed: ${error.message}`);
      console.error(`[scanXAccounts] smart query failed:`, error.message);
    } else if (data?.length) {
      accounts = data;
      debugLog.push(`[accounts] smart query found ${data.length} accounts`);
    } else {
      debugLog.push(`[accounts] smart query returned no data`);
    }
  } catch (e: any) {
    debugLog.push(`[accounts] smart query exception: ${e.message}`);
    console.error(`[scanXAccounts] smart query exception:`, e.message);
  }

  // Attempt 2: fallback — if smart query fails (missing columns), try handle only
  if (!accounts.length) {
    try {
      const { data, error } = await supabase
        .from('accounts')
        .select('handle')
        .limit(maxAccounts);

      if (error) {
        debugLog.push(`[accounts-fallback] error: ${error.message}`);
      } else if (data?.length) {
        accounts = data;
        debugLog.push(`[accounts-fallback] found ${data.length} accounts`);
      }
    } catch (e: any) {
      debugLog.push(`[accounts-fallback] exception: ${e.message}`);
    }
  }

  console.log(`[scanXAccounts] Found ${accounts.length} accounts to scan`);

  // 1.5. Load manually added tweets
  let manualTweetsCount = 0;
  let allAnalyzed: any[] = [];
  let allMedia: MediaFromTweet[] = [];
  let viralFound = 0;
  let totalAnalyzed = 0;

  try {
    const { data: manualTweets, error: mtError } = await supabase
      .from('viral_tweet_analyses')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (mtError) {
      debugLog.push(`[manual-tweets] error: ${mtError.message}`);
      console.error(`[scanXAccounts] manual tweets error:`, mtError.message);
    } else if (manualTweets?.length) {
      manualTweetsCount = manualTweets.length;
      for (const t of manualTweets) {
        totalAnalyzed++;
        // media_type not in table — extract media from analysis_payload or metrics
        const tweetMedia: MediaFromTweet[] = [];
        const payload = t.analysis_payload || {};
        if (payload.media_impact && payload.media_impact !== 'text_only') {
          tweetMedia.push({ type: 'photo', url: '', alt_text: '' });  // Estimated
        }

        if (t.engagement_score > 20 || t.engagement_per_1k_followers > 5) {
          viralFound++;
        }

        allAnalyzed.push({
          tweet_id: t.tweet_id,
          tweet_url: t.tweet_url,
          username: t.creator_handle,
          text: t.tweet_text,
          score: t.engagement_score,
          engagement_per_1k_followers: t.engagement_per_1k_followers,
          metrics: t.metrics || {},
          has_media: t.tweet_type === 'media' || (t.analysis_payload?.media_impact && t.analysis_payload.media_impact !== 'text_only'),
          media: tweetMedia,
          has_question: (t.tweet_text || '').includes('?'),
          is_reply: t.tweet_type === 'reply',
          handle: t.creator_handle
        });

        allMedia.push(...tweetMedia);
      }
      debugLog.push(`[manual-tweets] loaded ${manualTweetsCount} tweets`);
      console.log(`[scanXAccounts] Loaded ${manualTweetsCount} manually analyzed tweets`);
    } else {
      debugLog.push(`[manual-tweets] no data found`);
    }
  } catch (e: any) {
    debugLog.push(`[manual-tweets] exception: ${e.message}`);
    console.error(`[scanXAccounts] Failed to load manual tweets: ${e.message}`);
  }

  // 2. Crawl each account
  for (const account of accounts.slice(0, maxAccounts)) {
    try {
      const handle = account.handle || account.username;
      if (!handle) {
        debugLog.push(`[scan] skipping account with no handle: ${JSON.stringify(account).slice(0, 100)}`);
        continue;
      }
      console.log(`[scanXAccounts] Scanning @${handle}...`);
      const tweets = await getXUserTimeline(handle, tweetsPerAccount, true);
      debugLog.push(`[scan] @${handle}: got ${tweets.length} tweets`);

      for (const tweet of tweets) {
        totalAnalyzed++;
        const user = { username: handle, followers_count: 0, public_metrics: { followers_count: 0 } };
        const analysis = analyzeXTweet(tweet, user);
        const score = scoreXTweet(tweet);
        const media = extractMediaFromTweet(tweet);

        // ═══ Deep AI analysis for each viral tweet ═══
        // Light mode: skip deep AI analysis — just store metrics
        let deepAnalysis: any = null;
        if (score > 15 && !lightMode) {
          try {
            const m: any = tweet.public_metrics || {};
            const aiResult = await callModel('learning_extraction' as TaskType, [
              {
                role: 'system',
                content: `You are a viral content analyst. Analyze WHY this tweet performed well and extract transferable patterns. Be specific and actionable. Output valid JSON only.`
              },
              {
                role: 'user',
                content: `Analyze this tweet from @${handle}:
Text: "${(analysis.text || '').slice(0, 400)}"
Type: ${media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original')}
Metrics: likes=${m.like_count||0} replies=${m.reply_count||0} retweets=${m.retweet_count||0} quotes=${m.quote_count||0} bookmarks=${m.bookmark_count||0} views=${m.view_count||0}
Score: ${score}

Extract:
1. "viral_reason": WHY this tweet went viral (specific mechanism, not generic)
2. "style_pattern": The writing style technique used (hook, structure, voice)
3. "media_impact": How media/visuals contributed (or "text_only" if no media)
4. "timing_insight": What about the timing or context helped
5. "tweet_type_insight": What about the tweet type (original/reply/quote) helped
6. "engagement_quality": Quality of engagement (genuine discussion vs vanity metrics)
7. "adaptation": How to apply this EXACT mechanism for @30piq (specific, not generic)
8. "hook_formula": The exact hook formula used (if identifiable)
9. "psychological_trigger": What psychological trigger made people engage
10. "confidence": 1-10 how confident you are in this analysis

JSON format: {"viral_reason":"...","style_pattern":"...","media_impact":"...","timing_insight":"...","tweet_type_insight":"...","engagement_quality":"...","adaptation":"...","hook_formula":"...","psychological_trigger":"...","confidence":N}`
              }
            ], { temperature: 0.1, max_tokens: 1500, response_format: { type: 'json_object' } });

            deepAnalysis = parseModelJson(aiResult);
            debugLog.push(`[scan] @${handle}: deep analysis OK (conf: ${deepAnalysis?.confidence})`);
          } catch (aiErr: any) {
            debugLog.push(`[scan] @${handle}: deep analysis failed: ${aiErr.message}`);
          }
        }

        if (lightMode && score > 15) {
          debugLog.push(`[scan] @${handle}: lightMode — skipped deep analysis (score ${score})`);
        }

        // Store in viral_tweet_analyses — all tweets not just viral ones
        const isViral = score > 20 || analysis.engagement_per_1k_followers > 5;
        if (isViral) viralFound++;

        try {
          const upsertData: any = {
            tweet_id: String(analysis.tweet_id || tweet.id || ''),
            tweet_url: analysis.tweet_url || '',
            creator_handle: handle,
            tweet_text: (analysis.text || '').slice(0, 500),
            engagement_score: score,
            engagement_per_1k_followers: analysis.engagement_per_1k_followers,
            tweet_type: media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original'),
            metrics: analysis.metrics
          };

          // Store deep analysis in analysis_payload
          if (deepAnalysis) {
            upsertData.analysis_payload = deepAnalysis;
            upsertData.hook_formula = deepAnalysis.hook_formula || null;
            upsertData.why_bookmarks = deepAnalysis.engagement_quality || null;
            upsertData.adaptation_for_30piq = deepAnalysis.adaptation || null;
            upsertData.tone = deepAnalysis.style_pattern || null;
            upsertData.format_pattern = deepAnalysis.tweet_type_insight || null;
          }

          await supabase.from('viral_tweet_analyses').upsert(upsertData, { onConflict: 'tweet_id' });
        } catch (dbErr: any) {
          debugLog.push(`[scan] upsert error: ${dbErr.message}`);
        }

        if (isViral) {
          allAnalyzed.push({
            ...analysis,
            score,
            media,
            handle,
            deepAnalysis
          });
        } else {
          // Even normal tweets go to analysis
          allAnalyzed.push({
            ...analysis,
            score,
            media,
            handle,
            deepAnalysis
          });
        }

        allMedia.push(...media);

        // ═══ Learn concepts from each viral tweet immediately ═══
        // Light mode: skip brain learning from individual tweets (kept for daily-run)
        if (isViral && deepAnalysis && !lightMode) {
          try {
            // Store viral reason as rule
            await insertIfMissing(supabase, 'x_algorithm_learning_rules',
              { rule_type: 'viral_pattern', rule: `@${handle}: ${deepAnalysis.viral_reason}` },
              {
                rule_type: 'viral_pattern',
                rule: deepAnalysis.viral_reason,
                evidence: `@${handle} tweet (score: ${score}): "${(analysis.text || '').slice(0, 80)}..."`,
                source_type: 'real_time_crawl',
                source_url: analysis.tweet_url,
                applies_to: 'content_strategy,engagement_crafting',
                confidence_score: Math.min(10, deepAnalysis.confidence || 5),
                status: 'active',
                test_run: false,
                updated_at: new Date().toISOString()
              }
            );
            brainUpdates.algorithmRules++;

            // Store psychological pattern
            if (deepAnalysis.psychological_trigger) {
              await insertIfMissing(supabase, 'x_algorithm_learning_rules',
                { rule_type: 'psychological_trigger', rule: deepAnalysis.psychological_trigger },
                {
                  rule_type: 'psychological_trigger',
                  rule: deepAnalysis.psychological_trigger,
                  evidence: `Trigger in @${handle} viral tweet (score: ${score})`,
                  source_type: 'real_time_crawl',
                  applies_to: 'hook_crafting,engagement_crafting',
                  confidence_score: Math.min(10, (deepAnalysis.confidence || 5) - 1),
                  status: 'active',
                  test_run: false,
                  updated_at: new Date().toISOString()
                }
              );
              brainUpdates.algorithmRules++;
            }

            // Store style pattern
            if (deepAnalysis.style_pattern || deepAnalysis.adaptation) {
              try {
                await insertIfMissing(supabase, 'viral_style_patterns',
                  { pattern_name: deepAnalysis.hook_formula || deepAnalysis.style_pattern?.slice(0, 80) || `Pattern from @${handle}` },
                  {
                    pattern_name: deepAnalysis.hook_formula || deepAnalysis.style_pattern?.slice(0, 80) || `Pattern from @${handle}`,
                    pattern_description: deepAnalysis.style_pattern || '',
                    adaptation_for_30piq: deepAnalysis.adaptation || '',
                    pattern_type: deepAnalysis.psychological_trigger ? 'hook' : 'structure',
                    why_it_works: deepAnalysis.viral_reason || '',
                    source_handles: [handle],
                    source_tweet_urls: [analysis.tweet_url],
                    confidence_score: Math.min(10, deepAnalysis.confidence || 5),
                    status: 'active',
                    test_run: false,
                    updated_at: new Date().toISOString()
                  }
                );
                brainUpdates.stylePatterns++;
              } catch (spErr: any) {
                debugLog.push(`[scan] style pattern insert error: ${spErr.message}`);
              }
            }
          } catch (learnErr: any) {
            debugLog.push(`[scan] learning error: ${learnErr.message}`);
          }
        }
      }

      // Update account state — only columns that actually exist in the table
      // Table has: handle, tier, category, followers, avg_engagement, our_reply_count, last_reply_date, last_checked, notes, created_at
      // Does not have: last_scanned_at, updated_at, active, username — do not send them!
      try {
        const snapshot = await getXUserByUsername(handle);
        await supabase.from('accounts').update({
          notes: `Followers: ${snapshot.followers_count}, Scanned: ${new Date().toISOString()}`,
          last_checked: new Date().toISOString(),  // ← Correct column in DB
          followers: snapshot.followers_count || null
        }).eq('handle', handle);
      } catch (updErr: any) {
        debugLog.push(`[scan] update account error: ${updErr.message}`);
      }

    } catch (e: any) {
      const handle = account.handle || account.username || '?';
      debugLog.push(`[scan] FAILED @${handle}: ${e.message}`);
      console.error(`Failed to scan @${handle}:`, e.message);
    }
  }

  // 3. Brain learning from crawled data
  try {
    // Fetch stored viral rules from previous analyses (from manually added tweets)
    const { data: existingViralRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule_type, rule, evidence')
      .in('rule_type', ['viral_pattern', 'spread_pattern', 'media_impact'])
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(30);

    // Fetch stored style patterns
    const { data: existingStylePatterns } = await supabase
      .from('viral_style_patterns')
      .select('pattern_name, pattern_description, adaptation_for_30piq')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(30);

    // Build rich learning items — including deep analysis + metrics
    const crawlerItems = allAnalyzed.map(a => {
      // Find related viral rule
      const relatedRule = (existingViralRules || []).find((r: any) =>
        r.evidence?.includes(a.username) || r.evidence?.includes(a.tweet_id)
      );
      const relatedStyle = (existingStylePatterns || []).find((p: any) =>
        p.pattern_name?.includes(a.username) || p.evidence?.includes(a.username)
      );

      // Build rich summary including deep analysis
      const mediaDesc = a.media?.length > 0
        ? `Contains ${a.media.map((m: MediaFromTweet) => m.type).join('+')}`
        : 'Text only';
      const deepInsight = relatedRule?.rule || '';
      const styleInsight = relatedStyle?.pattern_description || '';

      let summary = `Engagement: ${a.score}, per 1K followers: ${a.engagement_per_1k_followers}, ${mediaDesc}`;
      if (deepInsight) summary += ` | Viral reason: ${deepInsight.slice(0, 150)}`;
      if (styleInsight) summary += ` | Style: ${styleInsight.slice(0, 100)}`;

      return {
        title: a.text?.slice(0, 200) || 'Tweet analysis',
        url: a.tweet_url,
        summary,
        confidence_score: Math.min(10, Math.max(1, Math.round(a.score / 10))),
      };
    });

    if (crawlerItems.length > 0) {
      const learned = await learnFromCrawlerItems(supabase, {
        runType: 'x_account_scan_v3',
        source: 'twitter_scan',
        items: crawlerItems,
        mode: 'production'
      });
      // ═══ Add to existing counter instead of replacing ═══
      // Previously brainUpdates = { ...learned } which would erase directly-added patterns
      brainUpdates.algorithmRules += learned.algorithmRules;
      brainUpdates.stylePatterns += learned.stylePatterns;
      brainUpdates.mcpOpportunities += learned.mcpOpportunities;
    }
  } catch (e: any) {
    debugLog.push(`[brain] learning failed: ${e.message}`);
    console.error('Brain learning failed:', e.message);
  }

  // 3.5. Concept learning: find shared patterns across tweets and discover general concepts
  // Light mode: skip batch concept extraction (AI-heavy, kept for daily-run)
  if (!lightMode) try {
    if (allAnalyzed.length >= 2) {
      // Collect all tweet texts and analyses together so AI can discover shared concepts
      const tweetsForConcept = allAnalyzed
        .filter(a => (a.score || 0) > 20)
        .slice(0, 15)
        .map(a => ({
          text: a.text?.slice(0, 150),
          score: a.score,
          handle: a.handle || a.username,
          media: a.media?.map((m: MediaFromTweet) => m.type).join(',') || 'none',
          per1k: a.engagement_per_1k_followers
        }));

      if (tweetsForConcept.length >= 2) {
        const conceptResponse = await callModel('learning_extraction' as TaskType, [
          {
            role: 'system',
            content: `You are an expert viral pattern analyst. You are given a set of successful tweets and must discover the shared concepts between them.

Your task: Discover 1-3 general concepts/patterns shared across these tweets. Each concept must be:
1. Specific and actionable (not generic like "good content")
2. Connecting multiple tweets together
3. Providing a transferable recommendation — how can this MECHANIC (not topic) be applied to any account

Respond in JSON only:
{
  "concepts": [
    {
      "name": "Concept name",
      "description": "Explanation of the concept and its connection to the tweets",
      "adaptation": "How to apply this mechanic to any account"
    }
  ]
}`
          },
          {
            role: 'user',
            content: `Analyze these tweets and discover shared concepts:

${tweetsForConcept.map((t, i) => `${i + 1}. @${t.handle} (engagement: ${t.score}, media: ${t.media}): "${t.text}"`).join('\n\n')}`
          }
        ], { temperature: 0.15, max_tokens: 2000, response_format: { type: 'json_object' } });

        const parsed = parseModelJson(conceptResponse);
        const concepts = parsed.concepts || [];

        for (const concept of concepts.slice(0, 3)) {
          if (concept.name && concept.description) {
            await insertIfMissing(supabase, 'x_algorithm_learning_rules',
              { rule_type: 'viral_concept', rule: `${concept.name}: ${concept.description}` },
              {
                rule_type: 'viral_concept',
                rule: `${concept.name}: ${concept.description}`,
                evidence: `Shared concept extracted from ${tweetsForConcept.length} viral tweets`,
                source_type: 'batch_concept_extraction',
                source_url: '',
                applies_to: 'content_strategy,engagement_crafting',
                confidence_score: Math.min(10, 5 + Math.floor(tweetsForConcept.length / 3)),
                status: 'active',
                test_run: false,
                updated_at: new Date().toISOString()
              }
            );
            brainUpdates.algorithmRules++;

            // Also store as style pattern
            if (concept.adaptation) {
              try {
                await insertIfMissing(supabase, 'viral_style_patterns',
                  { pattern_name: concept.name.slice(0, 100) },
                  {
                    pattern_name: concept.name.slice(0, 100),
                    pattern_description: concept.description,
                    adaptation_for_30piq: concept.adaptation,
                    pattern_type: 'structure',  // ← Required NOT NULL!
                    why_it_works: `Shared concept from ${tweetsForConcept.length} viral tweets`,
                    source_handles: [],
                    source_tweet_urls: [],
                    confidence_score: Math.min(10, 5 + Math.floor(tweetsForConcept.length / 3)),
                    status: 'active',
                    test_run: false,
                    updated_at: new Date().toISOString()
                  }
                );
                brainUpdates.stylePatterns++;
              } catch (spErr: any) {
                debugLog.push(`[brain-concepts] style pattern insert error: ${spErr.message}`);
              }
            }
          }
        }
        debugLog.push(`[brain-concepts] extracted ${concepts.length} concepts from ${tweetsForConcept.length} tweets`);
      }
    }
  } catch (e: any) {
    debugLog.push(`[brain-concepts] concept extraction failed: ${e.message}`);
    console.error('Concept extraction failed:', e.message);
  }

  if (lightMode) {
    debugLog.push('[brain-concepts] lightMode — skipped batch concept extraction');
  }

  // 3.5. Brain learning of media patterns
  try {
    const accountMediaStats: Record<string, { total: number; withMedia: number; types: Set<string> }> = {};
    for (const a of allAnalyzed) {
      const handle = a.handle || a.username || 'unknown';
      if (!accountMediaStats[handle]) accountMediaStats[handle] = { total: 0, withMedia: 0, types: new Set() };
      accountMediaStats[handle].total++;
      if (a.media?.length > 0) {
        accountMediaStats[handle].withMedia++;
        for (const m of a.media) accountMediaStats[handle].types.add(m.type);
      }
    }

    for (const [handle, stats] of Object.entries(accountMediaStats)) {
      if (stats.withMedia > 0) {
        const mediaRatio = Math.round((stats.withMedia / stats.total) * 100);
        const mediaTypes = [...stats.types].join(', ');
        const rule = `@${handle} uses media in ${mediaRatio}% of tweets (${mediaTypes}). Accounts with high media usage get better engagement. Consider media when crafting engagement with their tweets.`;
        await insertIfMissing(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'media_pattern', rule },
          {
            rule_type: 'media_pattern',
            rule,
            evidence: `Scanned ${stats.total} tweets from @${handle}: ${stats.withMedia} had media (${mediaTypes})`,
            source_type: 'x_account_scan_v3',
            source_url: `https://x.com/${handle}`,
            applies_to: 'crawl_strategy,content_score,engagement_crafting',
            confidence_score: Math.min(10, 5 + Math.floor(mediaRatio / 20)),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          }
        );
        brainUpdates.algorithmRules++;
      }
    }
  } catch (e: any) {
    debugLog.push(`[brain-media] pattern failed: ${e.message}`);
    console.error('Media pattern learning failed:', e.message);
  }

  // 4. Discover content opportunities
  // Light mode: skip opportunity discovery (calls callModel for crafting) — just return raw data
  let opportunities: ContentOpportunity[] = [];
  if (lightMode) {
    debugLog.push('[opportunities] lightMode — skipped opportunity discovery');
  } else {
    opportunities = await discoverOpportunities(allAnalyzed, allMedia);
  }

  // 5. ═══ Self-improvement: monitor brain and suspend weak rules ═══
  // Light mode: skip self-improvement (DB-heavy, kept for daily-run)
  if (!lightMode) try {
    const selfImprovement = await selfImproveBrain(supabase, debugLog);
    debugLog.push(`[self-improve] strengthened: ${selfImprovement.strengthened}, weakened: ${selfImprovement.weakened}, pruned: ${selfImprovement.pruned}`);
  } catch (e: any) {
    debugLog.push(`[self-improve] failed: ${e.message}`);
  }

  if (lightMode) {
    debugLog.push('[self-improve] lightMode — skipped self-improvement');
  }

  return {
    accounts_scanned: accounts.length,  // backward compat
    actual_accounts_scanned: accounts.length,
    manual_tweets_loaded: manualTweetsCount,
    tweets_analyzed: totalAnalyzed,
    viral_tweets_found: viralFound,
    opportunities,
    brain_updates: {
      algorithm_rules: brainUpdates.algorithmRules,
      style_patterns: brainUpdates.stylePatterns,
      media_patterns: allMedia.length
    },
    media_downloaded: allMedia.length,
    light_mode: lightMode || undefined,
    debug_log: debugLog
  };
}

// ═══ Media Extraction ═══

/**
 * Extracts media from an X tweet (photos, video, GIF)
 * Version 2 — 7-layer deep exploration
 */
function extractMediaFromTweet(tweet: any, fullApiResponse?: any): MediaFromTweet[] {
  const media: MediaFromTweet[] = [];
  const raw = tweet.raw || tweet;
  const seen = new Set<string>();

  function addMedia(type: 'photo' | 'video' | 'animated_gif', url: string, alt_text = '') {
    if (!url || seen.has(url)) return;
    seen.add(url);
    media.push({ type, url, alt_text });
  }

  // ═══ 1. Direct paths ═══
  if (Array.isArray(raw.photos)) {
    for (const p of raw.photos) {
      const url = typeof p === 'string' ? p : (p.media_url_https || p.url || p.media_url || p.imageUrl || '');
      if (url) addMedia('photo', url, typeof p === 'object' ? (p.alt_text || '') : '');
    }
  }
  if (Array.isArray(raw.videos)) {
    for (const v of raw.videos) {
      const vidUrl = typeof v === 'string' ? v : (v.video_url || v.url || v.preview_url || '');
      if (vidUrl) addMedia(v.type === 'animated_gif' ? 'animated_gif' : 'video', vidUrl, typeof v === 'object' ? (v.alt_text || '') : '');
    }
  }
  if (raw.video && typeof raw.video === 'object' && !Array.isArray(raw.video)) {
    const vidUrl = raw.video.video_url || raw.video.url || raw.video.preview_url || '';
    if (vidUrl) addMedia(raw.video.type === 'animated_gif' ? 'animated_gif' : 'video', vidUrl, raw.video.alt_text || '');
  }
  if (raw.imageUrl) addMedia('photo', raw.imageUrl);
  if (raw.image && typeof raw.image === 'string') addMedia('photo', raw.image);

  // ═══ 2. Unified media arrays ═══
  const sources: any[] = [];
  if (Array.isArray(raw.media)) sources.push(...raw.media);
  if (Array.isArray(raw.mediaDetails)) sources.push(...raw.mediaDetails);
  if (Array.isArray(raw.entities?.media)) sources.push(...raw.entities.media);
  if (Array.isArray(raw.extended_entities?.media)) sources.push(...raw.extended_entities.media);
  if (Array.isArray(raw.extendedEntities?.media)) sources.push(...raw.extendedEntities.media);
  if (Array.isArray(raw.entities?.medias)) sources.push(...raw.entities.medias);
  if (Array.isArray(raw.extendedEntities?.medias)) sources.push(...raw.extendedEntities.medias);

  for (const m of sources) {
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'photo' || m.media_url_https || m.media_url || m.display_url) {
      addMedia('photo', m.media_url_https || m.media_url || m.url || m.display_url || m.imageUrl || '', m.alt_text || m.ext_alt_text || '');
    } else if (m.type === 'video') {
      const variant = m.video_info?.variants?.find((v: any) => v.content_type === 'video/mp4') || m.video_info?.variants?.[0];
      addMedia('video', variant?.url || m.video_url || m.url || '', m.alt_text || m.ext_alt_text || '');
    } else if (m.type === 'animated_gif') {
      const variant = m.video_info?.variants?.find((v: any) => v.content_type === 'video/mp4') || m.video_info?.variants?.[0];
      addMedia('animated_gif', variant?.url || m.video_url || m.url || '', m.alt_text || m.ext_alt_text || '');
    }
  }

  // ═══ 3. Check includes.media (Twitter API v2 format) ═══
  if (fullApiResponse) {
    const includesMedia = fullApiResponse?.includes?.media || fullApiResponse?.data?.includes?.media;
    if (Array.isArray(includesMedia)) {
      for (const m of includesMedia) {
        if (!m || typeof m !== 'object') continue;
        if (m.type === 'photo') {
          addMedia('photo', m.url || m.media_url || m.media_url_https || '');
        } else if (m.type === 'video') {
          const variant = m.variants?.find((v: any) => v.content_type === 'video/mp4') || m.variants?.[0];
          addMedia('video', variant?.url || m.url || '');
        } else if (m.type === 'animated_gif') {
          const variant = m.variants?.find((v: any) => v.content_type === 'video/mp4') || m.variants?.[0];
          addMedia('animated_gif', variant?.url || m.url || '');
        }
      }
    }
  }

  // ═══ 4. Check entities.urls ═══
  const urlSources: any[] = [];
  if (Array.isArray(raw.entities?.urls)) urlSources.push(...raw.entities.urls);
  if (Array.isArray(raw.extended_entities?.urls)) urlSources.push(...raw.extended_entities.urls);
  if (Array.isArray(raw.extendedEntities?.urls)) urlSources.push(...raw.extendedEntities.urls);
  for (const u of urlSources) {
    if (!u || typeof u !== 'object') continue;
    const expandedUrl = u.expanded_url || u.expandedUrl || u.url || '';
    if (/twimg\.com\/media/i.test(expandedUrl)) addMedia('photo', expandedUrl);
  }

  // ═══ 5. Check t.co links ═══
  const tweetText = raw.text || raw.full_text || raw.content || '';
  const tcoMatches = tweetText.match(/https?:\/\/t\.co\/\S+/g) || [];
  for (const tcoUrl of tcoMatches) {
    const match = urlSources.find((u: any) => u.url === tcoUrl);
    const expanded = match?.expanded_url || match?.expandedUrl;
    if (expanded && /twimg\.com/i.test(expanded)) addMedia('photo', expanded);
  }

  // ═══ 6. Check additional TwitterAPI.io formats ═══
  if (Array.isArray(raw.mallizedUrls)) {
    for (const u of raw.mallizedUrls) {
      if (u?.media_url_https) addMedia('photo', u.media_url_https);
      if (u?.video_url) addMedia('video', u.video_url);
    }
  }
  if (Array.isArray(raw.photoUrls)) {
    for (const p of raw.photoUrls) { if (typeof p === 'string' && p) addMedia('photo', p); }
  }
  if (Array.isArray(raw.videoUrls)) {
    for (const v of raw.videoUrls) { if (typeof v === 'string' && v) addMedia('video', v); }
  }

  // ═══ 7. Deep exploration ═══
  if (media.length === 0) {
    deepScanForMedia(raw, addMedia, '', 0);
  }

  return media;
}

/**
 * Recursive deep scan — searches for any media object anywhere in the tree
 */
function deepScanForMedia(obj: any, addMedia: (type: 'photo' | 'video' | 'animated_gif', url: string, alt?: string) => void, path: string, depth: number) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      deepScanForMedia(obj[i], addMedia, `${path}[${i}]`, depth + 1);
    }
    return;
  }

  const type = obj.type;
  const mediaUrl = obj.media_url_https || obj.media_url || obj.imageUrl || obj.display_url;
  const videoUrl = obj.video_url || obj.video_info?.variants?.[0]?.url;
  const thumbUrl = obj.thumbnail_url || obj.thumbnail_image_url || obj.preview_url;

  if (type === 'photo' && mediaUrl) {
    addMedia('photo', mediaUrl, obj.alt_text || obj.ext_alt_text || '');
  } else if (type === 'video' && (videoUrl || thumbUrl)) {
    addMedia('video', videoUrl || thumbUrl || '', obj.alt_text || '');
  } else if (type === 'animated_gif' && (videoUrl || thumbUrl)) {
    addMedia('animated_gif', videoUrl || thumbUrl || '', obj.alt_text || '');
  } else if (mediaUrl && /twimg\.com|pbs\.twimg/i.test(mediaUrl)) {
    addMedia('photo', mediaUrl, obj.alt_text || '');
  } else if (videoUrl && /twimg\.com|video\.twimg/i.test(videoUrl)) {
    addMedia('video', videoUrl, obj.alt_text || '');
  }

  try {
    for (const key of Object.keys(obj)) {
      if (['raw', 'author', 'user', '__proto__', 'constructor'].includes(key)) continue;
      deepScanForMedia(obj[key], addMedia, `${path}.${key}`, depth + 1);
    }
  } catch {}
}

// ═══ Fetch Conversation Context ═══

/**
 * Fetches replies and interactions for a tweet from TwitterAPI.io
 * This gives the brain deeper understanding: what people said, how they reacted, the real reason
 */
async function fetchConversationContext(
  tweetId: string,
  username: string
): Promise<{ replies: string[]; topReplierInsight: string }> {
  try {
    const url = new URL(`${twitterApiBase()}/twitter/tweet/replies`);
    url.searchParams.set('tweetId', tweetId);
    const json = await fetchTwitterApiJson(url.toString());
    const replies = extractTweets(json).slice(0, 10);

    if (!replies.length) return { replies: [], topReplierInsight: '' };

    const replyTexts = replies
      .map(r => r.text || '')
      .filter(t => t.length > 5)
      .slice(0, 8);

    // Quick summary: what the majority says
    const themes = replyTexts.slice(0, 5).map(t => t.slice(0, 100)).join(' | ');
    const topReplierInsight = `Top reply themes: ${themes}`;

    return { replies: replyTexts, topReplierInsight };
  } catch (e: any) {
    console.log('[fetchConversationContext] Could not fetch replies:', e.message);
    return { replies: [], topReplierInsight: '' };
  }
}

// ═══ Multi-angle Deep Analysis ═══

/**
 * Deep multi-angle analysis — v3.2
 *
 * Difference from v3.1:
 * - v3.1: Single pass, 7 generic fields, no conversation context
 * - v3.2: Fetches conversation context + 5-angle analysis + precise concept extraction
 *         + confidence assessment based on evidence quantity
 *         + All results in English (content language)
 */
async function deepAnalyzeWithAI(
  tweetText: string,
  metrics: Record<string, number>,
  followers: number,
  media: MediaFromTweet[],
  username: string,
  tweetType: 'original' | 'quote' | 'reply' | 'thread_starter' = 'original',
  quotedTweetText: string = '',
  quotedTweetAuthor: string = '',
  createdAt: string | null = null,
  timeLabel: string | null = null,
  tweetId: string = '',
  existingBrainRules: any[] = []
): Promise<DeepAnalysis> {
  const score = (metrics.like_count || 0) + (metrics.reply_count || 0) * 2 +
    (metrics.retweet_count || 0) * 3 + (metrics.quote_count || 0) * 4 +
    (metrics.bookmark_count || 0) * 2 + Math.min(metrics.view_count || 0, 100000) / 1000;

  const likeToFollowerRatio = followers > 0 ? ((metrics.like_count || 0) / followers).toFixed(4) : 'N/A';
  const replyRatio = (metrics.like_count || 0) > 0 ? ((metrics.reply_count || 0) / metrics.like_count!).toFixed(3) : '0';
  const rtRatio = (metrics.like_count || 0) > 0 ? ((metrics.retweet_count || 0) / metrics.like_count!).toFixed(3) : '0';
  const quoteRatio = (metrics.like_count || 0) > 0 ? ((metrics.quote_count || 0) / metrics.like_count!).toFixed(3) : '0';
  const bookmarkRatio = (metrics.like_count || 0) > 0 ? ((metrics.bookmark_count || 0) / metrics.like_count!).toFixed(3) : '0';

  const mediaDesc = media.length > 0
    ? `Contains ${media.map(m => m.type).join(' + ')}`
    : 'Text only, no media';

  // ═══ Fetch conversation context (people's replies) ═══
  let conversationData = { replies: [] as string[], topReplierInsight: '' };
  if (tweetId && (metrics.reply_count || 0) > 5) {
    conversationData = await fetchConversationContext(tweetId, username);
  }

  const quoteContext = tweetType === 'quote' && quotedTweetText
    ? `\nQuoted Tweet by @${quotedTweetAuthor}: "${quotedTweetText.slice(0, 300)}"\nThis is a QUOTE TWEET — the author is commenting on the above tweet. Analyze how the commentary adds value or creates contrast with the original.`
    : '';

  const replyContext = tweetType === 'reply'
    ? `\nThis is a REPLY tweet — it's part of a conversation. The virality likely comes from the reply adding significant value, humor, or a contrarian take to the original discussion.`
    : '';

  const timingContext = timeLabel
    ? `\nPosted at: ${timeLabel}. Consider if this timing aligns with peak engagement hours for the audience.`
    : '';

  const repliesContext = conversationData.replies.length > 0
    ? `\n\nSample of real replies people wrote:\n${conversationData.replies.slice(0, 5).map((r, i) => `  ${i + 1}. "${r.slice(0, 120)}"`).join('\n')}\n\nThese replies reveal WHY people engaged — study them for the actual trigger.`
    : '';

  // ═══ Existing concepts in the brain — so it doesn't repeat and builds on them ═══
  const existingConceptsSummary = existingBrainRules.length > 0
    ? `\n\nExisting concepts already in the brain (do NOT repeat these — find NEW insights):\n${existingBrainRules.slice(0, 8).map(r => `- [${r.rule_type}] ${String(r.rule).slice(0, 100)}`).join('\n')}`
    : '';

  try {
    const aiResponse = await callModel('deep_analysis' as TaskType, [
      {
        role: 'system',
        content: `You are an expert viral content analyst who thinks like a researcher, not a content marketer. You analyze X (Twitter) posts to understand exactly WHY they went viral — from multiple angles, with evidence-based reasoning.

CRITICAL RULES:
1. ALL output must be in ENGLISH (the account content is English, analysis must match)
2. Do NOT assume any specific niche for @30piq — the account covers diverse topics and can tweet about anything
3. Be specific and precise — NEVER use vague phrases like "engaging content", "high interaction", "resonated with audience". Name the exact psychological mechanism.
4. Every claim must reference SPECIFIC data from the tweet — text, metrics, replies, or context. No speculation without evidence.
5. Think in angles — analyze from multiple perspectives, then synthesize

ANALYSIS FRAMEWORK — Think through these 5 angles:

ANGLE 1: TEXT MECHANICS
- What specifically about the wording made it spread? Not "short tweet" but exact technique: "Opens with a contrarian claim that challenges conventional wisdom, then reveals the insight in a single line"
- Is it a question, a statement, a revelation, a hot take, humor, vulnerability, a challenge?
- What structural technique? (setup→punchline, before→after, claim→evidence, observation→implication)

ANGLE 2: PSYCHOLOGICAL TRIGGER
- What specific psychological mechanism activated? Choose one or more:
  Identity signaling (people RT to signal who they are), Validation (people see their experience reflected),
  Surprise/Novelty (unexpected insight), Status sharing (sharing makes you look smart/connected),
  Controversy/Debate (forces people to take sides), Humor/Social currency (sharing makes others laugh),
  FOMO (fear of missing out), Practical value (bookmark-worthy utility)
- Why did THIS specific trigger work for THIS specific audience?

ANGLE 3: ENGAGEMENT ARCHAEOLOGY
- Reply/Like ratio → Did it spark discussion? What were people discussing (see actual replies)?
- RT/Like ratio → Was it shareable as an opinion or information?
- Quote/Like ratio → Did people add their own takes? What angle did they take?
- Bookmark/Like ratio → Was it reference-worthy? Why save it?
- Like/Follower ratio → Did it break out of the author's audience? To whom?

ANGLE 4: CONTEXT & TYPE
- Is it original, quote, reply, thread starter? How does the TYPE create the viral condition?
- If quote tweet: what's the contrast/added value between original and commentary?
- If reply: what value did it add to the original conversation?
- Timing: does the posting time suggest alignment with a trend, event, or peak hours?
- Language/cultural context: any slang, references, or cultural signals?

ANGLE 5: TRANSFERABLE CONCEPT
- Extract the ONE transferable mechanic — not the topic, but the PATTERN
- This must be so specific that someone could apply it to any niche
- Example BAD: "Share valuable insights" → Example GOOD: "Make a bold counter-intuitive claim about a common tool, then reveal the hidden cost nobody considers"
- What evidence from THIS tweet supports this concept?

Respond in JSON only, no additional text:
{
  "viralReason": "The exact reason it went viral — specific mechanism connected to specific evidence",
  "stylePattern": "The writing technique — name the specific structural device, not just 'concise'",
  "adaptation": "How to apply this MECHANIC (not topic) — must be actionable and niche-independent",
  "mediaImpact": "How media contributed — specific reason, or 'Text-driven virality, media not primary driver'",
  "timingInsight": "Timing analysis with evidence — or 'Timing not a significant factor' with reason",
  "tweetTypeInsight": "How the tweet type contributed — specific mechanism, not just 'quote tweet'",
  "engagementQuality": "What ratios reveal about audience behavior — specific, not generic",
  "psychologicalTrigger": "The primary psychological mechanism — name it specifically with evidence",
  "audienceProfile": "Who engaged and why — based on reply analysis and ratio evidence",
  "conversationContext": "What the replies reveal about WHY people engaged — quote actual reply themes",
  "preciseConcept": "The ONE transferable concept — so specific it could be a formula",
  "conceptEvidence": "Specific data points from THIS tweet that prove the concept",
  "confidenceLevel": "high (3+ strong evidence points), medium (1-2 evidence points), or low (mostly inference)"
}`
      },
      {
        role: 'user',
        content: `Analyze this tweet from multiple angles:

Text: "${tweetText}"

Author: @${username}
Followers: ${followers}
Engagement Score: ${score}
Tweet Type: ${tweetType}${quoteContext}${replyContext}${timingContext}

Metrics:
- Likes: ${metrics.like_count || 0}
- Replies: ${metrics.reply_count || 0}
- Retweets: ${metrics.retweet_count || 0}
- Quotes: ${metrics.quote_count || 0}
- Bookmarks: ${metrics.bookmark_count || 0}
- Views: ${metrics.view_count || 0}

Ratios:
- Like/Follower: ${likeToFollowerRatio}
- Reply/Like: ${replyRatio}
- RT/Like: ${rtRatio}
- Quote/Like: ${quoteRatio}
- Bookmark/Like: ${bookmarkRatio}

Media: ${mediaDesc}${repliesContext}${existingConceptsSummary}

Give a deep, multi-angle analysis with evidence. Every claim must reference specific data above.`
      }
    ], { temperature: 0.12, max_tokens: 4000, response_format: { type: 'json_object' } });

    const parsed = parseModelJson(aiResponse);
    const confidence = parsed.confidenceLevel;
    const validConfidence = ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium';

    return {
      viralReason: parsed.viralReason || 'Analysis unavailable',
      stylePattern: parsed.stylePattern || 'Pattern unidentified',
      adaptation: parsed.adaptation || 'No adaptation suggestion',
      mediaImpact: parsed.mediaImpact || mediaDesc,
      timingInsight: parsed.timingInsight || 'No timing data available',
      tweetTypeInsight: parsed.tweetTypeInsight || `${tweetType} tweet`,
      engagementQuality: parsed.engagementQuality || 'Standard engagement pattern',
      psychologicalTrigger: parsed.psychologicalTrigger || 'Unidentified trigger',
      audienceProfile: parsed.audienceProfile || 'General audience',
      conversationContext: parsed.conversationContext || 'No reply data available',
      preciseConcept: parsed.preciseConcept || 'No concept extracted',
      conceptEvidence: parsed.conceptEvidence || 'No specific evidence cited',
      confidenceLevel: validConfidence as 'high' | 'medium' | 'low'
    };
  } catch (e: any) {
    console.error('[deepAnalyzeWithAI] AI analysis failed, using fallback:', e.message);

    const likeToFoll = followers > 0 ? (metrics.like_count || 0) / followers : 0;
    const reasons: string[] = [];
    if (likeToFoll > 0.1) reasons.push(`Very high like/follower ratio (${(likeToFoll * 100).toFixed(1)}%) — content reached far beyond the author's audience`);
    if (parseFloat(replyRatio) > 0.3) reasons.push(`High reply ratio (${replyRatio}) — sparked discussion`);
    if (parseFloat(rtRatio) > 0.3) reasons.push(`High RT ratio (${rtRatio}) — highly shareable content`);
    if (parseFloat(quoteRatio) > 0.2) reasons.push(`High quote ratio (${quoteRatio}) — triggered strong reactions`);
    if (media.length > 0) reasons.push(`Contains media (${media.map(m => m.type).join(', ')})`);
    if (!reasons.length) reasons.push(`High total engagement (${score})`);

    return {
      viralReason: reasons.slice(0, 3).join(' | '),
      stylePattern: `${tweetText.length < 100 ? 'Short and concise' : tweetText.length < 280 ? 'Medium length' : 'Long-form'} ${tweetType} tweet by @${username}`,
      adaptation: 'Apply this spread pattern mechanic to content strategy',
      mediaImpact: mediaDesc,
      timingInsight: timeLabel ? `Posted at ${timeLabel}` : 'No timing data',
      tweetTypeInsight: `${tweetType} tweet`,
      engagementQuality: `Reply/Like: ${replyRatio}, RT/Like: ${rtRatio}, Quote/Like: ${quoteRatio}, Bookmark/Like: ${bookmarkRatio}`,
      psychologicalTrigger: 'Could not determine — AI analysis failed',
      audienceProfile: 'Unknown — AI analysis failed',
      conversationContext: conversationData.topReplierInsight || 'No conversation data',
      preciseConcept: 'No concept extracted — AI analysis failed',
      conceptEvidence: reasons.slice(0, 2).join('; '),
      confidenceLevel: 'low'
    };
  }
}

// ═══ Real Learning System — Merging & Developing Concepts ═══

/**
 * upsertBrainConcept — Brain actually learns
 *
 * Difference from insertIfMissing:
 * - insertIfMissing: skips if concept exists → storage only
 * - upsertBrainConcept: merges evidence + increases confidence + updates rule → real learning
 *
 * Learning mechanism:
 * 1. If concept is new → add with initial confidence
 * 2. If concept exists and matches → increase confidence + add new evidence
 * 3. If concept exists but slightly different → expand the rule
 */
async function upsertBrainConcept(
  supabase: any,
  table: 'x_algorithm_learning_rules' | 'viral_style_patterns',
  matchKey: Record<string, any>,
  payload: Record<string, any>,
  newEvidence: string
): Promise<'inserted' | 'reinforced' | 'failed'> {
  try {
    // Find similar concept
    let query = supabase.from(table).select('*').limit(1);
    for (const [key, val] of Object.entries(matchKey)) {
      query = val == null ? query.is(key, null) : query.eq(key, val);
    }
    const existing = await query.maybeSingle();

    if (!existing.data?.id) {
      // New concept — add it
      const inserted = await supabase.from(table).insert(payload).select('id').single();
      if (inserted.error) throw inserted.error;
      console.log(`[brain-learn] NEW concept: ${String(matchKey[Object.keys(matchKey)[0]]).slice(0, 60)}`);
      return 'inserted';
    }

    // ═══ Existing concept — learn from it (merge + develop) ═══
    const existingData = existing.data;
    const currentConfidence = Number(existingData.confidence_score) || 5;

    // Increase confidence (max 10)
    const newConfidence = Math.min(10, currentConfidence + 0.5);

    // Update based on table type — each table has different columns
    if (table === 'viral_style_patterns') {
      // viral_style_patterns has no evidence or source_type
      // Update confidence + source_handles if present
      const existingHandles: string[] = Array.isArray(existingData.source_handles) ? existingData.source_handles : [];
      // Try to extract handle from new evidence
      const handleMatch = newEvidence.match(/@(\w+)/);
      const newHandle = handleMatch ? handleMatch[1] : null;
      const updatedHandles = newHandle && !existingHandles.includes(newHandle)
        ? [...existingHandles, newHandle].slice(0, 10)
        : existingHandles;

      const updateResult = await supabase
        .from(table)
        .update({
          confidence_score: newConfidence,
          source_handles: updatedHandles,
          updated_at: new Date().toISOString(),
          test_run: false
        })
        .eq('id', existingData.id);

      if (updateResult.error) throw updateResult.error;
    } else {
      // x_algorithm_learning_rules has evidence
      const existingEvidence = existingData.evidence || '';
      const updatedEvidence = existingEvidence.length > 800
        ? `${existingEvidence.slice(0, 400)} | +${newEvidence.slice(0, 300)}`
        : `${existingEvidence} | +${newEvidence}`;

      const updateResult = await supabase
        .from(table)
        .update({
          confidence_score: newConfidence,
          evidence: updatedEvidence.slice(0, 1000),
          updated_at: new Date().toISOString(),
          test_run: false
        })
        .eq('id', existingData.id);

      if (updateResult.error) throw updateResult.error;
    }

    console.log(`[brain-learn] REINFORCED concept (${currentConfidence.toFixed(1)}→${newConfidence.toFixed(1)}): ${String(matchKey[Object.keys(matchKey)[0]]).slice(0, 60)}`);
    return 'reinforced';
  } catch (e: any) {
    console.error('[upsertBrainConcept] failed:', e.message);
    return 'failed';
  }
}

// ═══ Engagement Opportunities ═══

async function discoverOpportunities(
  analyzed: any[],
  media: MediaFromTweet[]
): Promise<ContentOpportunity[]> {
  if (!analyzed.length) return [];

  const supabase = supabaseAdmin();
  const opportunities: ContentOpportunity[] = [];

  const { data: algoRules } = await supabase
    .from('x_algorithm_learning_rules')
    .select('rule_type, rule, applies_to, evidence')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  const { data: stylePatterns } = await supabase
    .from('viral_style_patterns')
    .select('pattern_name, pattern_description, adaptation_for_30piq')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  const sorted = [...analyzed].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);

  for (const tweet of sorted) {
    const tweetMedia = tweet.media || [];
    const rulesUsed: string[] = [];

    // ═══ Lowered thresholds — even medium tweets produce opportunities ═══
    if (tweet.has_question || tweet.score > 10) {
      const crafted = await craftEngagement('quote', tweet, algoRules || [], stylePatterns || [], rulesUsed);
      if (crafted) {
        const shieldResult = quickShieldCheck(crafted);
        opportunities.push({
          type: 'quote',
          source_tweet_url: tweet.tweet_url,
          source_text: tweet.text?.slice(0, 200) || '',
          source_author: tweet.handle || tweet.username || '',
          source_metrics: tweet.metrics || {},
          media_urls: tweetMedia,
          crafted_text: crafted,
          why: tweet.has_question ? 'Question sparks discussion' : `High engagement (${tweet.score})`,
          brain_rules_used: rulesUsed,
          shield_passed: shieldResult.safe,
          shield_issues: shieldResult.reasons
        });
      }
    }

    if (tweet.score > 5 && !tweet.is_reply) {
      const crafted = await craftEngagement('reply', tweet, algoRules || [], stylePatterns || [], rulesUsed);
      if (crafted) {
        const shieldResult = quickShieldCheck(crafted);
        opportunities.push({
          type: 'reply',
          source_tweet_url: tweet.tweet_url,
          source_text: tweet.text?.slice(0, 200) || '',
          source_author: tweet.handle || tweet.username || '',
          source_metrics: tweet.metrics || {},
          media_urls: tweetMedia,
          crafted_text: crafted,
          why: 'Valuable tweet worth adding a useful reply',
          brain_rules_used: rulesUsed,
          shield_passed: shieldResult.safe,
          shield_issues: shieldResult.reasons
        });
      }
    }
  }

  // ═══ Persistent thread from brain — even if not enough tweets ═══
  // Always try to craft a thread from brain patterns
  const threadCrafted = await craftThreadFromBrain(algoRules || [], stylePatterns || []);
  if (threadCrafted) {
    const shieldResult = quickShieldCheck(threadCrafted.text);
    opportunities.push({
      type: threadCrafted.type,
      source_tweet_url: '',
      source_text: 'Built from brain patterns',
      source_author: 'brain',
      source_metrics: {},
      media_urls: [],
      crafted_text: threadCrafted.text,
      why: threadCrafted.why,
      brain_rules_used: threadCrafted.rules,
      shield_passed: shieldResult.safe,
      shield_issues: shieldResult.reasons
    });
  }

  return opportunities.filter(o => o.shield_passed || o.shield_issues.length <= 2);
}

async function craftEngagement(
  type: 'reply' | 'quote',
  tweet: any,
  algoRules: any[],
  stylePatterns: any[],
  rulesUsed: string[]
): Promise<string | null> {
  try {
    // ═══ Smart retrieval from brain with precise application instructions ═══
    const brainQuery = await queryBrainForContent(type === 'reply' ? 'reply' : 'quote', 6, 3);
    const brainContext = brainQuery.compiled_prompt_context;

    // If brain has concepts, use them; if empty, use legacy rules
    const hasBrainLearning = brainQuery.concepts.length > 0 || brainQuery.patterns.length > 0;
    const fallbackRules = algoRules.slice(0, 5).map(r => `- ${r.rule} (evidence: ${(r.evidence || '').slice(0, 80)})`).join('\n');
    const fallbackPatterns = stylePatterns.slice(0, 5).map(p => `- ${p.pattern_name}: ${p.pattern_description}`).join('\n');

    const learningContext = hasBrainLearning
      ? brainContext
      : `Algorithm rules:\n${fallbackRules}\n\nStyle patterns:\n${fallbackPatterns}`;

    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `Write for X account @${optionalEnv('X_USERNAME', '30piq')}.

Strict rules:
1. No AI slop words (delve, crucial, leverage, game-changer, unlock, etc.)
2. No hashtags
3. No numbers without source
4. No identical numbered or bullet lists
5. Natural voice — like a smart friend talking, not a content machine
6. Under 240 characters
7. No repeating the same idea in different words
8. Add a personal element or specific reference

${learningContext}

IMPORTANT: When you write, you MUST follow the APPLICATION INSTRUCTION for each concept. Each concept tells you HOW to apply it — read the "HOW TO APPLY" instruction and follow it precisely. Do not just reference the concept — embody it in your writing technique.

Return final text only. No explanation or notes.`
      },
      {
        role: 'user',
        content: type === 'quote'
          ? `Write a quote tweet for this:\n\n"${tweet.text?.slice(0, 300)}"\n\nThe quote must add value or a different angle.`
          : `Write a useful reply to this tweet:\n\n"${tweet.text?.slice(0, 300)}"\n\nThe reply must add information, experience, or a follow-up question.`
      }
    ]);

    const text = String(response || '').trim();
    if (text.length < 10 || text.length > 280) return null;

    // Log which concepts were used
    if (hasBrainLearning) {
      for (const c of brainQuery.concepts.slice(0, 3)) {
        rulesUsed.push(c.concept_type || 'unknown');
      }
    } else {
      for (const rule of algoRules.slice(0, 3)) {
        rulesUsed.push(rule.rule_type || 'unknown');
      }
    }

    return text;
  } catch {
    return null;
  }
}

async function craftThreadFromBrain(
  algoRules: any[],
  stylePatterns: any[]
): Promise<{ type: 'thread' | 'article'; text: string; why: string; rules: string[] } | null> {
  try {
    // ═══ Smart retrieval from brain ═══
    const brainQuery = await queryBrainForContent('thread', 6, 5);
    const hasBrainLearning = brainQuery.concepts.length > 0 || brainQuery.patterns.length > 0;

    // Fallback if brain is empty
    const fallbackPatterns = stylePatterns.slice(0, 5);
    const fallbackRules = algoRules.slice(0, 5);

    let learningContext: string;
    let topPatterns: any[];
    let topRules: any[];

    if (hasBrainLearning) {
      learningContext = brainQuery.compiled_prompt_context;
      topPatterns = brainQuery.patterns;
      topRules = brainQuery.concepts;
    } else {
      topPatterns = fallbackPatterns;
      topRules = fallbackRules;
      learningContext = `Successful patterns for inspiration:\n${topPatterns.map(p => `- ${p.pattern_name}: ${p.pattern_description}`).join('\n')}\n\nAlgorithm rules:\n${topRules.map(r => `- ${r.rule}`).join('\n')}`;
    }

    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `Write for X account @${optionalEnv('X_USERNAME', '30piq')}.

Strict rules:
1. No AI slop (delve, crucial, leverage, game-changer, unlock, etc.)
2. No hashtags
3. No numbers without source
4. Natural voice — smart friend, not a content machine
5. Each tweet in the thread must be standalone-strong
6. First tweet = strong hook (question, shocking fact, or bold opinion)
7. No repetition

${learningContext}

CRITICAL: You MUST follow the APPLICATION INSTRUCTION for each concept. Each concept tells you exactly HOW to apply it — follow the "HOW TO APPLY" instruction precisely. Do not just reference the concept — embody it in your writing technique and thread structure.

Write a thread of 3-5 tweets. Separate each tweet with a line containing only "---".`
      },
      {
        role: 'user',
        content: hasBrainLearning
          ? `Write a thread based on the brain's learned concepts. Each concept has an application instruction — follow it precisely.`
          : `Write a thread about one of these topics based on brain patterns:\n${topPatterns.map(p => p.pattern_name).join(', ')}`
      }
    ]);

    const text = String(response || '').trim();
    if (text.length < 50) return null;

    const usedRules = hasBrainLearning
      ? brainQuery.concepts.slice(0, 5).map(c => c.concept_type || 'unknown')
      : topRules.map(r => r.rule_type || 'unknown');

    return {
      type: 'thread',
      text,
      why: `Built from ${brainQuery.concepts.length || topRules.length} concepts and ${brainQuery.patterns.length || topPatterns.length} brain patterns`,
      rules: usedRules
    };
  } catch {
    return null;
  }
}

// ═══ Single Tweet Analysis ═══

/**
 * Crawls a single tweet by ID (for manual addition)
 * Uses AI for deep analysis — not hardcoded templates
 */
export async function scanSingleTweet(tweetUrl: string): Promise<{
  ok: boolean;
  analysis?: any;
  media?: MediaFromTweet[];
  opportunity?: ContentOpportunity;
  error?: string;
  deepAnalysis?: DeepAnalysis;
}> {
  try {
    const match = tweetUrl.match(/\/status\/(\d+)/);
    if (!match) return { ok: false, error: 'Invalid tweet URL' };

    const tweetId = match[1];
    const base = twitterApiBase();
    const json = await fetchTwitterApiJson(`${base}/twitter/tweets?tweet_ids=${tweetId}`);
    const tweets = extractTweets(json);

    if (!tweets.length) return { ok: false, error: 'Tweet not found' };

    const raw = tweets[0];

    // Diagnostic in server logs only
    const rawKeys = Object.keys(raw || {});
    const mediaRelatedKeys = rawKeys.filter(k => /media|photo|video|image|gif|attach|entity/i.test(k));
    console.log(`[scanSingleTweet] Raw keys: ${rawKeys.join(', ')}`);
    console.log(`[scanSingleTweet] Media-related keys: ${mediaRelatedKeys.join(', ') || 'NONE'}`);
    console.log(`[scanSingleTweet] Full API response top keys: ${Object.keys(json || {}).join(', ')}`);
    for (const key of mediaRelatedKeys) {
      const val = raw[key];
      console.log(`[scanSingleTweet] raw.${key}: type=${typeof val}, isArray=${Array.isArray(val)}, preview=${JSON.stringify(val)?.slice(0, 500)}`);
    }
    if (raw.entities) {
      console.log(`[scanSingleTweet] raw.entities keys: ${Object.keys(raw.entities).join(', ')}`);
    }
    if (raw.extendedEntities) {
      console.log(`[scanSingleTweet] raw.extendedEntities keys: ${Object.keys(raw.extendedEntities).join(', ')}`);
    }
    console.log(`[scanSingleTweet] FULL RAW: ${JSON.stringify(raw)?.slice(0, 3000)}`);

    const author = raw.author || raw.user || {};
    const username = author.userName || author.username || 'unknown';
    const user = { username, followers_count: Number(author.followers || 0) };

    // ═══ Detect tweet type and extract metadata ═══
    const isQuoteTweet = Boolean(raw.isQuote || raw.quotedStatusId || raw.quoted_status_id);
    const isReply = Boolean(raw.isReply || raw.in_reply_to_status_id);
    const conversationId = raw.conversationId || raw.conversation_id || null;
    const isThreadStarter = Boolean(conversationId && String(conversationId) === String(raw.id || raw.tweetId || raw.rest_id));

    let tweetType: 'original' | 'quote' | 'reply' | 'thread_starter' = 'original';
    if (isQuoteTweet) tweetType = 'quote';
    else if (isReply) tweetType = 'reply';
    else if (isThreadStarter) tweetType = 'thread_starter';

    // Extract quoted tweet data
    let quotedTweetText = raw.quotedStatus?.text || raw.quoted_status?.text || raw.quotedTweet?.text || '';
    let quotedTweetAuthor = raw.quotedStatus?.author?.userName || raw.quoted_status?.author?.userName || raw.quotedTweet?.author?.userName || '';
    const quotedTweetId = raw.quotedStatusId || raw.quoted_status_id || raw.quotedTweet?.id || null;

    // If it's a quote tweet but we don't have the quoted text, try fetching it
    if (isQuoteTweet && !quotedTweetText && quotedTweetId) {
      try {
        const quotedJson = await fetchTwitterApiJson(`${base}/twitter/tweets?tweet_ids=${quotedTweetId}`);
        const quotedTweets = extractTweets(quotedJson);
        if (quotedTweets.length) {
          const qt = quotedTweets[0];
          quotedTweetText = qt.text || qt.full_text || qt.content || '';
          quotedTweetAuthor = qt.author?.userName || qt.user?.userName || '';
        }
      } catch (e: any) {
        console.log(`[scanSingleTweet] Failed to fetch quoted tweet ${quotedTweetId}: ${e.message}`);
      }
    }

    const normalized = {
      id: String(raw.id || raw.tweetId || raw.rest_id || tweetId),
      text: raw.text || raw.full_text || raw.content || '',
      created_at: raw.createdAt || raw.created_at,
      public_metrics: {
        like_count: Number(raw.likeCount || raw.likes || 0),
        reply_count: Number(raw.replyCount || raw.replies || 0),
        retweet_count: Number(raw.retweetCount || raw.retweets || 0),
        quote_count: Number(raw.quoteCount || raw.quotes || 0),
        bookmark_count: Number(raw.bookmarkCount || raw.bookmarks || 0),
        view_count: Number(raw.viewCount || raw.views || 0)
      },
      entities: raw.entities || raw.extendedEntities || {},
      extended_entities: raw.extendedEntities || raw.extended_entities || raw.entities || {},
      is_reply: isReply,
      is_quote_tweet: isQuoteTweet,
      quoted_tweet_id: quotedTweetId,
      quoted_tweet_text: quotedTweetText,
      quoted_tweet_author: quotedTweetAuthor,
      conversation_id: conversationId,
      is_thread_starter: isThreadStarter,
      language: raw.lang || raw.language || null,
      author,
      raw
    };

    const analysis = analyzeXTweet(normalized, user);
    const score = scoreXTweet(normalized);
    const media = extractMediaFromTweet(normalized, json);

    // Store the analysis
    const supabase = supabaseAdmin();

    // ═══ Deep analysis with AI — English, no hardcoded niche, full metadata ═══
    // Fetch existing concepts from brain so analysis doesn't repeat them
    const { data: existingRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule_type, rule, evidence')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(15);

    const deepAnalysis = await deepAnalyzeWithAI(
      analysis.text,
      analysis.metrics,
      user.followers_count,
      media,
      username,
      tweetType,
      quotedTweetText,
      quotedTweetAuthor,
      analysis.created_at,
      analysis.time_label,
      analysis.tweet_id,
      existingRules || []
    );

    try {
      await supabase.from('viral_tweet_analyses').upsert({
        tweet_id: analysis.tweet_id,
        tweet_url: analysis.tweet_url,
        creator_handle: username,       // ← Correct name (not username)
        tweet_text: analysis.text.slice(0, 500),  // ← Correct field name (not text)
        engagement_score: score,
        engagement_per_1k_followers: analysis.engagement_per_1k_followers,
        tweet_type: tweetType,
        metrics: analysis.metrics
      }, { onConflict: 'tweet_id' });
    } catch (dbErr: any) {
      console.error('[scanSingleTweet] upsert error:', dbErr.message);
    }

    // ═══ Store deep analysis in brain — v3.2: real learning ═══
    try {
      const confidenceBase = deepAnalysis.confidenceLevel === 'high' ? 7 : deepAnalysis.confidenceLevel === 'medium' ? 5 : 3;
      const scoreBoost = Math.min(3, Math.round(score / 100));
      const baseConfidence = Math.min(10, confidenceBase + scoreBoost);

      // 1. Precise concept — most important thing the brain learns
      if (deepAnalysis.preciseConcept && deepAnalysis.preciseConcept !== 'No concept extracted') {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'precise_concept', rule: deepAnalysis.preciseConcept },
          {
            rule_type: 'precise_concept',
            rule: deepAnalysis.preciseConcept,
            evidence: `@${username}: ${deepAnalysis.conceptEvidence} | ${deepAnalysis.viralReason.slice(0, 150)}`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'content_strategy,engagement_crafting,viral_mechanics',
            confidence_score: baseConfidence,
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} (${score} engagement): ${deepAnalysis.conceptEvidence}`
        );
      }

      // 2. Psychological mechanism — how it activated people
      if (deepAnalysis.psychologicalTrigger && deepAnalysis.psychologicalTrigger !== 'Unidentified trigger') {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'psychological_trigger', rule: deepAnalysis.psychologicalTrigger },
          {
            rule_type: 'psychological_trigger',
            rule: deepAnalysis.psychologicalTrigger,
            evidence: `@${username} (${score} eng): ${deepAnalysis.audienceProfile.slice(0, 200)}`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'content_psychology,engagement_prediction',
            confidence_score: Math.max(3, baseConfidence - 1),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} tweet: ${deepAnalysis.conversationContext.slice(0, 150)}`
        );
      }

      // 3. Viral pattern
      if (deepAnalysis.viralReason) {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'viral_pattern', rule: deepAnalysis.viralReason },
          {
            rule_type: 'viral_pattern',
            rule: deepAnalysis.viralReason,
            evidence: `@${username} (${score} eng, ${analysis.engagement_per_1k_followers}/1K): "${analysis.text.slice(0, 80)}"`,
            source_type: 'manual_tweet_analysis',
            source_url: tweetUrl,
            applies_to: 'content_scoring,engagement_prediction',
            confidence_score: Math.max(3, baseConfidence - 1),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} (${score} eng): ${deepAnalysis.viralReason.slice(0, 100)}`
        );
      }

      // 4. Style pattern — how it was written
      if (deepAnalysis.stylePattern) {
        await upsertBrainConcept(supabase, 'viral_style_patterns',
          { pattern_name: deepAnalysis.stylePattern.slice(0, 100) },
          {
            pattern_name: deepAnalysis.stylePattern.slice(0, 100),
            pattern_type: deepAnalysis.psychologicalTrigger ? 'hook' : 'structure',  // ← Required NOT NULL!
            pattern_description: `${deepAnalysis.stylePattern}. Trigger: ${deepAnalysis.psychologicalTrigger}`,
            adaptation_for_30piq: deepAnalysis.adaptation || '',
            why_it_works: deepAnalysis.viralReason || '',
            source_handles: [username],
            source_tweet_urls: [tweetUrl],
            confidence_score: baseConfidence,
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} (${score} eng): ${deepAnalysis.stylePattern.slice(0, 80)}`
        );
      }

      // 5. Media rule
      if (media.length > 0 && deepAnalysis.mediaImpact) {
        const mediaRule = `${media.map(m => m.type).join('+')}: ${deepAnalysis.mediaImpact}`;
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'media_impact', rule: mediaRule },
          {
            rule_type: 'media_impact',
            rule: mediaRule,
            evidence: `@${username} with ${media.map(m => m.type).join(',')} → ${score} eng`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'media_strategy,content_scoring',
            confidence_score: Math.max(3, baseConfidence - 1),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username}: ${media.map(m => m.type).join('+')} → ${score} eng`
        );
      }

      // 6. Conversation context (if any)
      if (deepAnalysis.conversationContext && deepAnalysis.conversationContext !== 'No reply data available') {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'conversation_context', rule: deepAnalysis.conversationContext.slice(0, 200) },
          {
            rule_type: 'conversation_context',
            rule: deepAnalysis.conversationContext.slice(0, 200),
            evidence: `@${username} (${analysis.metrics.reply_count || 0} replies): ${deepAnalysis.audienceProfile.slice(0, 150)}`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'reply_strategy,engagement_crafting',
            confidence_score: Math.max(3, baseConfidence - 2),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} replies: ${deepAnalysis.conversationContext.slice(0, 100)}`
        );
      }
    } catch (brainErr: any) {
      console.error('[scanSingleTweet] brain storage error:', brainErr.message);
    }

    return {
      ok: true,
      analysis,
      media,
      deepAnalysis
    };
  } catch (e: any) {
    return { ok: false, error: e.message || 'Unknown error' };
  }
}

// ═══ Self-improvement: Brain monitors itself and refines its rules ═══

/**
 * Analyzes brain rules and patterns, strengthens strong ones and weakens weak ones
 * - Rules with evidence from real tweets increase confidence
 * - Duplicate or generic rules decrease confidence
 * - Rules with confidence below 3 are moved to archive
 */
async function selfImproveBrain(supabase: any, debugLog: string[]): Promise<{
  strengthened: number;
  weakened: number;
  pruned: number;
}> {
  let strengthened = 0;
  let weakened = 0;
  let pruned = 0;

  // 1. Strengthen rules with real evidence (from real_time_crawl or tweet analysis)
  try {
    const { data: realEvidence } = await supabase
      .from('x_algorithm_learning_rules')
      .select('id, confidence_score, evidence, source_type')
      .eq('status', 'active')
      .in('source_type', ['real_time_crawl', 'x_account_scan_v3', 'batch_concept_extraction']);

    if (realEvidence?.length) {
      for (const rule of realEvidence) {
        const newScore = Math.min(10, (rule.confidence_score || 5) + 1);
        if (newScore > rule.confidence_score) {
          await supabase.from('x_algorithm_learning_rules')
            .update({ confidence_score: newScore, updated_at: new Date().toISOString() })
            .eq('id', rule.id);
          strengthened++;
        }
      }
    }
  } catch {}

  // 2. Find duplicate rules and weaken them
  try {
    const { data: allRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('id, rule, rule_type, confidence_score')
      .eq('status', 'active');

    if (allRules?.length) {
      const seen = new Map<string, string[]>();
      for (const rule of allRules) {
        // Look at first 60 chars as duplication key
        const key = `${rule.rule_type}:${(rule.rule || '').slice(0, 60).toLowerCase().trim()}`;
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key)!.push(rule.id);
      }

      for (const [key, ids] of seen) {
        if (ids.length > 1) {
          // Keep first one intact, lower confidence of duplicates
          for (let i = 1; i < ids.length; i++) {
            await supabase.from('x_algorithm_learning_rules')
              .update({
                confidence_score: Math.max(1, 3),
                status: 'archived_duplicate',
                updated_at: new Date().toISOString()
              })
              .eq('id', ids[i]);
            weakened++;
          }
        }
      }
    }
  } catch {}

  // 3. Archive very weak rules (confidence below 3 and not from real analysis)
  try {
    const { count: prunedCount } = await supabase
      .from('x_algorithm_learning_rules')
      .update({ status: 'needs_review_weak_memory', updated_at: new Date().toISOString() })
      .eq('status', 'active')
      .lt('confidence_score', 3)
      .neq('source_type', 'real_time_crawl')
      .neq('source_type', 'x_account_scan_v3');
    pruned = prunedCount || 0;
  } catch {}

  // 4. Strengthen style patterns with real source_handles
  try {
    const { data: sourcedPatterns } = await supabase
      .from('viral_style_patterns')
      .select('id, confidence_score, source_handles')
      .eq('status', 'active')
      .not('source_handles', 'is', null);

    if (sourcedPatterns?.length) {
      for (const pattern of sourcedPatterns) {
        const handles = pattern.source_handles;
        if (Array.isArray(handles) && handles.length > 0) {
          const boost = Math.min(handles.length, 3); // Each source adds 1 (max 3)
          const newScore = Math.min(10, (pattern.confidence_score || 5) + boost);
          if (newScore > pattern.confidence_score) {
            await supabase.from('viral_style_patterns')
              .update({ confidence_score: newScore, updated_at: new Date().toISOString() })
              .eq('id', pattern.id);
            strengthened++;
          }
        }
      }
    }
  } catch {}

  return { strengthened, weakened, pruned };
}

/**
 * Proactive content generation — not a reply to a tweet, but original content from the brain
 * Uses everything the brain has learned to craft a thread, article, or tweet
 */
export async function generateProactiveContent(type: 'tweet' | 'thread' | 'article' = 'thread'): Promise<{
  ok: boolean;
  content?: string;
  type?: string;
  concepts_used?: number;
  patterns_used?: number;
  error?: string;
}> {
  try {
    const brainQuery = await queryBrainForContent(type === 'tweet' ? 'single_tweet' : type, 8, 6);
    const hasLearning = brainQuery.concepts.length > 0 || brainQuery.patterns.length > 0;

    if (!hasLearning) {
      return { ok: false, error: 'Brain is empty — run full scan first' };
    }

    const username = optionalEnv('X_USERNAME', '30piq');
    const context = brainQuery.compiled_prompt_context;

    const typeInstructions: Record<string, string> = {
      tweet: `Write a single powerful tweet (under 240 chars). One idea, strong hook, natural voice.`,
      thread: `Write a thread of 3-5 tweets. Each tweet must be standalone-strong. First tweet = strong hook (question, shocking fact, or bold opinion). Separate tweets with "---".`,
      article: `Write a short article (400-600 words) with a compelling title, clear sections, and actionable takeaways.`
    };

    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `You are writing for X account @${username}.

STRICT RULES:
1. NO AI slop (delve, crucial, leverage, game-changer, unlock, etc.)
2. NO hashtags
3. NO numbers without source
4. Natural voice — like a smart friend talking, not a content machine
5. No repetition
6. Add a personal element or specific reference
7. Each piece must stand on its own merit

${context}

CRITICAL: You MUST follow the APPLICATION INSTRUCTION for each concept. Each concept tells you HOW to apply it — embody it in your writing, don't just reference it.

${typeInstructions[type] || typeInstructions.thread}

Write ONLY the content. No explanations or notes.`
      },
      {
        role: 'user',
        content: `Generate ${type} content based on the brain's learned concepts and patterns. Apply each concept's HOW TO APPLY instruction precisely.`
      }
    ]);

    const content = String(response || '').trim();
    if (content.length < 20) return { ok: false, error: 'Generated content is too short' };

    return {
      ok: true,
      content,
      type,
      concepts_used: brainQuery.concepts.length,
      patterns_used: brainQuery.patterns.length
    };
  } catch (e: any) {
    return { ok: false, error: e.message || 'Generation error' };
  }
}

// ═══════════════════════════════════════════════════════════════
// Exported functions for the Queue + Worker architecture
//
// These preserve the EXACT same quality as scanXAccounts:
//   - Full deep AI analysis per viral tweet
//   - Brain learning (viral patterns, style patterns, media patterns, concept extraction)
//   - Full opportunity discovery with AI crafting + shield checks
//   - Self-improvement (brain monitors itself)
//
// The worker MUST use these instead of any simplified logic.
// ═══════════════════════════════════════════════════════════════

/**
 * Legitimate reasons an account scan may return zero tweets without being an error.
 * These are NOT failures — the account simply had no scannable content.
 */
export type AccountScanEmptyReason =
  | 'empty_timeline'       // Account exists but has no tweets
  | 'protected_account'    // Account is private/protected
  | 'no_recent_tweets';    // Account has tweets but none within the API window

/**
 * Result of scanning a single account for the pipeline worker.
 * Contains all analyzed data needed for the merge step.
 */
export type SingleAccountScanResult = {
  account_handle: string;
  tweets_analyzed: number;
  viral_found: number;
  analyzed_data: any[];        // Full analysis objects for merge step
  media: MediaFromTweet[];     // All media found
  brain_updates: {
    algorithm_rules: number;
    style_patterns: number;
    media_patterns: number;
  };
  debug_log: string[];
  /**
   * Set when the scan completed legitimately but found no tweets.
   * If set, tweets_analyzed will be 0 and analyzed_data will be [].
   * This is NOT an error — downstream steps should skip this account gracefully.
   */
  empty_reason?: AccountScanEmptyReason;
};

/**
 * Error thrown by scanSingleAccountForPipeline when the scan fails
 * due to API/network/provider errors (not legitimate empty results).
 */
export class AccountScanError extends Error {
  public readonly accountHandle: string;
  public readonly isTransient: boolean;

  constructor(accountHandle: string, message: string, isTransient = true) {
    super(`Account scan failed for @${accountHandle}: ${message}`);
    this.name = 'AccountScanError';
    this.accountHandle = accountHandle;
    this.isTransient = isTransient;
  }
}

/**
 * Scan a single X account with FULL content-engine-v3 quality.
 *
 * This is the per-account function extracted from scanXAccounts.
 * It does everything scanXAccounts does for ONE account:
 *   - Fetch timeline via getXUserTimeline
 *   - Analyze each tweet with analyzeXTweet + scoreXTweet
 *   - Deep AI analysis for viral tweets (callModel learning_extraction)
 *   - Store in viral_tweet_analyses
 *   - Learn viral patterns, psychological triggers, style patterns
 *   - Learn media patterns per account
 *   - Update account last_checked
 *
 * It does NOT discover opportunities (that happens at the merge/global step).
 *
 * This is NOT a simplified version. It is the same quality logic.
 */
export async function scanSingleAccountForPipeline(
  accountHandle: string,
  tweetsPerAccount: number = 8
): Promise<SingleAccountScanResult> {
  const supabase = supabaseAdmin();
  const debugLog: string[] = [];
  let brainUpdates = { algorithmRules: 0, stylePatterns: 0, mcpOpportunities: 0 };
  const allAnalyzed: any[] = [];
  const allMedia: MediaFromTweet[] = [];
  let viralFound = 0;
  let totalAnalyzed = 0;

  console.log(`[scanSingleAccountForPipeline] Scanning @${accountHandle}...`);

  // ═══ Fetch timeline — API/network errors MUST propagate, not get swallowed ═══
  let tweets: any[];
  try {
    tweets = await getXUserTimeline(accountHandle, tweetsPerAccount, true);
  } catch (apiErr: any) {
    // Distinguish protected/suspended accounts from transient API failures
    const msg = (apiErr.message || '').toLowerCase();
    if (msg.includes('protected') || msg.includes('private') || msg.includes('suspended') || msg.includes('not found') || msg.includes('does not exist')) {
      // Legitimate unavailability — return success with empty_reason
      debugLog.push(`[scan] @${accountHandle}: account unavailable (${msg.slice(0, 100)})`);
      return {
        account_handle: accountHandle,
        tweets_analyzed: 0,
        viral_found: 0,
        analyzed_data: [],
        media: [],
        brain_updates: { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
        debug_log: debugLog,
        empty_reason: msg.includes('protected') || msg.includes('private') ? 'protected_account' as AccountScanEmptyReason : 'no_recent_tweets' as AccountScanEmptyReason
      };
    }
    // Real API/network/provider error — throw so the task fails
    console.error(`[scanSingleAccountForPipeline] API error for @${accountHandle}:`, apiErr.message);
    throw new AccountScanError(accountHandle, apiErr.message, true);
  }

  // Legitimate empty timeline — account has no tweets
  if (!tweets || tweets.length === 0) {
    debugLog.push(`[scan] @${accountHandle}: empty timeline (0 tweets)`);
    // Still try to update account state before returning
    try {
      const snapshot = await getXUserByUsername(accountHandle);
      await supabase.from('accounts').update({
        notes: `Followers: ${snapshot.followers_count}, Scanned: ${new Date().toISOString()} (empty timeline)`,
        last_checked: new Date().toISOString(),
        followers: snapshot.followers_count || null
      }).eq('handle', accountHandle);
    } catch (updErr: any) {
      debugLog.push(`[scan] update account error (empty timeline): ${updErr.message}`);
    }
    return {
      account_handle: accountHandle,
      tweets_analyzed: 0,
      viral_found: 0,
      analyzed_data: [],
      media: [],
      brain_updates: { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
      debug_log: debugLog,
      empty_reason: 'empty_timeline'
    };
  }

  debugLog.push(`[scan] @${accountHandle}: got ${tweets.length} tweets`);

  try {
    for (const tweet of tweets) {
      totalAnalyzed++;
      const user = { username: accountHandle, followers_count: 0, public_metrics: { followers_count: 0 } };
      const analysis = analyzeXTweet(tweet, user);
      const score = scoreXTweet(tweet);
      const media = extractMediaFromTweet(tweet);

      // ═══ Deep AI analysis for each viral tweet (same as scanXAccounts) ═══
      let deepAnalysis: any = null;
      if (score > 15) {
        try {
          const m: any = tweet.public_metrics || {};
          const aiResult = await callModel('learning_extraction' as TaskType, [
            {
              role: 'system',
              content: `You are a viral content analyst. Analyze WHY this tweet performed well and extract transferable patterns. Be specific and actionable. Output valid JSON only.`
            },
            {
              role: 'user',
              content: `Analyze this tweet from @${accountHandle}:
Text: "${(analysis.text || '').slice(0, 400)}"
Type: ${media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original')}
Metrics: likes=${m.like_count||0} replies=${m.reply_count||0} retweets=${m.retweet_count||0} quotes=${m.quote_count||0} bookmarks=${m.bookmark_count||0} views=${m.view_count||0}
Score: ${score}

Extract:
1. "viral_reason": WHY this tweet went viral (specific mechanism, not generic)
2. "style_pattern": The writing style technique used (hook, structure, voice)
3. "media_impact": How media/visuals contributed (or "text_only" if no media)
4. "timing_insight": What about the timing or context helped
5. "tweet_type_insight": What about the tweet type (original/reply/quote) helped
6. "engagement_quality": Quality of engagement (genuine discussion vs vanity metrics)
7. "adaptation": How to apply this EXACT mechanism for @30piq (specific, not generic)
8. "hook_formula": The exact hook formula used (if identifiable)
9. "psychological_trigger": What psychological trigger made people engage
10. "confidence": 1-10 how confident you are in this analysis

JSON format: {"viral_reason":"...","style_pattern":"...","media_impact":"...","timing_insight":"...","tweet_type_insight":"...","engagement_quality":"...","adaptation":"...","hook_formula":"...","psychological_trigger":"...","confidence":N}`
            }
          ], { temperature: 0.1, max_tokens: 1500, response_format: { type: 'json_object' } });

          deepAnalysis = parseModelJson(aiResult);
          debugLog.push(`[scan] @${accountHandle}: deep analysis OK (conf: ${deepAnalysis?.confidence})`);
        } catch (aiErr: any) {
          debugLog.push(`[scan] @${accountHandle}: deep analysis failed: ${aiErr.message}`);
        }
      }

      // Store in viral_tweet_analyses (same as scanXAccounts)
      const isViral = score > 20 || analysis.engagement_per_1k_followers > 5;
      if (isViral) viralFound++;

      try {
        const upsertData: any = {
          tweet_id: String(analysis.tweet_id || tweet.id || ''),
          tweet_url: analysis.tweet_url || '',
          creator_handle: accountHandle,
          tweet_text: (analysis.text || '').slice(0, 500),
          engagement_score: score,
          engagement_per_1k_followers: analysis.engagement_per_1k_followers,
          tweet_type: media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original'),
          metrics: analysis.metrics
        };

        if (deepAnalysis) {
          upsertData.analysis_payload = deepAnalysis;
          upsertData.hook_formula = deepAnalysis.hook_formula || null;
          upsertData.why_bookmarks = deepAnalysis.engagement_quality || null;
          upsertData.adaptation_for_30piq = deepAnalysis.adaptation || null;
          upsertData.tone = deepAnalysis.style_pattern || null;
          upsertData.format_pattern = deepAnalysis.tweet_type_insight || null;
        }

        await supabase.from('viral_tweet_analyses').upsert(upsertData, { onConflict: 'tweet_id' });
      } catch (dbErr: any) {
        debugLog.push(`[scan] upsert error: ${dbErr.message}`);
      }

      // Store analysis for merge step
      allAnalyzed.push({
        ...analysis,
        score,
        media,
        handle: accountHandle,
        deepAnalysis
      });

      allMedia.push(...media);

      // ═══ Learn from viral tweets (same as scanXAccounts) ═══
      if (isViral && deepAnalysis) {
        try {
          // Store viral reason as rule
          await insertIfMissing(supabase, 'x_algorithm_learning_rules',
            { rule_type: 'viral_pattern', rule: `@${accountHandle}: ${deepAnalysis.viral_reason}` },
            {
              rule_type: 'viral_pattern',
              rule: deepAnalysis.viral_reason,
              evidence: `@${accountHandle} tweet (score: ${score}): "${(analysis.text || '').slice(0, 80)}..."`,
              source_type: 'real_time_crawl',
              source_url: analysis.tweet_url,
              applies_to: 'content_strategy,engagement_crafting',
              confidence_score: Math.min(10, deepAnalysis.confidence || 5),
              status: 'active',
              test_run: false,
              updated_at: new Date().toISOString()
            }
          );
          brainUpdates.algorithmRules++;

          // Store psychological pattern
          if (deepAnalysis.psychological_trigger) {
            await insertIfMissing(supabase, 'x_algorithm_learning_rules',
              { rule_type: 'psychological_trigger', rule: deepAnalysis.psychological_trigger },
              {
                rule_type: 'psychological_trigger',
                rule: deepAnalysis.psychological_trigger,
                evidence: `Trigger in @${accountHandle} viral tweet (score: ${score})`,
                source_type: 'real_time_crawl',
                applies_to: 'hook_crafting,engagement_crafting',
                confidence_score: Math.min(10, (deepAnalysis.confidence || 5) - 1),
                status: 'active',
                test_run: false,
                updated_at: new Date().toISOString()
              }
            );
            brainUpdates.algorithmRules++;
          }

          // Store style pattern
          if (deepAnalysis.style_pattern || deepAnalysis.adaptation) {
            try {
              await insertIfMissing(supabase, 'viral_style_patterns',
                { pattern_name: deepAnalysis.hook_formula || deepAnalysis.style_pattern?.slice(0, 80) || `Pattern from @${accountHandle}` },
                {
                  pattern_name: deepAnalysis.hook_formula || deepAnalysis.style_pattern?.slice(0, 80) || `Pattern from @${accountHandle}`,
                  pattern_description: deepAnalysis.style_pattern || '',
                  adaptation_for_30piq: deepAnalysis.adaptation || '',
                  pattern_type: deepAnalysis.psychological_trigger ? 'hook' : 'structure',
                  why_it_works: deepAnalysis.viral_reason || '',
                  source_handles: [accountHandle],
                  source_tweet_urls: [analysis.tweet_url],
                  confidence_score: Math.min(10, deepAnalysis.confidence || 5),
                  status: 'active',
                  test_run: false,
                  updated_at: new Date().toISOString()
                }
              );
              brainUpdates.stylePatterns++;
            } catch (spErr: any) {
              debugLog.push(`[scan] style pattern insert error: ${spErr.message}`);
            }
          }
        } catch (learnErr: any) {
          debugLog.push(`[scan] learning error: ${learnErr.message}`);
        }
      }
    }

    // ═══ Learn media patterns (same as scanXAccounts) ═══
    try {
      let totalTweets = allAnalyzed.length;
      let withMedia = allAnalyzed.filter(a => a.media?.length > 0).length;
      if (withMedia > 0) {
        const mediaRatio = Math.round((withMedia / totalTweets) * 100);
        const mediaTypes = [...new Set(allAnalyzed.flatMap(a => (a.media || []).map((m: MediaFromTweet) => m.type)))].join(', ');
        const rule = `@${accountHandle} uses media in ${mediaRatio}% of tweets (${mediaTypes}). Accounts with high media usage get better engagement. Consider media when crafting engagement with their tweets.`;
        await insertIfMissing(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'media_pattern', rule },
          {
            rule_type: 'media_pattern',
            rule,
            evidence: `Scanned ${totalTweets} tweets from @${accountHandle}: ${withMedia} had media (${mediaTypes})`,
            source_type: 'x_account_scan_v3',
            source_url: `https://x.com/${accountHandle}`,
            applies_to: 'crawl_strategy,content_score,engagement_crafting',
            confidence_score: Math.min(10, 5 + Math.floor(mediaRatio / 20)),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          }
        );
        brainUpdates.algorithmRules++;
      }
    } catch (e: any) {
      debugLog.push(`[brain-media] pattern failed: ${e.message}`);
    }

    // ═══ Update account state (same as scanXAccounts) ═══
    try {
      const snapshot = await getXUserByUsername(accountHandle);
      await supabase.from('accounts').update({
        notes: `Followers: ${snapshot.followers_count}, Scanned: ${new Date().toISOString()}`,
        last_checked: new Date().toISOString(),
        followers: snapshot.followers_count || null
      }).eq('handle', accountHandle);
    } catch (updErr: any) {
      debugLog.push(`[scan] update account error: ${updErr.message}`);
    }

  } catch (e: any) {
    // ═══ Non-recoverable error during tweet processing ═══
    // If we got tweets but couldn't process ANY of them, that's a real failure.
    // Do NOT swallow — throw so the pipeline task fails properly.
    debugLog.push(`[scan] FAILED @${accountHandle}: ${e.message}`);
    console.error(`[scanSingleAccountForPipeline] Failed to scan @${accountHandle}:`, e.message);

    if (totalAnalyzed === 0) {
      // Zero tweets processed despite having tweets available = scan failure
      throw new AccountScanError(accountHandle, `Tweet processing failed: ${e.message}`, true);
    }

    // If some tweets were processed before the error, return partial result
    // This is acceptable — the merge step can still work with partial data
    console.warn(`[scanSingleAccountForPipeline] Partial scan for @${accountHandle}: ${totalAnalyzed} tweets processed before error`);
  }

  return {
    account_handle: accountHandle,
    tweets_analyzed: totalAnalyzed,
    viral_found: viralFound,
    analyzed_data: allAnalyzed,
    media: allMedia,
    brain_updates: {
      algorithm_rules: brainUpdates.algorithmRules,
      style_patterns: brainUpdates.stylePatterns,
      media_patterns: allMedia.length
    },
    debug_log: debugLog
  };
}

/**
 * Result of running the global merge + discover step for the pipeline worker.
 * Contains the full ContentOpportunity[] array with crafted text and shield checks.
 */
export type MergeAndDiscoverResult = {
  accounts_scanned: number;
  tweets_analyzed: number;
  viral_found: number;
  raw_opportunities: number;
  opportunities: ContentOpportunity[];
  brain_updates: {
    algorithm_rules: number;
    style_patterns: number;
    media_patterns: number;
  };
  media_downloaded: number;
  debug_log: string[];
};

/**
 * Merge per-account scan results and discover opportunities with FULL quality.
 *
 * This is the global/merge step extracted from scanXAccounts.
 * It does everything scanXAccounts does AFTER per-account scanning:
 *   - Brain learning from crawled data (learnFromCrawlerItems)
 *   - Concept extraction (batch AI analysis)
 *   - Media pattern learning across accounts
 *   - Full opportunity discovery (AI crafting + shield checks)
 *   - Thread crafting from brain
 *   - Self-improvement (brain monitors itself)
 *
 * This is NOT a simplified version. It produces real ContentOpportunity objects
 * with crafted_text, shield_passed, media_urls, and brain_rules_used.
 */
export async function mergeAndDiscoverOpportunities(
  accountScanResults: SingleAccountScanResult[]
): Promise<MergeAndDiscoverResult> {
  const supabase = supabaseAdmin();
  const debugLog: string[] = [];
  let brainUpdates = { algorithmRules: 0, stylePatterns: 0, mcpOpportunities: 0 };

  // Merge all analyzed data from all accounts
  const allAnalyzed: any[] = [];
  const allMedia: MediaFromTweet[] = [];
  let totalTweetsAnalyzed = 0;
  let totalViralFound = 0;

  for (const result of accountScanResults) {
    allAnalyzed.push(...result.analyzed_data);
    allMedia.push(...result.media);
    totalTweetsAnalyzed += result.tweets_analyzed;
    totalViralFound += result.viral_found;
    brainUpdates.algorithmRules += result.brain_updates.algorithm_rules;
    brainUpdates.stylePatterns += result.brain_updates.style_patterns;
  }

  debugLog.push(`[merge] Merged ${accountScanResults.length} account scans: ${totalTweetsAnalyzed} tweets, ${totalViralFound} viral`);

  // ═══ Brain learning from crawled data (same as scanXAccounts) ═══
  try {
    const { data: existingViralRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule_type, rule, evidence')
      .in('rule_type', ['viral_pattern', 'spread_pattern', 'media_impact'])
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(30);

    const { data: existingStylePatterns } = await supabase
      .from('viral_style_patterns')
      .select('pattern_name, pattern_description, adaptation_for_30piq')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(30);

    const crawlerItems = allAnalyzed.map(a => {
      const relatedRule = (existingViralRules || []).find((r: any) =>
        r.evidence?.includes(a.username) || r.evidence?.includes(a.tweet_id)
      );
      const relatedStyle = (existingStylePatterns || []).find((p: any) =>
        p.pattern_name?.includes(a.username) || p.evidence?.includes(a.username)
      );

      const mediaDesc = a.media?.length > 0
        ? `Contains ${a.media.map((m: MediaFromTweet) => m.type).join('+')}`
        : 'Text only';
      const deepInsight = relatedRule?.rule || '';
      const styleInsight = relatedStyle?.pattern_description || '';

      let summary = `Engagement: ${a.score}, per 1K followers: ${a.engagement_per_1k_followers}, ${mediaDesc}`;
      if (deepInsight) summary += ` | Viral reason: ${deepInsight.slice(0, 150)}`;
      if (styleInsight) summary += ` | Style: ${styleInsight.slice(0, 100)}`;

      return {
        title: a.text?.slice(0, 200) || 'Tweet analysis',
        url: a.tweet_url,
        summary,
        confidence_score: Math.min(10, Math.max(1, Math.round(a.score / 10))),
      };
    });

    if (crawlerItems.length > 0) {
      const learned = await learnFromCrawlerItems(supabase, {
        runType: 'x_account_scan_v3',
        source: 'twitter_scan',
        items: crawlerItems,
        mode: 'production'
      });
      brainUpdates.algorithmRules += learned.algorithmRules;
      brainUpdates.stylePatterns += learned.stylePatterns;
      brainUpdates.mcpOpportunities += learned.mcpOpportunities;
    }
  } catch (e: any) {
    debugLog.push(`[brain] learning failed: ${e.message}`);
    console.error('[mergeAndDiscoverOpportunities] Brain learning failed:', e.message);
  }

  // ═══ Concept extraction (same as scanXAccounts) ═══
  try {
    if (allAnalyzed.length >= 2) {
      const tweetsForConcept = allAnalyzed
        .filter(a => (a.score || 0) > 20)
        .slice(0, 15)
        .map(a => ({
          text: a.text?.slice(0, 150),
          score: a.score,
          handle: a.handle || a.username,
          media: a.media?.map((m: MediaFromTweet) => m.type).join(',') || 'none',
          per1k: a.engagement_per_1k_followers
        }));

      if (tweetsForConcept.length >= 2) {
        const conceptResponse = await callModel('learning_extraction' as TaskType, [
          {
            role: 'system',
            content: `You are an expert viral pattern analyst. You are given a set of successful tweets and must discover the shared concepts between them.

Your task: Discover 1-3 general concepts/patterns shared across these tweets. Each concept must be:
1. Specific and actionable (not generic like "good content")
2. Connecting multiple tweets together
3. Providing a transferable recommendation — how can this MECHANIC (not topic) be applied to any account

Respond in JSON only:
{
  "concepts": [
    {
      "name": "Concept name",
      "description": "Explanation of the concept and its connection to the tweets",
      "adaptation": "How to apply this mechanic to any account"
    }
  ]
}`
          },
          {
            role: 'user',
            content: `Analyze these tweets and discover shared concepts:

${tweetsForConcept.map((t, i) => `${i + 1}. @${t.handle} (engagement: ${t.score}, media: ${t.media}): "${t.text}"`).join('\n\n')}`
          }
        ], { temperature: 0.15, max_tokens: 2000, response_format: { type: 'json_object' } });

        const parsed = parseModelJson(conceptResponse);
        const concepts = parsed.concepts || [];

        for (const concept of concepts.slice(0, 3)) {
          if (concept.name && concept.description) {
            await insertIfMissing(supabase, 'x_algorithm_learning_rules',
              { rule_type: 'viral_concept', rule: `${concept.name}: ${concept.description}` },
              {
                rule_type: 'viral_concept',
                rule: `${concept.name}: ${concept.description}`,
                evidence: `Shared concept extracted from ${tweetsForConcept.length} viral tweets`,
                source_type: 'batch_concept_extraction',
                source_url: '',
                applies_to: 'content_strategy,engagement_crafting',
                confidence_score: Math.min(10, 5 + Math.floor(tweetsForConcept.length / 3)),
                status: 'active',
                test_run: false,
                updated_at: new Date().toISOString()
              }
            );
            brainUpdates.algorithmRules++;

            if (concept.adaptation) {
              try {
                await insertIfMissing(supabase, 'viral_style_patterns',
                  { pattern_name: concept.name.slice(0, 100) },
                  {
                    pattern_name: concept.name.slice(0, 100),
                    pattern_description: concept.description,
                    adaptation_for_30piq: concept.adaptation,
                    pattern_type: 'structure',
                    why_it_works: `Shared concept from ${tweetsForConcept.length} viral tweets`,
                    source_handles: [],
                    source_tweet_urls: [],
                    confidence_score: Math.min(10, 5 + Math.floor(tweetsForConcept.length / 3)),
                    status: 'active',
                    test_run: false,
                    updated_at: new Date().toISOString()
                  }
                );
                brainUpdates.stylePatterns++;
              } catch (spErr: any) {
                debugLog.push(`[brain-concepts] style pattern insert error: ${spErr.message}`);
              }
            }
          }
        }
        debugLog.push(`[brain-concepts] extracted ${concepts.length} concepts from ${tweetsForConcept.length} tweets`);
      }
    }
  } catch (e: any) {
    debugLog.push(`[brain-concepts] concept extraction failed: ${e.message}`);
    console.error('[mergeAndDiscoverOpportunities] Concept extraction failed:', e.message);
  }

  // ═══ Full opportunity discovery (same as scanXAccounts — uses discoverOpportunities) ═══
  const opportunities = await discoverOpportunities(allAnalyzed, allMedia);
  debugLog.push(`[opportunities] discovered ${opportunities.length} opportunities`);

  // ═══ Self-improvement (same as scanXAccounts) ═══
  try {
    const selfImprovement = await selfImproveBrain(supabase, debugLog);
    debugLog.push(`[self-improve] strengthened: ${selfImprovement.strengthened}, weakened: ${selfImprovement.weakened}, pruned: ${selfImprovement.pruned}`);
  } catch (e: any) {
    debugLog.push(`[self-improve] failed: ${e.message}`);
  }

  return {
    accounts_scanned: accountScanResults.length,
    tweets_analyzed: totalTweetsAnalyzed,
    viral_found: totalViralFound,
    raw_opportunities: opportunities.length,
    opportunities,
    brain_updates: {
      algorithm_rules: brainUpdates.algorithmRules,
      style_patterns: brainUpdates.stylePatterns,
      media_patterns: allMedia.length
    },
    media_downloaded: allMedia.length,
    debug_log: debugLog
  };
}
