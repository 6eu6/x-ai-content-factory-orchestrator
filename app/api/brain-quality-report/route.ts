import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { evaluateBrainRule, evaluateStylePattern } from '../../../lib/brain-quality';

function numberParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const limit = numberParam(url, 'limit', 120, 10, 500);
    const supabase = supabaseAdmin();

    const { data: rules, error: rulesError } = await supabase
      .from('x_algorithm_learning_rules')
      .select('id, rule_type, rule, evidence, source_type, source_url, applies_to, confidence_score, status, updated_at')
      .in('status', ['active', 'watch'])
      .order('updated_at', { ascending: true })
      .limit(limit);

    if (rulesError) throw rulesError;

    const { data: patterns, error: patternsError } = await supabase
      .from('viral_style_patterns')
      .select('id, pattern_type, pattern_name, pattern_description, why_it_works, adaptation_for_30piq, confidence_score, status, updated_at')
      .in('status', ['active', 'watch'])
      .order('updated_at', { ascending: true })
      .limit(limit);

    if (patternsError) throw patternsError;

    const ruleDecisions = (rules || []).map((r: any) => ({
      table: 'x_algorithm_learning_rules',
      id: r.id,
      current_status: r.status,
      rule_type: r.rule_type,
      preview: String(r.rule || '').slice(0, 160),
      ...evaluateBrainRule(r)
    }));

    const patternDecisions = (patterns || []).map((p: any) => ({
      table: 'viral_style_patterns',
      id: p.id,
      current_status: p.status,
      pattern_type: p.pattern_type,
      preview: String(p.pattern_name || p.pattern_description || '').slice(0, 160),
      ...evaluateStylePattern(p)
    }));

    const all = [...ruleDecisions, ...patternDecisions].sort((a, b) => a.quality_score - b.quality_score);
    const statusSuggestions = {
      active: all.filter(d => d.recommended_status === 'active').length,
      watch: all.filter(d => d.recommended_status === 'watch').length,
      archived: all.filter(d => d.recommended_status === 'archived').length
    };
    const suggestedChanges = all.filter(d => d.recommended_status !== d.current_status);

    return Response.json({
      ok: true,
      mode: 'dry_run_report_only',
      inspected: {
        algorithm_rules: ruleDecisions.length,
        style_patterns: patternDecisions.length,
        total: all.length
      },
      status_suggestions: statusSuggestions,
      suggested_changes_count: suggestedChanges.length,
      weakest: all.slice(0, 20),
      suggested_changes: suggestedChanges.slice(0, 30)
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
