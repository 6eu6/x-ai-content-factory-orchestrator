import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { webSearch } from '../../../lib/web-search';

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

    const log = await insertSessionLog({
      actions_completed: ['viral_discovery_run', VERSION],
      decisions_made: [intel.market_pulse || '', ...(intel.operator_rules_for_daily_run || [])],
      pending_tasks: intel.next_actions || [],
      next_recommendation: 'Run daily-run after viral discovery so content uses current viral mechanics.'
    });

    return Response.json({ ok: true, version: VERSION, xResults, webResults, rankedTweets: tweets, intel, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
