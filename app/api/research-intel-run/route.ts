import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'research-v1-intel-engine';

async function webSearch(query: string) {
  const provider = optionalEnv('SEARCH_PROVIDER', '').toLowerCase();
  if (provider !== 'serper') return [];
  const key = optionalEnv('SERPER_API_KEY');
  if (!key) return [];
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 5 })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Serper error: ${res.status} ${JSON.stringify(data)}`);
  return (data.organic || []).slice(0, 5).map((x: any) => ({ title: x.title || '', url: x.link || '', snippet: x.snippet || '' }));
}

function openaiClient() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
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
    for (const q of queries) searchResults.push({ query: q, results: await webSearch(q) });

    const [accounts, sources, trends, accountState, recentContent] = await Promise.all([
      supabase.from('accounts').select('*').order('tier', { ascending: true }).limit(30),
      supabase.from('sources').select('*').order('tier', { ascending: true }).limit(30),
      supabase.from('trends').select('*').eq('covered', false).order('heat_score', { ascending: false }).limit(20),
      supabase.from('account_state').select('*').eq('account_handle', optionalEnv('X_USERNAME', '30piq')).maybeSingle(),
      supabase.from('content_log').select('*').order('published_at', { ascending: false }).limit(20)
    ]);

    const prompt = `You are the research and growth intelligence engine for @30piq.
Goal: grow an English AI x Productivity x Career Growth account toward 10K-20K real followers and test monetization with original proof-based content.

Use the inputs to find high-leverage opportunities, not generic tweets.
Return strict JSON only.

Inputs:
searchResults=${JSON.stringify(searchResults)}
accounts=${JSON.stringify(accounts.data)}
sources=${JSON.stringify(sources.data)}
trends=${JSON.stringify(trends.data)}
accountState=${JSON.stringify(accountState.data)}
recentContent=${JSON.stringify(recentContent.data)}

Required JSON shape:
{
  "mode":"research_intel",
  "market_read":"...",
  "viral_patterns":[{"pattern":"...","why_it_spreads":"...","risk":"..."}],
  "opportunities":[{"title":"...","angle":"...","content_type":"tweet|thread|article|github_asset|tool","why_now":"...","original_asset":"...","github_needed":false,"article_needed":false,"media_needed":false}],
  "recommended_today":{"action":"...","reason":"...","priority_opportunity":"..."},
  "github_asset_plan":{"needed":false,"repo_name":"","asset_type":"","problem_solved":"","readme_outline":""},
  "article_plan":{"needed":false,"title":"","outline":[],"draft_summary":""},
  "creator_intel_updates":[{"creator_handle":"unknown","post_url":"","topic":"...","hook_pattern":"...","format_pattern":"...","why_it_worked":"...","adaptation_idea":"..."}],
  "trend_updates":[{"topic":"...","source":"research-intel-run","heat_score":1,"content_type_suggestion":"...","notes":"..."}],
  "daily_run_brief":"...",
  "quality_bar":{"minimum_originality":"...","avoid":"...","must_include":"..."}
}`;

    const client = openaiClient();
    const model = optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini');
    const completion = await client.chat.completions.create({
      model,
      temperature: 0.25,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You produce research-backed growth intelligence. Do not invent metrics or claim web access beyond provided search results.' },
        { role: 'user', content: prompt }
      ]
    });

    const intel = JSON.parse(completion.choices[0]?.message?.content || '{}');

    if (Array.isArray(intel.trend_updates)) {
      await supabase.from('trends').insert(intel.trend_updates.slice(0, 10).map((t: any) => ({
        topic: t.topic,
        source: t.source || 'research-intel-run',
        heat_score: t.heat_score || 5,
        content_type_suggestion: t.content_type_suggestion || null,
        notes: t.notes || null
      })));
    }

    if (Array.isArray(intel.creator_intel_updates)) {
      await supabase.from('creator_intel').insert(intel.creator_intel_updates.slice(0, 10).map((c: any) => ({
        creator_handle: c.creator_handle || 'unknown',
        post_url: c.post_url || null,
        topic: c.topic || null,
        hook_pattern: c.hook_pattern || null,
        format_pattern: c.format_pattern || null,
        why_it_worked: c.why_it_worked || null,
        adaptation_idea: c.adaptation_idea || null,
        status: 'new'
      })));
    }

    const log = await insertSessionLog({
      actions_completed: ['research_intel_run', VERSION],
      decisions_made: [intel.recommended_today || {}],
      pending_tasks: [intel.daily_run_brief || 'Run daily-run using updated research intelligence.'],
      next_recommendation: 'Run daily-run after reviewing this research intelligence pack.'
    });

    return Response.json({ ok: true, version: VERSION, search_provider: optionalEnv('SEARCH_PROVIDER', 'none'), searchResults, intel, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
