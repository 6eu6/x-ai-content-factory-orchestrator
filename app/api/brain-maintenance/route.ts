import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { evaluateBrainRule, evaluateStylePattern } from '../../../lib/brain-quality';

const VERSION = 'brain-maintenance-v1';
const MAX_UPDATES_PER_RUN = 100;

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const apply = url.searchParams.get('apply') === '1';
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

    // ── تقييم كل القواعد ──
    const algoEvaluations = (algoRules || []).map(rule => ({
      id: rule.id,
      table: 'x_algorithm_learning_rules' as const,
      current_status: String(rule.status || 'active'),
      confidence_score: Number(rule.confidence_score ?? 5),
      ...evaluateBrainRule(rule)
    }));

    const styleEvaluations = (stylePatterns || []).map(pattern => ({
      id: pattern.id,
      table: 'viral_style_patterns' as const,
      current_status: String(pattern.status || 'active'),
      confidence_score: Number(pattern.confidence_score ?? 5),
      ...evaluateStylePattern(pattern)
    }));

    const allEvaluations = [...algoEvaluations, ...styleEvaluations];

    // ── التغييرات المطلوبة (حيث التوصية ≠ الحالة الحالية) ──
    const neededUpdates = allEvaluations
      .filter(e => e.recommended_status !== e.current_status)
      .sort((a, b) => a.quality_score - b.quality_score); // الأضعف أولًا

    const toWatch = neededUpdates.filter(e => e.recommended_status === 'watch').length;
    const toArchive = neededUpdates.filter(e => e.recommended_status === 'archived').length;
    const remainingUpdates = Math.max(0, neededUpdates.length - MAX_UPDATES_PER_RUN);

    // ── حد التطبيق ──
    const updatesToApply = neededUpdates.slice(0, MAX_UPDATES_PER_RUN);

    // ── حماية إضافية: لا تؤرشف قاعدة confidence >= 8 إلا إذا quality_score < 2.5 ──
    const safeUpdates = updatesToApply.filter(e => {
      if (e.recommended_status === 'archived' && e.confidence_score >= 8 && e.quality_score >= 2.5) {
        return false; // لا تؤرشف قاعدة قوية
      }
      return true;
    });

    // ── التطبيق ──
    const applied: Array<{ table: string; id: number; from: string; to: string; quality_score: number; ok: boolean; error?: string }> = [];

    if (apply) {
      for (const update of safeUpdates) {
        try {
          const { error } = await supabase
            .from(update.table)
            .update({ status: update.recommended_status, updated_at: new Date().toISOString() })
            .eq('id', update.id);

          if (error) {
            applied.push({ table: update.table, id: update.id, from: update.current_status, to: update.recommended_status, quality_score: update.quality_score, ok: false, error: error.message });
          } else {
            applied.push({ table: update.table, id: update.id, from: update.current_status, to: update.recommended_status, quality_score: update.quality_score, ok: true });
          }
        } catch (e: any) {
          applied.push({ table: update.table, id: update.id, from: update.current_status, to: update.recommended_status, quality_score: update.quality_score, ok: false, error: e.message });
        }
      }
    }

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
        reasons: e.reasons
      }));

    // ── التغييرات المقترحة ──
    const suggestedChanges = neededUpdates
      .slice(0, 50)
      .map(e => ({
        table: e.table,
        id: e.id,
        from: e.current_status,
        to: e.recommended_status,
        quality_score: e.quality_score,
        confidence_score: e.confidence_score,
        reasons: e.reasons
      }));

    return Response.json({
      ok: true,
      version: VERSION,
      mode: apply ? 'apply' : 'dry_run',
      inspected: {
        algorithm_rules: algoEvaluations.length,
        style_patterns: styleEvaluations.length,
        total: allEvaluations.length
      },
      recommendations: {
        total_updates: neededUpdates.length,
        to_watch: toWatch,
        to_archive: toArchive,
        remaining_updates: remainingUpdates,
        blocked_by_safety: updatesToApply.length - safeUpdates.length
      },
      applied,
      weakest,
      suggested_changes: suggestedChanges
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
