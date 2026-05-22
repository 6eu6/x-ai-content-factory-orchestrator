import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { webSearch } from '../../../lib/web-search';

const VERSION = 'research-v3-source-bound';

function openaiClient() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function allowedUrls(searchResults: any[]) {
  return new Set(searchResults.flatMap((g) => (g.results || []).map((r: any) => r.url)).filter(Boolean));
}

function sourceBoundIntel(intel: any, searchResults: any[]) {
  const urls = allowedUrls(searchResults);
  const hasValidUrl = (arr: any) => Array.isArray(arr) && arr.some((u) => urls.has(u));
  const filterByEvidence = (items: any[]) => (Array.isArray(items) ? items : []).filter((item) => hasValidUrl(item.source_urls));

  const safe = {
    ...intel,
    opportunities: filterByEvidence(intel.opportunities),
    recommended_today: filterByEvidence(intel.recommended_today),
    trend_updates: filterByEvidence(intel.trend_updates),
    creator_intel_updates: filterByEvidence(intel.creator_intel_updates),
    rejected_unverified: {
      reason: 'Removed items without source_urls that match the live search results.',
      original_opportunities_count: Array.isArray(intel.opportunities) ? intel.opportunities.length : 0,
      kept_opportunities_count: filterByEvidence(intel.opportunities).length
    }
  };

  if (!safe.opportunities.length) {
    safe.opportunities = searchResults.flatMap((group) => (group.results || []).slice(0, 2).map((r: any) => ({
      title: r.title,
      angle: `Turn this source into a practical AI productivity or career-growth insight: ${r.title}`,
      content_type: 'research_backed_post',
      why_now: 'Selected from current search results, not invented.',
      original_asset: 'Create a concise post or checklist based only on the source claim after human review.',
      github_needed: false,
      article_needed: false,
      media_needed: false,
      source_urls: [r.url]
    }))).slice(0, 5);
  }

  return safe;
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const queries = [
      'AI productivity workflows for career growth tools',
      'AI agents productivity career growth GitHub tools',
      'viral AI productivity X posts career growth',
      'new AI tools for knowledge workers productivity',
      'AI workflow templates career development'
    ];

    const searchResults = [];
    for (const q of queries) searchResults.push({ query: q, results: await webSearch(q, 5) });

    const [accounts, sources, trends, accountState, recentContent] = await Promise.all([
      supabase.from('accounts').select('*').order('tier', { ascending: true }).limit(30),
      supabase.from('sources').select('*').order('tier', { ascending: true }).limit(30),
      supabase.from('trends').select('*').eq('covered', false).order('heat_score', { ascending: false }).limit(20),
      supabase.from('account_state').select('*').eq('account_handle', optionalEnv('X_USERNAME', '30piq')).maybeSingle(),
      supabase.from('content_log').select('*').order('published_at', { ascending: false }).limit(20)
    ]);

    const prompt = `You are the source-bound research engine for @30piq.
Goal: grow an English AI x Productivity x Career Growth account toward 10K-20K real followers with original proof-based content.
Use ONLY the provided searchResults, accounts, sources, trends, accountState, and recentContent.
Do not invent tools, people, models, companies, news, metrics, or sources.
Every opportunity, recommendation, trend_update, and creator_intel_update MUST include source_urls, and every URL must appear exactly in searchResults.
If an idea is not supported by searchResults, put it in needs_more_research instead of recommending it.
Return strict JSON only.
Inputs:
searchResults=${JSON.stringify(searchResults)}
accounts=${JSON.stringify(accounts.data)}
sources=${JSON.stringify(sources.data)}
trends=${JSON.stringify(trends.data)}
accountState=${JSON.stringify(accountState.data)}
recentContent=${JSON.stringify(recentContent.data)}
Return JSON with keys: mode, market_read, viral_patterns, opportunities, recommended_today, github_asset_plan, article_plan, creator_intel_updates, trend_updates, needs_more_research, daily_run_brief, quality_bar.`;

    const completion = await openaiClient().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.15,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Produce source-bound research intelligence. Never invent unsupported entities. Every actionable item must include source_urls from the provided search results.' },
        { role: 'user', content: prompt }
      ]
    });

    const rawIntel = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const intel = sourceBoundIntel(rawIntel, searchResults);

    if (Array.isArray(intel.trend_updates)) {
      await supabase.from('trends').insert(intel.trend_updates.slice(0, 10).map((t: any) => ({
        topic: t.topic || t.title,
        source: (t.source_urls || [])[0] || 'research-intel-run',
        heat_score: t.heat_score || 5,
        content_type_suggestion: t.content_type_suggestion || t.content_type || null,
        notes: t.notes || t.angle || null
      })));
    }

    if (Array.isArray(intel.creator_intel_updates)) {
      await supabase.from('creator_intel').insert(intel.creator_intel_updates.slice(0, 10).map((c: any) => ({
        creator_handle: c.creator_handle || 'unknown',
        post_url: (c.source_urls || [])[0] || c.post_url || null,
        topic: c.topic || null,
        hook_pattern: c.hook_pattern || null,
        format_pattern: c.format_pattern || null,
        why_it_worked: c.why_it_worked || null,
        adaptation_idea: c.adaptation_idea || null,
        status: 'new'
      })));
    }

    const log = await insertSessionLog({
      actions_completed: ['research_intel_run', VERSION, 'source_bound_filter_applied'],
      decisions_made: [intel.recommended_today || {}],
      pending_tasks: [intel.daily_run_brief || 'Run daily-run using updated research intelligence.'],
      next_recommendation: 'Run daily-run after reviewing this source-bound research intelligence pack.'
    });

    return Response.json({ ok: true, version: VERSION, search_provider: optionalEnv('SEARCH_PROVIDER', 'none'), searchResults, intel, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
