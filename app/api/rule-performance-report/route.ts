import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { calculateRulePerformanceWeight, summarizeRulePerformance, RulePerformanceInput } from '../../../lib/rule-performance';

const VERSION = 'rule-performance-report-v1';

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();

    // ── Fetch algorithm rules ──
    const { data: algoRules, error: algoError } = await supabase
      .from('x_algorithm_learning_rules')
      .select('id, rule, confidence_score, success_count, failure_count, status, rule_type')
      .order('updated_at', { ascending: false });

    if (algoError) {
      return Response.json({ ok: false, version: VERSION, error: algoError.message }, { status: 500 });
    }

    // ── Fetch style patterns ──
    const { data: stylePatterns, error: styleError } = await supabase
      .from('viral_style_patterns')
      .select('id, pattern_name, confidence_score, success_count, failure_count, status, pattern_type')
      .order('updated_at', { ascending: false });

    if (styleError) {
      return Response.json({ ok: false, version: VERSION, error: styleError.message }, { status: 500 });
    }

    // ── Compute algorithm rules stats ──
    const algoStats = computeTableStats(algoRules || [], 'rule');

    // ── Compute style patterns stats ──
    const styleStats = computeTableStats(stylePatterns || [], 'pattern_name');

    // ── Warnings ──
    const warnings: string[] = [];

    if (algoStats.avg_weight < 0.4 && algoStats.total > 10) {
      warnings.push('MANY_LOW_WEIGHT_RULES');
    }
    if (styleStats.avg_weight < 0.4 && styleStats.total > 10) {
      warnings.push('MANY_LOW_WEIGHT_STYLE_PATTERNS');
    }
    if (algoStats.watch > algoStats.active * 0.3 && algoStats.total > 5) {
      warnings.push('MANY_WATCH_RULES');
    }
    if (algoStats.active > 0 && algoStats.with_success_signal === 0 && styleStats.with_success_signal === 0) {
      warnings.push('NO_SUCCESS_SIGNALS');
    }
    if (algoStats.with_high_failure > algoStats.active * 0.2 && algoStats.active > 5) {
      warnings.push('HIGH_FAILURE_RULES');
    }

    return Response.json({
      ok: true,
      version: VERSION,
      algorithm_rules: algoStats,
      style_patterns: styleStats,
      warnings
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}

function computeTableStats(rules: any[], nameField: string) {
  const total = rules.length;
  const active = rules.filter(r => r.status === 'active').length;
  const watch = rules.filter(r => r.status === 'watch').length;
  const archived = rules.filter(r => String(r.status || '').startsWith('archived')).length;
  const other = total - active - watch - archived;

  const activeRules: RulePerformanceInput[] = rules
    .filter(r => r.status === 'active')
    .map(r => ({
      confidence_score: r.confidence_score,
      success_count: r.success_count,
      failure_count: r.failure_count,
      status: r.status
    }));

  const summary = summarizeRulePerformance(activeRules);

  const withSuccessSignal = rules.filter(r => Number(r.success_count || 0) > 0).length;
  const withHighFailure = rules.filter(r => Number(r.failure_count || 0) >= 3).length;

  const strongest = summary.strongest ? {
    name: String((rules.find(r => r.confidence_score === summary.strongest!.confidence_score && r.status === 'active') || {})[nameField] || 'Unknown').slice(0, 120),
    weight: summary.strongest.weight,
    confidence_score: summary.strongest.confidence_score,
    success_count: summary.strongest.success_count
  } : null;

  const weakest = summary.weakest ? {
    name: String((rules.find(r => r.confidence_score === summary.weakest!.confidence_score && r.status === 'active') || {})[nameField] || 'Unknown').slice(0, 120),
    weight: summary.weakest.weight,
    confidence_score: summary.weakest.confidence_score,
    failure_count: summary.weakest.failure_count
  } : null;

  return {
    total,
    active,
    watch,
    archived,
    other,
    avg_weight: summary.average_weight,
    strongest,
    weakest,
    has_negative_signal: summary.has_negative_signal,
    with_success_signal: withSuccessSignal,
    with_high_failure: withHighFailure
  };
}
