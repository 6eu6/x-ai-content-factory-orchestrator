import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { webSearch } from '../../../lib/web-search';
import { evaluateContentQuality } from '../../../lib/quality';

const VERSION = 'learning-cycle-v1-research-viral-fusion';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function host(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function scoreHost(url: string) {
  const h = host(url);
  if (/github\.com|arxiv\.org|openai\.com|anthropic\.com|deepmind\.google|microsoft\.com|googleblog\.com|nature\.com|science\.org/i.test(h)) return 9;
  if (/techcrunch\.com|theverge\.com|wired\.com|mit\.edu|stanford\.edu|berkeley\.edu|medium\.com|substack\.com/i.test(h)) return 7;
  return 5;
}

function normalizeQueries(value: any) {
  const defaults = [
    'AI productivity workflow knowledge workers practical guide 2026',
    'open source AI agents productivity GitHub workflow automation',
    'AI career growth productivity tools research workflow',
    'AI coding agents productivity workflows developers GitHub',
    'AI automation workflow templates knowledge workers'
  ];
  const custom = asArray(value).map((x) => String(x || '').trim()).filter(Boolean);
  return (custom.length ? custom : defaults).slice(0, 8);
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch {} }
    const queries = normalizeQueries(body.queries || url.searchParams.getAll('q'));
    const limit = Math.min(Math.max(Number(body.limit || url.searchParams.get('limit') || 5), 3), 10);

    const { data: cycle, error: cycleError } = await supabase.from('learning_cycles').insert({
      cycle_type: 'research_viral_fusion',
      status: 'started',
      inputs: { queries, limit, version: VERSION }
    }).select('*').single();
    if (cycleError) throw cycleError;

    const searchResults: any[] = [];
    for (const query of queries) {
      const results = await webSearch(query, limit);
      searchResults.push({ query, results });
      const rows = results.map((r: any) => ({
        learning_cycle_id: cycle.id,
        query,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        source_provider: r.source,
        source_host: host(r.url),
        source_quality_score: scoreHost(r.url),
        freshness_score: 5,
        status: 'new'
      }));
      if (rows.length) await supabase.from('raw_research_items').upsert(rows, { onConflict: 'url', ignoreDuplicates: true });
    }

    const [viralTweets, viralPatterns, recentContent, rawItems] = await Promise.all([
      supabase.from('viral_tweet_analyses').select('*').order('engagement_per_1k_followers', { ascending: false }).limit(20),
      supabase.from('viral_account_patterns').select('*').not('evidence', 'is', null).order('confidence_score', { ascending: false }).limit(20),
      supabase.from('content_log').select('final_text,publish_status,created_at').order('created_at', { ascending: false }).limit(30),
      supabase.from('raw_research_items').select('*').eq('learning_cycle_id', cycle.id).order('source_quality_score', { ascending: false }).limit(60)
    ]);

    const prompt = `You are the learning engine for @${optionalEnv('X_USERNAME', '30piq')}.
Goal: fuse source-backed web research with X viral mechanics to create original content opportunities and draft hypotheses.
Rules:
- Use only rawItems/searchResults as factual sources.
- Use viralTweets/viralPatterns only for structure, hook mechanics, timing, reply/bookmark reasons.
- Do not copy creator wording.
- Every opportunity and draft with factual claims must include source_urls copied exactly from rawItems.
- Prefer practical, original angles for AI x Productivity x Career Growth.
- Avoid generic claims, engagement bait, and unsupported metrics.
Return strict JSON:
{
  "learning_summary":"...",
  "new_account_discovery":[{"handle":"...","reason":"...","confidence_score":1}],
  "opportunities":[{"opportunity_type":"single_tweet|thread|article|github_asset|tool","topic":"...","angle":"...","audience_pain":"...","source_urls":["..."],"viral_pattern_ids":["..."],"evidence_notes":"...","originality_notes":"...","risk_notes":"...","confidence_score":1,"priority_score":1}],
  "hypotheses":[{"opportunity_topic":"...","format":"single_tweet|thread|article|github_asset|tool","hook_formula":"...","draft_text":"...","source_urls":["..."],"viral_mechanic":"...","why_original":"...","why_replyable":"...","why_bookmarkable":"..."}],
  "needs_more_research":["..."]
}
searchResults=${JSON.stringify(searchResults)}
rawItems=${JSON.stringify(rawItems.data)}
viralTweets=${JSON.stringify(viralTweets.data)}
viralPatterns=${JSON.stringify(viralPatterns.data)}
recentContent=${JSON.stringify(recentContent.data)}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.08,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Produce source-backed learning outputs. Facts from web sources only; viral data is structure only.' },
        { role: 'user', content: prompt }
      ]
    });

    const intel = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const opportunities = asArray(intel.opportunities).slice(0, 12);
    const insertedOpps: any[] = [];

    for (const opp of opportunities) {
      const { data: row, error } = await supabase.from('content_opportunities').insert({
        learning_cycle_id: cycle.id,
        opportunity_type: opp.opportunity_type || 'post',
        topic: opp.topic || 'AI productivity opportunity',
        angle: opp.angle || null,
        audience_pain: opp.audience_pain || null,
        source_urls: asArray(opp.source_urls),
        viral_pattern_ids: asArray(opp.viral_pattern_ids),
        evidence_notes: opp.evidence_notes || null,
        originality_notes: opp.originality_notes || null,
        risk_notes: opp.risk_notes || null,
        confidence_score: Number(opp.confidence_score || 5),
        priority_score: Number(opp.priority_score || 5),
        status: 'candidate'
      }).select('*').single();
      if (!error && row) insertedOpps.push(row);
    }

    const hypotheses = asArray(intel.hypotheses).slice(0, 12);
    const insertedHyps: any[] = [];
    for (const hyp of hypotheses) {
      const quality = evaluateContentQuality({ ...hyp, text: hyp.draft_text });
      const matchedOpp = insertedOpps.find((o) => String(o.topic).toLowerCase() === String(hyp.opportunity_topic || '').toLowerCase());
      const { data: row, error } = await supabase.from('original_content_hypotheses').insert({
        learning_cycle_id: cycle.id,
        content_opportunity_id: matchedOpp?.id || null,
        format: hyp.format || 'single_tweet',
        hook_formula: hyp.hook_formula || null,
        draft_text: hyp.draft_text || null,
        source_urls: asArray(hyp.source_urls),
        viral_mechanic: hyp.viral_mechanic || null,
        why_original: hyp.why_original || null,
        why_replyable: hyp.why_replyable || null,
        why_bookmarkable: hyp.why_bookmarkable || null,
        quality_status: quality.status,
        quality_reasons: quality.reasons,
        status: quality.status === 'ready' ? 'candidate_ready' : 'needs_review'
      }).select('*').single();
      if (!error && row) insertedHyps.push(row);
    }

    for (const item of asArray(intel.new_account_discovery).slice(0, 10)) {
      const handle = String(item.handle || '').replace(/^@/, '').trim();
      if (handle) await supabase.from('accounts').upsert({ handle, username: handle, tier: 3, active: true, notes: `Auto-discovered by ${VERSION}: ${item.reason || ''}` }, { onConflict: 'handle' });
    }

    await supabase.from('learning_cycles').update({
      status: 'completed',
      summary: {
        learning_summary: intel.learning_summary || null,
        opportunities: insertedOpps.length,
        hypotheses: insertedHyps.length,
        ready_hypotheses: insertedHyps.filter((h) => h.quality_status === 'ready').length,
        needs_more_research: intel.needs_more_research || []
      },
      updated_at: new Date().toISOString()
    }).eq('id', cycle.id);

    const log = await insertSessionLog({
      actions_completed: ['learning_cycle', VERSION, 'web_research_saved', 'viral_memory_fused', 'opportunities_created', 'hypotheses_created'],
      decisions_made: [intel.learning_summary || {}, { opportunities: insertedOpps.length, hypotheses: insertedHyps.length }],
      pending_tasks: asArray(intel.needs_more_research).slice(0, 10),
      next_recommendation: 'Review original_content_hypotheses with quality_status=ready, then run daily-run after source-backed opportunities exist.'
    });

    return Response.json({ ok: true, version: VERSION, cycle_id: cycle.id, searchResults, intel, inserted: { opportunities: insertedOpps.length, hypotheses: insertedHyps.length, ready_hypotheses: insertedHyps.filter((h) => h.quality_status === 'ready').length }, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
