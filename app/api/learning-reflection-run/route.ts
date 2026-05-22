import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'learning-reflection-run-v1';

type AnyRecord = Record<string, any>;

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function score(value: any, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const scaled = n > 0 && n <= 1 ? n * 10 : n;
  return Math.min(10, Math.max(1, Math.round(scaled)));
}

function sourceKeyFromUrl(url: string) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('github.com')) {
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `github:${parts[0]}/${parts[1]}`;
    }
    return `${u.hostname.replace(/^www\./, '')}`;
  } catch {
    return 'unknown';
  }
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 40), 10), 100);

    const [productionCards, discoveryRuns, discoveredItems, repoSources, repoRules, repoDecisions, formatDecisions, recentLogs, discoverySources] = await Promise.all([
      supabase.from('content_production_cards').select('*').order('created_at', { ascending: false }).limit(limit),
      supabase.from('discovery_runs').select('*').order('created_at', { ascending: false }).limit(10),
      supabase.from('discovered_items').select('*').order('created_at', { ascending: false }).limit(limit),
      supabase.from('repo_sources').select('*').order('updated_at', { ascending: false }).limit(30),
      supabase.from('repo_extracted_rules').select('*').order('created_at', { ascending: false }).limit(limit),
      supabase.from('repo_creation_decisions').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('content_format_decisions').select('*').order('created_at', { ascending: false }).limit(limit),
      supabase.from('session_logs').select('*').order('started_at', { ascending: false }).limit(20),
      supabase.from('discovery_sources').select('*').eq('active', true).order('priority', { ascending: false }).limit(20)
    ]);

    const cards = productionCards.data || [];
    const readyCount = cards.filter((c: any) => c.quality_status === 'ready').length;
    const needsReviewCount = cards.filter((c: any) => c.quality_status !== 'ready').length;
    const failureReasons: Record<string, number> = {};
    for (const card of cards) {
      for (const reason of asArray(card.quality_reasons)) {
        const key = `${card.production_type || 'unknown'}:${reason}`;
        failureReasons[key] = (failureReasons[key] || 0) + 1;
      }
    }

    const sourceStats: Record<string, AnyRecord> = {};
    for (const card of cards) {
      for (const sourceUrl of asArray(card.source_urls)) {
        const key = sourceKeyFromUrl(String(sourceUrl || ''));
        if (!sourceStats[key]) sourceStats[key] = { source_key: key, ready: 0, review: 0, examples: [] };
        if (card.quality_status === 'ready') sourceStats[key].ready += 1;
        else sourceStats[key].review += 1;
        sourceStats[key].examples.push({ id: card.id, type: card.production_type, status: card.quality_status });
      }
    }

    const prompt = `You are the self-improvement layer for @${optionalEnv('X_USERNAME', '30piq')} content factory.
Review recent system outputs and produce actionable learning rules. This is not model training; it is operational memory.
Focus on:
- quality gate improvements
- prompt improvements
- source priority adjustments
- format decision improvements
- repo build planning improvements
- discovery source expansion
Return JSON only:
{
  "summary":"...",
  "system_learning_rules":[{"rule_type":"quality|format_decision|source_selection|repo_build|discovery|production","rule":"...","evidence":"...","applies_to":"...","confidence_score":1}],
  "quality_failure_patterns":[{"failure_reason":"...","production_type":"...","suggested_fix":"...","evidence":"..."}],
  "prompt_improvements":[{"target_endpoint":"...","issue":"...","proposed_change":"...","evidence":"...","confidence_score":1}],
  "source_adjustments":[{"source_key":"...","source_type":"github|web|x|repo","source_host":"...","topic_cluster":"...","priority_adjustment":1,"notes":"..."}],
  "new_discovery_sources":[{"source_name":"...","source_type":"github_search|web_search","query_template":"...","topic_cluster":"...","priority":1,"cadence_hours":24,"notes":"..."}],
  "next_build_steps":["..."]
}
metrics=${JSON.stringify({ readyCount, needsReviewCount, failureReasons, sourceStats })}
productionCards=${JSON.stringify(cards)}
discoveryRuns=${JSON.stringify(discoveryRuns.data || [])}
discoveredItems=${JSON.stringify(discoveredItems.data || [])}
repoSources=${JSON.stringify(repoSources.data || [])}
repoRules=${JSON.stringify(repoRules.data || [])}
repoDecisions=${JSON.stringify(repoDecisions.data || [])}
formatDecisions=${JSON.stringify(formatDecisions.data || [])}
discoverySources=${JSON.stringify(discoverySources.data || [])}
recentLogs=${JSON.stringify(recentLogs.data || [])}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.04,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Produce operational self-improvement memory for the content factory. Return JSON only.' },
        { role: 'user', content: prompt }
      ]
    });

    const reflection = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const { data: reflectionRow, error: reflectionError } = await supabase.from('system_reflections').insert({
      reflection_type: 'learning_reflection',
      status: 'completed',
      input_window: { limit, readyCount, needsReviewCount },
      summary: reflection.summary || null,
      evidence: { metrics: { readyCount, needsReviewCount, failureReasons, sourceStats }, reflection },
      updated_at: new Date().toISOString()
    }).select('*').single();
    if (reflectionError) throw reflectionError;

    let rulesInserted = 0;
    const rules = asArray(reflection.system_learning_rules).slice(0, 40);
    for (const rule of rules) {
      const text = String(rule.rule || '').trim();
      if (!text) continue;
      const { error } = await supabase.from('system_learning_rules').upsert({
        rule_type: String(rule.rule_type || 'general').slice(0, 80),
        rule: text,
        evidence: rule.evidence || null,
        applies_to: rule.applies_to || null,
        confidence_score: score(rule.confidence_score, 7),
        status: 'active',
        source_reflection_id: reflectionRow.id,
        updated_at: new Date().toISOString()
      }, { onConflict: 'rule_type,rule' });
      if (!error) rulesInserted++;
    }

    let failuresUpserted = 0;
    const failureItems = asArray(reflection.quality_failure_patterns).slice(0, 30);
    for (const item of failureItems) {
      const failureReason = String(item.failure_reason || '').trim();
      if (!failureReason) continue;
      const productionType = item.production_type || 'unknown';
      const { data: existing } = await supabase.from('quality_failure_patterns').select('*').eq('failure_reason', failureReason).eq('production_type', productionType).maybeSingle();
      const { error } = await supabase.from('quality_failure_patterns').upsert({
        failure_reason: failureReason,
        production_type: productionType,
        occurrence_count: (existing?.occurrence_count || 0) + 1,
        latest_examples: [{ evidence: item.evidence || null, at: new Date().toISOString() }],
        suggested_fix: item.suggested_fix || null,
        status: 'open',
        source_reflection_id: reflectionRow.id,
        last_seen_at: new Date().toISOString()
      }, { onConflict: 'failure_reason,production_type' });
      if (!error) failuresUpserted++;
    }

    let promptImprovementsInserted = 0;
    const promptItems = asArray(reflection.prompt_improvements).slice(0, 30);
    for (const item of promptItems) {
      if (!item.target_endpoint || !item.issue || !item.proposed_change) continue;
      const { error } = await supabase.from('prompt_improvement_candidates').insert({
        target_endpoint: item.target_endpoint,
        issue: item.issue,
        proposed_change: item.proposed_change,
        evidence: item.evidence || null,
        confidence_score: score(item.confidence_score, 7),
        status: 'candidate',
        source_reflection_id: reflectionRow.id
      });
      if (!error) promptImprovementsInserted++;
    }

    let sourceAdjustmentsUpserted = 0;
    const sourceAdjustments = asArray(reflection.source_adjustments).slice(0, 30);
    for (const item of sourceAdjustments) {
      const sourceKey = String(item.source_key || '').trim();
      if (!sourceKey) continue;
      const { error } = await supabase.from('source_performance').upsert({
        source_key: sourceKey,
        source_type: item.source_type || null,
        source_host: item.source_host || null,
        topic_cluster: item.topic_cluster || null,
        priority_adjustment: Math.min(5, Math.max(-5, Number(item.priority_adjustment || 0))),
        notes: item.notes || null,
        last_evaluated_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'source_key' });
      if (!error) sourceAdjustmentsUpserted++;
    }

    let newSourcesUpserted = 0;
    const newSources = asArray(reflection.new_discovery_sources).slice(0, 10);
    for (const item of newSources) {
      if (!item.source_name || !item.source_type || !item.query_template) continue;
      const { error } = await supabase.from('discovery_sources').upsert({
        source_name: String(item.source_name).slice(0, 120),
        source_type: item.source_type,
        query_template: item.query_template,
        topic_cluster: item.topic_cluster || 'auto_discovered',
        priority: Math.min(10, Math.max(1, Number(item.priority || 6))),
        active: true,
        cadence_hours: Math.min(168, Math.max(6, Number(item.cadence_hours || 24))),
        notes: item.notes || 'Auto-created by learning reflection.',
        auto_tuned: true,
        updated_at: new Date().toISOString()
      }, { onConflict: 'source_name' });
      if (!error) newSourcesUpserted++;
    }

    const log = await insertSessionLog({
      actions_completed: ['learning_reflection_run', VERSION, `rules:${rulesInserted}`, `failures:${failuresUpserted}`, `prompt_improvements:${promptImprovementsInserted}`, `source_adjustments:${sourceAdjustmentsUpserted}`, `new_sources:${newSourcesUpserted}`],
      decisions_made: [reflection.summary || {}, { reflection_id: reflectionRow.id }],
      pending_tasks: asArray(reflection.next_build_steps).slice(0, 12),
      next_recommendation: 'Review system_learning_rules and prompt_improvement_candidates, then apply high-confidence improvements.'
    });

    return Response.json({
      ok: true,
      version: VERSION,
      reflection_id: reflectionRow.id,
      summary: reflection.summary || null,
      inserted: { rules: rulesInserted, quality_failure_patterns: failuresUpserted, prompt_improvements: promptImprovementsInserted, source_adjustments: sourceAdjustmentsUpserted, new_discovery_sources: newSourcesUpserted },
      reflection,
      sessionLog: log
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
