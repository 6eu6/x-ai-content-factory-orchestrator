import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { webSearch } from '../../../lib/web-search';
import { sourceBoundFilter, safeBriefFromOpportunities, hasUnsupportedEntity, sourceCorpus } from '../../../lib/source-bound';
import { learnFromCrawlerItems, toArray } from '../../../lib/learning-memory';

const VERSION = 'research-v4-strict-source-bound';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function sanitize(raw: any, searchResults: any[]) {
  const corpus = sourceCorpus(searchResults);
  const opportunities = sourceBoundFilter(raw.opportunities, searchResults);
  const recommended_today = sourceBoundFilter(raw.recommended_today, searchResults);
  const trend_updates = sourceBoundFilter(raw.trend_updates, searchResults);
  const creator_intel_updates = sourceBoundFilter(raw.creator_intel_updates, searchResults);
  const articleCandidates = sourceBoundFilter(Array.isArray(raw.article_plan) ? raw.article_plan : [raw.article_plan], searchResults);
  const githubCandidates = sourceBoundFilter(Array.isArray(raw.github_asset_plan) ? raw.github_asset_plan : [raw.github_asset_plan], searchResults);
  const daily_run_brief = hasUnsupportedEntity(raw.daily_run_brief, corpus) ? safeBriefFromOpportunities(opportunities) : (raw.daily_run_brief || safeBriefFromOpportunities(opportunities));
  return {
    mode: 'strict_source_bound_research',
    market_read: hasUnsupportedEntity(raw.market_read, corpus) ? { summary: 'Source-bound market read only. Unsupported entities removed.' } : (raw.market_read || {}),
    viral_patterns: hasUnsupportedEntity(raw.viral_patterns, corpus) ? [] : (raw.viral_patterns || []),
    opportunities,
    recommended_today,
    github_asset_plan: githubCandidates[0] || { needed: false, reason: 'No source-backed GitHub asset selected.', source_urls: [] },
    article_plan: articleCandidates[0] || { needed: false, reason: 'No source-backed article selected.', source_urls: [] },
    creator_intel_updates,
    trend_updates,
    needs_more_research: raw.needs_more_research || [],
    daily_run_brief,
    quality_bar: raw.quality_bar || { rule: 'Use only source-backed claims with source_urls.' },
    rejected_unverified: {
      reason: 'Strict filter removed unsupported names, unsourced recommendations, and source_urls not present in searchResults.',
      opportunities_in: Array.isArray(raw.opportunities) ? raw.opportunities.length : 0,
      opportunities_kept: opportunities.length,
      recommended_kept: recommended_today.length,
      trend_updates_kept: trend_updates.length
    }
  };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const u = new URL(req.url);
    const queries = [
      'AI productivity tools career growth workflow checklist',
      'open source AI agents productivity GitHub knowledge workers',
      'AI automation workflows n8n productivity templates career',
      'AI tools resume job search interview prep career development',
      'knowledge worker AI productivity research practical workflow'
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

    const prompt = `You are a strict research operator for @30piq, an English AI x Productivity x Career Growth account.
Goal: find source-backed opportunities that can become posts, articles, GitHub assets, or tools.
Rules:
1. Use ONLY searchResults and database context.
2. Every actionable item MUST include source_urls copied exactly from searchResults.
3. Do not mention any tool, model, creator, company, leak, metric, or trend unless it appears in searchResults text or URL.
4. If unsupported, put it in needs_more_research, not in recommended_today.
5. Prefer opportunities that can become: practical checklist, template repo, small tool, article, carousel, or thread.
Return strict JSON only with keys: market_read, viral_patterns, opportunities, recommended_today, github_asset_plan, article_plan, creator_intel_updates, trend_updates, needs_more_research, daily_run_brief, quality_bar.
searchResults=${JSON.stringify(searchResults)}
accounts=${JSON.stringify(accounts.data)}
sources=${JSON.stringify(sources.data)}
trends=${JSON.stringify(trends.data)}
accountState=${JSON.stringify(accountState.data)}
recentContent=${JSON.stringify(recentContent.data)}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.03,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Strict source-bound extraction. No unsupported entities. No fake metrics. Every action needs source_urls.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = parseModelJson(completion.choices[0]?.message?.content || '');
    const intel = sanitize(raw, searchResults);

    if (intel.trend_updates.length) {
      await supabase.from('trends').insert(intel.trend_updates.slice(0, 10).map((t: any) => ({ topic: t.topic || t.title, source: (t.source_urls || [])[0], heat_score: t.heat_score || 5, content_type_suggestion: t.content_type_suggestion || t.content_type || null, notes: t.notes || t.angle || null })));
    }
    if (intel.creator_intel_updates.length) {
      await supabase.from('creator_intel').insert(intel.creator_intel_updates.slice(0, 10).map((c: any) => ({ creator_handle: c.creator_handle || 'unknown', post_url: (c.source_urls || [])[0] || null, topic: c.topic || null, hook_pattern: c.hook_pattern || null, format_pattern: c.format_pattern || null, why_it_worked: c.why_it_worked || null, adaptation_idea: c.adaptation_idea || null, status: 'new' })));
    }

    // --- Normalize intel items for learning-memory ---
    const crawlerItems = [
      ...toArray(intel.opportunities).map((o: any) => ({
        title: o.topic || o.angle || o.type || 'opportunity',
        url: toArray(o.source_urls)[0] || '',
        source_urls: o.source_urls || [],
        summary: [o.description, o.angle, o.audience_pain, o.evidence_notes].filter(Boolean).join(' | '),
        confidence_score: o.confidence_score || o.priority_score,
        priority_score: o.priority_score,
        content_potential_score: o.priority_score || o.confidence_score
      })),
      ...toArray(intel.recommended_today).map((r: any) => ({
        title: r.topic || r.angle || r.type || 'recommended',
        url: toArray(r.source_urls)[0] || '',
        source_urls: r.source_urls || [],
        summary: [r.description, r.angle, r.audience_pain, r.evidence_notes].filter(Boolean).join(' | '),
        confidence_score: r.confidence_score || r.priority_score,
        priority_score: r.priority_score,
        content_potential_score: r.priority_score || r.confidence_score
      })),
      ...toArray(intel.viral_patterns).map((v: any) => ({
        title: v.pattern_name || v.pattern || v.hook_style || v.pattern_type || 'viral_pattern',
        url: toArray(v.source_urls)[0] || '',
        source_urls: v.source_urls || [],
        summary: [v.pattern_description, v.example, v.why_it_works, v.adaptation_for_30piq].filter(Boolean).join(' | '),
        confidence_score: v.confidence_score
      })),
      ...toArray(intel.creator_intel_updates).map((c: any) => ({
        title: [c.creator_handle, c.topic, c.hook_pattern].filter(Boolean).join(' — '),
        url: c.post_url || toArray(c.source_urls)[0] || '',
        source_urls: c.source_urls || [],
        summary: [c.hook_pattern, c.format_pattern, c.why_it_worked, c.adaptation_idea].filter(Boolean).join(' | ')
      })),
      ...toArray(intel.trend_updates).map((t: any) => ({
        title: t.topic || t.title || 'trend',
        url: t.source || toArray(t.source_urls)[0] || '',
        source_urls: t.source_urls || [],
        summary: [t.angle || t.notes, t.content_type_suggestion].filter(Boolean).join(' | '),
        confidence_score: t.heat_score
      })),
      ...(intel.github_asset_plan?.needed ? [{
        title: intel.github_asset_plan.proposed_name || intel.github_asset_plan.repo_goal || 'github_asset',
        url: toArray(intel.github_asset_plan.source_urls)[0] || '',
        source_urls: intel.github_asset_plan.source_urls || [],
        summary: intel.github_asset_plan.reason || intel.github_asset_plan.repo_goal || ''
      }] : []),
      ...(intel.article_plan?.needed ? [{
        title: intel.article_plan.proposed_title || intel.article_plan.topic || 'article',
        url: toArray(intel.article_plan.source_urls)[0] || '',
        source_urls: intel.article_plan.source_urls || [],
        summary: intel.article_plan.reason || intel.article_plan.angle || ''
      }] : [])
    ];

    let learningMemoryResult: any = null;
    if (crawlerItems.length > 0) {
      learningMemoryResult = await learnFromCrawlerItems(supabase, {
        runType: 'research_intel_v4',
        source: 'web_search_crawl',
        items: crawlerItems,
        mode: u.searchParams.get('mode') || 'trial'
      });
    }

    const log = await insertSessionLog({
      actions_completed: [
        'research_intel_run', VERSION, 'strict_source_bound_filter_applied',
        learningMemoryResult ? `learning_memory:${learningMemoryResult.algorithmRules}algo+${learningMemoryResult.stylePatterns}style+${learningMemoryResult.mcpOpportunities}mcp` : 'learning_memory:skipped'
      ],
      decisions_made: [intel.recommended_today],
      pending_tasks: [intel.daily_run_brief],
      next_recommendation: 'Run daily-run after reviewing strict source-bound research.'
    });

    return Response.json({
      ok: true,
      version: VERSION,
      search_provider: optionalEnv('SEARCH_PROVIDER', 'auto'),
      searchResults,
      intel,
      learningMemory: learningMemoryResult ? {
        algorithmRules: learningMemoryResult.algorithmRules,
        stylePatterns: learningMemoryResult.stylePatterns,
        mcpOpportunities: learningMemoryResult.mcpOpportunities,
        rejectedLowQuality: learningMemoryResult.rejectedLowQuality,
        runId: learningMemoryResult.run?.id
      } : null,
      sessionLog: log
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
