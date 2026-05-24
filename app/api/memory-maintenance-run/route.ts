import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'memory-maintenance-run-v1';

function groupKey(value: any) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
}

function isRawSourceName(name: string) {
  const n = String(name || '').toLowerCase();
  return /github|http|www\.|\.com|\/|structure: [a-z0-9_-]+\/[a-z0-9_-]+/.test(n);
}

function clampScore(n: any, fallback = 7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(10, Math.max(1, Math.round(x)));
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode') || 'trial';
    const apply = url.searchParams.get('apply') !== '0';

    const [rulesRes, patternsRes, mcpRes, runsRes] = await Promise.all([
      supabase.from('x_algorithm_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(300),
      supabase.from('viral_style_patterns').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(500),
      supabase.from('mcp_opportunity_map').select('*').eq('status', 'active').order('priority_score', { ascending: false }).limit(500),
      supabase.from('growth_learning_runs').select('id,run_type,summary,evidence,created_at').order('created_at', { ascending: false }).limit(30)
    ]);

    if (rulesRes.error) throw rulesRes.error;
    if (patternsRes.error) throw patternsRes.error;
    if (mcpRes.error) throw mcpRes.error;
    if (runsRes.error) throw runsRes.error;

    const rules = rulesRes.data || [];
    const patterns = patternsRes.data || [];
    const opportunities = mcpRes.data || [];

    const duplicatePatternGroups: Record<string, any[]> = {};
    for (const p of patterns) {
      const key = `${groupKey(p.pattern_type)}:${groupKey(p.pattern_name)}`;
      duplicatePatternGroups[key] = duplicatePatternGroups[key] || [];
      duplicatePatternGroups[key].push(p);
    }

    const duplicateOpportunityGroups: Record<string, any[]> = {};
    for (const o of opportunities) {
      const key = `${groupKey(o.opportunity_area)}:${groupKey(o.mcp_use_case)}`;
      duplicateOpportunityGroups[key] = duplicateOpportunityGroups[key] || [];
      duplicateOpportunityGroups[key].push(o);
    }

    const rawSourcePatterns = patterns.filter((p) => isRawSourceName(p.pattern_name));
    const weakPatterns = patterns.filter((p) =>
      !p.pattern_description ||
      String(p.pattern_description).length < 45 ||
      isRawSourceName(p.pattern_name) ||
      /use this crawled item as a source-grounded pattern/i.test(String(p.pattern_description || ''))
    );

    const mergedPatternDuplicates: any[] = [];
    for (const group of Object.values(duplicatePatternGroups)) {
      if (group.length <= 1) continue;
      const sorted = group.sort((a, b) => clampScore(b.confidence_score) - clampScore(a.confidence_score));
      const keeper = sorted[0];
      const archive = sorted.slice(1);
      mergedPatternDuplicates.push({ keeper_id: keeper.id, archived_ids: archive.map((x) => x.id), pattern_name: keeper.pattern_name });
      if (apply) {
        await supabase.from('viral_style_patterns').update({ status: 'archived_duplicate', updated_at: new Date().toISOString() }).in('id', archive.map((x) => x.id));
        await supabase.from('viral_style_patterns').update({ confidence_score: Math.min(10, clampScore(keeper.confidence_score) + 1), updated_at: new Date().toISOString() }).eq('id', keeper.id);
      }
    }

    const mergedOpportunityDuplicates: any[] = [];
    for (const group of Object.values(duplicateOpportunityGroups)) {
      if (group.length <= 1) continue;
      const sorted = group.sort((a, b) => clampScore(b.priority_score) - clampScore(a.priority_score));
      const keeper = sorted[0];
      const archive = sorted.slice(1);
      mergedOpportunityDuplicates.push({ keeper_id: keeper.id, archived_ids: archive.map((x) => x.id), mcp_use_case: keeper.mcp_use_case });
      if (apply) {
        await supabase.from('mcp_opportunity_map').update({ status: 'archived_duplicate', updated_at: new Date().toISOString() }).in('id', archive.map((x) => x.id));
        await supabase.from('mcp_opportunity_map').update({ priority_score: Math.min(10, clampScore(keeper.priority_score) + 1), updated_at: new Date().toISOString() }).eq('id', keeper.id);
      }
    }

    if (apply && weakPatterns.length) {
      await supabase.from('viral_style_patterns').update({ status: 'needs_review_weak_memory', updated_at: new Date().toISOString() }).in('id', weakPatterns.map((p) => p.id));
    }

    const workingMemory = {
      selected_at: new Date().toISOString(),
      version: VERSION,
      top_algorithm_rules: rules.slice(0, 25).map((r) => ({ rule_type: r.rule_type, rule: r.rule, confidence_score: r.confidence_score, applies_to: r.applies_to, source_url: r.source_url })),
      top_style_patterns: patterns
        .filter((p) => !weakPatterns.some((w) => w.id === p.id))
        .slice(0, 35)
        .map((p) => ({ pattern_type: p.pattern_type, pattern_name: p.pattern_name, pattern_description: p.pattern_description, confidence_score: p.confidence_score, adaptation_for_30piq: p.adaptation_for_30piq })),
      top_mcp_opportunities: opportunities.slice(0, 30).map((o) => ({ opportunity_area: o.opportunity_area, mcp_use_case: o.mcp_use_case, audience_segment: o.audience_segment, priority_score: o.priority_score, confidence_score: o.confidence_score })),
      avoid: {
        raw_source_patterns: rawSourcePatterns.slice(0, 20).map((p) => p.pattern_name),
        weak_pattern_count: weakPatterns.length,
        rule: 'Do not use raw source titles as style patterns. Use mechanisms only.'
      }
    };

    const summary = `Memory maintenance: ${rules.length} rules, ${patterns.length} patterns, ${opportunities.length} opportunities reviewed; ${weakPatterns.length} weak patterns flagged; ${mergedPatternDuplicates.length} pattern duplicate groups; ${mergedOpportunityDuplicates.length} opportunity duplicate groups.`;
    const runRow = await supabase.from('growth_learning_runs').insert({
      run_type: 'memory_maintenance',
      mode,
      summary,
      evidence: {
        apply,
        working_memory: workingMemory,
        weak_patterns_flagged: weakPatterns.map((p) => ({ id: p.id, pattern_name: p.pattern_name })).slice(0, 50),
        merged_pattern_duplicates: mergedPatternDuplicates,
        merged_opportunity_duplicates: mergedOpportunityDuplicates,
        recent_learning_runs: runsRes.data || []
      },
      status: 'completed',
      test_run: mode !== 'production',
      updated_at: new Date().toISOString()
    }).select('*').single();
    if (runRow.error) throw runRow.error;

    const log = await insertSessionLog({
      actions_completed: ['memory_maintenance_run', VERSION, `weak_patterns:${weakPatterns.length}`, `pattern_duplicate_groups:${mergedPatternDuplicates.length}`, `opportunity_duplicate_groups:${mergedOpportunityDuplicates.length}`],
      decisions_made: [{ run_id: runRow.data.id, apply, working_memory_counts: { rules: workingMemory.top_algorithm_rules.length, patterns: workingMemory.top_style_patterns.length, opportunities: workingMemory.top_mcp_opportunities.length } }],
      pending_tasks: ['Use working_memory from latest memory_maintenance growth_learning_run before daily production.', 'Add explicit performance feedback loop after real posting metrics exist.'],
      next_recommendation: 'Review weak patterns and then wire working memory into growth-daily-plan.'
    });

    return Response.json({
      ok: true,
      version: VERSION,
      apply,
      run_id: runRow.data.id,
      summary,
      counts: {
        rules: rules.length,
        patterns: patterns.length,
        opportunities: opportunities.length,
        weak_patterns: weakPatterns.length,
        raw_source_patterns: rawSourcePatterns.length,
        pattern_duplicate_groups: mergedPatternDuplicates.length,
        opportunity_duplicate_groups: mergedOpportunityDuplicates.length,
        working_memory_rules: workingMemory.top_algorithm_rules.length,
        working_memory_patterns: workingMemory.top_style_patterns.length,
        working_memory_opportunities: workingMemory.top_mcp_opportunities.length
      },
      workingMemory,
      sessionLog: log
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
