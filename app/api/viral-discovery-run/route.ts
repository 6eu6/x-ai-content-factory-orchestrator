import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { webSearch } from '../../../lib/web-search';
import { learnFromCrawlerItems, toArray } from '../../../lib/learning-memory';

const VERSION = 'viral-discovery-v1-autonomous';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

async function searchXRecent(query: string) {
  const token = optionalEnv('X_BEARER_TOKEN');
  if (!token) return { ok: false, error: 'Missing X_BEARER_TOKEN', tweets: [] };
  const url = new URL('https://api.twitter.com/2/tweets/search/recent');
  url.searchParams.set('query', `${query} lang:en -is:retweet`);
  url.searchParams.set('max_results', '10');
  url.searchParams.set('tweet.fields', 'created_at,public_metrics,author_id,conversation_id,lang,referenced_tweets');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'username,name,description,public_metrics,verified');
  const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) return { ok: false, error: `X API error: ${res.status} ${JSON.stringify(data)}`, tweets: [] };
  return { ok: true, error: null, tweets: data.data || [], includes: data.includes || {} };
}

function scoreTweet(t: any) {
  const m = t.public_metrics || {};
  return (m.like_count || 0) + (m.retweet_count || 0) * 3 + (m.reply_count || 0) * 2 + (m.quote_count || 0) * 4;
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const nicheQueries = [
      'AI productivity workflow',
      'AI agents productivity',
      'AI tools career growth',
      'AI automation workflow',
      'knowledge work AI'
    ];

    const xResults = [];
    for (const q of nicheQueries) xResults.push({ query: q, result: await searchXRecent(q) });

    const webResults = [];
    for (const q of nicheQueries) {
      webResults.push({ query: `site:x.com ${q}`, results: await webSearch(`site:x.com ${q}`, 5) });
    }

    const tweets = xResults.flatMap((x) => (x.result.tweets || []).map((t: any) => ({ ...t, discovery_query: x.query, score: scoreTweet(t) }))).sort((a, b) => b.score - a.score).slice(0, 30);

    const prompt = `You are the Viral Discovery Operator for @${optionalEnv('X_USERNAME', '30piq')}.
Goal: autonomously find and analyze viral mechanics in AI x Productivity x Career Growth, then decide where/how to reply, quote, post, create a repo, or write an article.

Use only provided X results and web search results. If X API failed, use webResults but mark x_data_quality as failed.
Do not invent tweet text, metrics, creators, or URLs.
Analyze patterns deeply: hook, emotion, simplicity, novelty, disagreement potential, status signal, bookmark value, reply trigger, quote trigger, timing/positioning.
Return strict JSON only.

Inputs:
xResults=${JSON.stringify(xResults)}
rankedTweets=${JSON.stringify(tweets)}
webResults=${JSON.stringify(webResults)}

Return JSON with keys:
{
  "mode":"viral_discovery",
  "x_data_quality":"live|failed|partial",
  "market_pulse":"...",
  "viral_patterns":[{"pattern":"...","mechanism":"...","why_people_engage":"...","risk":"...","adaptation_for_30piq":"..."}],
  "reply_opportunities":[{"target_url":"...","target_text_summary":"...","reply_angle":"...","prepared_reply":"...","why_reply":"..."}],
  "quote_opportunities":[{"target_url":"...","quote_angle":"...","prepared_quote":"...","why_quote":"..."}],
  "original_post_opportunities":[{"hook":"...","post_text":"...","mechanism_used":"...","why_it_can_spread":"...","risk_score":1}],
  "repo_opportunities":[{"needed":false,"repo_name":"","problem_solved":"","asset_type":"","readme_outline":"","source_urls":[]}],
  "article_opportunities":[{"needed":false,"title":"","angle":"","outline":[],"source_urls":[]}],
  "operator_rules_for_daily_run":["..."],
  "next_actions":["..."]
}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Analyze viral mechanics using only provided data. Do not invent missing tweet text, metrics, creators, or URLs.' },
        { role: 'user', content: prompt }
      ]
    });

    const intel = JSON.parse(completion.choices[0]?.message?.content || '{}');

    if (Array.isArray(intel.viral_patterns)) {
      await supabase.from('creator_intel').insert(intel.viral_patterns.slice(0, 10).map((p: any) => ({
        creator_handle: 'autodiscovered',
        post_url: null,
        topic: 'viral_pattern',
        hook_pattern: p.pattern || null,
        format_pattern: p.mechanism || null,
        why_it_worked: p.why_people_engage || null,
        adaptation_idea: p.adaptation_for_30piq || null,
        status: intel.x_data_quality || 'new'
      })));
    }

    if (Array.isArray(intel.operator_rules_for_daily_run)) {
      await supabase.from('trends').insert(intel.operator_rules_for_daily_run.slice(0, 10).map((rule: string) => ({
        topic: 'viral_operator_rule',
        source: 'viral-discovery-run',
        heat_score: 8,
        content_type_suggestion: 'operator_rule',
        notes: rule
      })));
    }

    // --- Normalize viral discovery intel for learning-memory ---
    const crawlerItems: any[] = [];

    // Viral patterns: hook mechanics, engagement drivers, adaptation
    for (const vp of toArray(intel.viral_patterns)) {
      crawlerItems.push({
        title: vp.pattern || vp.hook_style || 'viral_pattern',
        url: toArray(vp.source_urls)[0] || '',
        summary: [
          vp.pattern ? `Pattern: ${vp.pattern}` : '',
          vp.mechanism ? `Mechanism: ${vp.mechanism}` : '',
          vp.why_people_engage ? `Engage reason: ${vp.why_people_engage}` : '',
          vp.risk ? `Risk: ${vp.risk}` : '',
          vp.adaptation_for_30piq ? `Adapt: ${vp.adaptation_for_30piq}` : ''
        ].filter(Boolean).join(' | '),
        confidence_score: vp.confidence_score || 8,
        source_type: 'viral_pattern',
        mechanism: vp.mechanism || vp.pattern || ''
      });
    }

    // Reply opportunities: reply triggers and angles
    for (const ro of toArray(intel.reply_opportunities)) {
      crawlerItems.push({
        title: ro.reply_angle || ro.target_text_summary || 'reply_opportunity',
        url: ro.target_url || toArray(ro.source_urls)[0] || '',
        summary: [
          ro.reply_angle ? `Angle: ${ro.reply_angle}` : '',
          ro.why_reply ? `Why: ${ro.why_reply}` : '',
          ro.prepared_reply ? `Reply: ${String(ro.prepared_reply).slice(0, 200)}` : ''
        ].filter(Boolean).join(' | '),
        confidence_score: 7,
        source_type: 'reply_opportunity',
        mechanism: ro.why_reply || ro.reply_angle || ''
      });
    }

    // Quote opportunities: quote triggers and angles
    for (const qo of toArray(intel.quote_opportunities)) {
      crawlerItems.push({
        title: qo.quote_angle || 'quote_opportunity',
        url: qo.target_url || toArray(qo.source_urls)[0] || '',
        summary: [
          qo.quote_angle ? `Angle: ${qo.quote_angle}` : '',
          qo.why_quote ? `Why: ${qo.why_quote}` : '',
          qo.prepared_quote ? `Quote: ${String(qo.prepared_quote).slice(0, 200)}` : ''
        ].filter(Boolean).join(' | '),
        confidence_score: 7,
        source_type: 'quote_opportunity',
        mechanism: qo.why_quote || qo.quote_angle || ''
      });
    }

    // Original post opportunities: hooks, mechanisms, why it can spread
    for (const op of toArray(intel.original_post_opportunities)) {
      crawlerItems.push({
        title: op.hook || op.mechanism_used || 'original_post_opportunity',
        url: toArray(op.source_urls)[0] || '',
        summary: [
          op.hook ? `Hook: ${op.hook}` : '',
          op.mechanism_used ? `Mechanism: ${op.mechanism_used}` : '',
          op.why_it_can_spread ? `Spread reason: ${op.why_it_can_spread}` : '',
          op.post_text ? `Text: ${String(op.post_text).slice(0, 200)}` : '',
          op.risk_score ? `Risk: ${op.risk_score}/10` : ''
        ].filter(Boolean).join(' | '),
        confidence_score: Math.max(1, 10 - (op.risk_score || 3)),
        source_type: 'original_post_opportunity',
        mechanism: op.mechanism_used || op.why_it_can_spread || ''
      });
    }

    // Repo opportunities: proof asset angles
    for (const rp of toArray(intel.repo_opportunities)) {
      if (!rp.needed) continue;
      crawlerItems.push({
        title: rp.repo_name || rp.problem_solved || 'repo_opportunity',
        url: toArray(rp.source_urls)[0] || '',
        summary: [
          rp.problem_solved ? `Problem: ${rp.problem_solved}` : '',
          rp.asset_type ? `Asset: ${rp.asset_type}` : '',
          rp.readme_outline ? `Outline: ${String(rp.readme_outline).slice(0, 200)}` : ''
        ].filter(Boolean).join(' | '),
        confidence_score: 7,
        source_type: 'repo_opportunity',
        mechanism: rp.problem_solved || rp.asset_type || ''
      });
    }

    // Article opportunities: research-to-operator angles
    for (const ap of toArray(intel.article_opportunities)) {
      if (!ap.needed) continue;
      crawlerItems.push({
        title: ap.title || ap.angle || 'article_opportunity',
        url: toArray(ap.source_urls)[0] || '',
        summary: [
          ap.angle ? `Angle: ${ap.angle}` : '',
          ap.outline ? `Outline: ${String(ap.outline).slice(0, 200)}` : ''
        ].filter(Boolean).join(' | '),
        confidence_score: 7,
        source_type: 'article_opportunity',
        mechanism: ap.angle || ''
      });
    }

    // Operator rules for daily-run (behavioral rules)
    for (const rule of toArray(intel.operator_rules_for_daily_run)) {
      const ruleStr = String(rule || '').slice(0, 300);
      if (!ruleStr) continue;
      crawlerItems.push({
        title: `Operator rule: ${ruleStr.slice(0, 80)}`,
        url: '',
        summary: ruleStr,
        confidence_score: 8,
        source_type: 'operator_rule',
        mechanism: ruleStr
      });
    }

    let learningMemoryResult: any = null;
    if (crawlerItems.length > 0) {
      try {
        learningMemoryResult = await learnFromCrawlerItems(supabase, {
          runType: 'viral_discovery',
          source: 'viral_discovery_autonomous',
          items: crawlerItems,
          mode: url.searchParams.get('mode') || 'trial'
        });
      } catch (learnErr: any) {
        // Don't fail the whole endpoint if learning fails
      }
    }

    const log = await insertSessionLog({
      actions_completed: ['viral_discovery_run', VERSION, learningMemoryResult ? `learning_memory:${learningMemoryResult.algorithmRules}algo+${learningMemoryResult.stylePatterns}style+${learningMemoryResult.mcpOpportunities}mcp` : 'learning_memory:skipped'],
      decisions_made: [intel.market_pulse || '', ...(intel.operator_rules_for_daily_run || [])],
      pending_tasks: intel.next_actions || [],
      next_recommendation: 'Run daily-run after viral discovery so content uses current viral mechanics.'
    });

    return Response.json({ ok: true, version: VERSION, xResults, webResults, rankedTweets: tweets, intel, learningMemory: learningMemoryResult ? { algorithmRules: learningMemoryResult.algorithmRules, stylePatterns: learningMemoryResult.stylePatterns, mcpOpportunities: learningMemoryResult.mcpOpportunities, rejectedLowQuality: learningMemoryResult.rejectedLowQuality, runId: learningMemoryResult.run?.id } : null, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
