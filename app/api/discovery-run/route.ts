import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { webSearch } from '../../../lib/web-search';
import { learnFromCrawlerItems } from '../../../lib/learning-memory';

const VERSION = 'discovery-run-mvp+learning-memory';

function daysAgo(days: number) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

function host(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function ghHeaders() {
  const token = optionalEnv('GITHUB_TOKEN');
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function githubSearch(query: string, limit: number) {
  const api = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=${limit}`;
  const res = await fetch(api, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub search failed ${res.status}`);
  const json = await res.json();
  return (json.items || []).map((r: any) => ({
    item_type: 'github_repo',
    title: r.full_name,
    url: r.html_url,
    source_host: 'github.com',
    summary: r.description || '',
    raw_payload: r
  }));
}

function scores(item: any) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  const stars = Number(item.raw_payload?.stargazers_count || 0);
  const boost = Math.min(2, Math.floor(Math.log10(stars + 1)));
  const niche = /(ai|llm|productivity|career|resume|job|coding|workflow|agent|mcp)/i.test(text);
  const reusable = /(cli|tool|template|agent|workflow|automation|mcp|extension|starter|kit)/i.test(text);
  return {
    novelty_score: 6 + boost,
    relevance_score: (niche ? 7 : 4) + boost,
    technical_depth_score: item.item_type === 'github_repo' ? 7 + boost : 5,
    content_potential_score: (niche ? 7 : 4) + boost,
    repo_potential_score: (reusable ? 8 : 4) + boost,
    problem_solution_score: (reusable ? 8 : 4) + boost
  };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 4), 2), 8);
    const since = url.searchParams.get('since') || daysAgo(30);
    const mode = url.searchParams.get('mode') || 'trial';

    const { data: sources } = await supabase.from('discovery_sources').select('*').eq('active', true).order('priority', { ascending: false }).limit(6);
    const { data: runRow, error: runError } = await supabase.from('discovery_runs').insert({ run_type: 'discovery_mvp', status: 'started', inputs: { limit, since, learning_memory: true } }).select('*').single();
    if (runError) throw runError;

    let saved = 0;
    const errors: any[] = [];
    const crawlerItemsForLearning: any[] = [];

    for (const source of sources || []) {
      const query = String(source.query_template || '').replace('{date}', since);
      try {
        const results = source.source_type === 'github_search'
          ? await githubSearch(query, limit)
          : (await webSearch(query, limit)).map((r: any) => ({ item_type: 'web_page', title: r.title, url: r.url, source_host: host(r.url), summary: r.snippet || '', raw_payload: r }));
        for (const item of results) {
          const s = scores(item);
          const memoryItem = {
            ...item,
            ...s,
            source_name: source.source_name,
            source_type: source.source_type,
            topic_cluster: source.topic_cluster,
            query
          };
          crawlerItemsForLearning.push(memoryItem);
          await supabase.from('discovered_items').upsert({
            discovery_run_id: runRow.id,
            discovery_source_id: source.id,
            item_type: item.item_type,
            title: item.title,
            url: item.url,
            source_host: item.source_host || host(item.url),
            summary: item.summary || null,
            topic_cluster: source.topic_cluster,
            raw_payload: item.raw_payload || {},
            novelty_score: Math.min(10, s.novelty_score),
            relevance_score: Math.min(10, s.relevance_score),
            technical_depth_score: Math.min(10, s.technical_depth_score),
            content_potential_score: Math.min(10, s.content_potential_score),
            repo_potential_score: Math.min(10, s.repo_potential_score),
            problem_solution_score: Math.min(10, s.problem_solution_score),
            recommended_next_step: item.item_type === 'github_repo' ? 'repo_ingest' : 'content_opportunity',
            status: 'discovered'
          }, { onConflict: 'url' });
          saved++;
        }
        await supabase.from('discovery_sources').update({ last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', source.id);
      } catch (err: any) {
        errors.push({ source: source.source_name, error: err.message });
      }
    }

    let learningMemory: any = null;
    if (crawlerItemsForLearning.length) {
      learningMemory = await learnFromCrawlerItems(supabase, {
        runType: 'discovery_crawler_learning',
        source: 'discovery-run',
        items: crawlerItemsForLearning,
        mode
      });
    }

    await supabase.from('discovery_runs').update({ status: 'completed', finished_at: new Date().toISOString(), summary: { saved, errors, learning_memory: learningMemory } }).eq('id', runRow.id);
    const log = await insertSessionLog({
      actions_completed: ['discovery_run', VERSION, `saved:${saved}`, `learned_rules:${learningMemory?.algorithmRules || 0}`, `learned_patterns:${learningMemory?.stylePatterns || 0}`, `learned_mcp:${learningMemory?.mcpOpportunities || 0}`],
      decisions_made: [],
      pending_tasks: ['Review discovered_items with high repo_potential_score and run repo-ingest.', 'Use growth_learning_runs to verify every crawler run produced memory or explicit no-learning evidence.'],
      next_recommendation: 'Run repo-ingest for strong GitHub repos, then format-decision and production-cycle. Do not bypass learning memory.'
    });
    return Response.json({ ok: true, version: VERSION, run_id: runRow.id, saved, errors, learningMemory, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
