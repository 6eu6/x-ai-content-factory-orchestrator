import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { evaluateBrainRule, evaluateStylePattern } from '../../../lib/brain-quality';

const VERSION = 'brain-quality-report-v1';

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit') || 100)));

    // ── جلب القواعد الخوارزمية ──
    const { data: algoRules, error: algoError } = await supabase
      .from('x_algorithm_learning_rules')
      .select('*')
      .in('status', ['active', 'watch'])
      .order('confidence_score', { ascending: true })
      .limit(limit);

    if (algoError) {
      return Response.json({ ok: false, version: VERSION, error: `algo_rules: ${algoError.message}` }, { status: 500 });
    }

    // ── جلب الأنماط الأسلوبية ──
    const { data: stylePatterns, error: styleError } = await supabase
      .from('viral_style_patterns')
      .select('*')
      .in('status', ['active', 'watch'])
      .order('confidence_score', { ascending: true })
      .limit(limit);

    if (styleError) {
      return Response.json({ ok: false, version: VERSION, error: `style_patterns: ${styleError.message}` }, { status: 500 });
    }

    // ── تقييم كل قاعدة ──
    const algoEvaluations = (algoRules || []).map(rule => ({
      id: rule.id,
      table: 'x_algorithm_learning_rules' as const,
      current_status: rule.status,
      preview: String(rule.rule || '').slice(0, 120),
      confidence_score: Number(rule.confidence_score ?? 5),
      ...evaluateBrainRule(rule)
    }));

    const styleEvaluations = (stylePatterns || []).map(pattern => ({
      id: pattern.id,
      table: 'viral_style_patterns' as const,
      current_status: pattern.status,
      preview: String(pattern.pattern_name || '').slice(0, 120),
      confidence_score: Number(pattern.confidence_score ?? 5),
      ...evaluateStylePattern(pattern)
    }));

    const allEvaluations = [...algoEvaluations, ...styleEvaluations];

    // ── إحصائيات التوصيات ──
    const statusSuggestions = {
      active: allEvaluations.filter(e => e.recommended_status === 'active').length,
      watch: allEvaluations.filter(e => e.recommended_status === 'watch').length,
      archived: allEvaluations.filter(e => e.recommended_status === 'archived').length
    };

    // ── التغييرات المقترحة (حيث التوصية تختلف عن الحالة الحالية) ──
    const suggestedChanges = allEvaluations
      .filter(e => e.recommended_status !== e.current_status)
      .sort((a, b) => a.quality_score - b.quality_score)
      .map(e => ({
        table: e.table,
        id: e.id,
        from: e.current_status,
        to: e.recommended_status,
        quality_score: e.quality_score,
        confidence_score: e.confidence_score,
        preview: e.preview || '',
        reasons: e.reasons
      }));

    // ── أضعف 20 ──
    const weakest = allEvaluations
      .sort((a, b) => a.quality_score - b.quality_score)
      .slice(0, 20)
      .map(e => ({
        table: e.table,
        id: e.id,
        current_status: e.current_status,
        recommended_status: e.recommended_status,
        quality_score: e.quality_score,
        confidence_score: e.confidence_score,
        preview: e.preview || '',
        reasons: e.reasons
      }));

    return Response.json({
      ok: true,
      version: VERSION,
      mode: 'dry_run_report_only',
      inspected: {
        algorithm_rules: algoEvaluations.length,
        style_patterns: styleEvaluations.length,
        total: allEvaluations.length
      },
      status_suggestions: statusSuggestions,
      suggested_changes_count: suggestedChanges.length,
      weakest,
      suggested_changes: suggestedChanges.slice(0, 50)
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
