import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { getDefaultRouting, clearRoutingCache, TaskType } from '../../../lib/model-router';

/**
 * GET /api/model-router
 * يرجع كل قواعد التوجيه (من Supabase + الافتراضية)
 *
 * POST /api/model-router
 * يضيف أو يحدّث قاعدة توجيه
 * Body: { task_type, model_id, temperature?, max_tokens?, top_p?, response_format?, description?, active?, provider? }
 *
 * DELETE /api/model-router?task_type=xxx
 * يحذف قاعدة توجيه (يعطلها)
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();

    const { data: dbRules, error } = await supabase
      .from('model_routing_rules')
      .select('*')
      .order('task_type');

    if (error) {
      return Response.json({
        ok: true,
        source: 'defaults_only',
        message: 'Could not read from model_routing_rules table, using defaults',
        defaults: getDefaultRouting(),
        db_error: error.message
      });
    }

    const defaults = getDefaultRouting();
    const activeRules: Record<string, any> = {};
    const inactiveRules: Record<string, any> = {};

    for (const rule of (dbRules || [])) {
      if (rule.active) {
        activeRules[rule.task_type] = {
          model: rule.model_id,
          temperature: Number(rule.temperature),
          max_tokens: rule.max_tokens,
          top_p: rule.top_p ? Number(rule.top_p) : undefined,
          response_format: rule.response_format ? { type: rule.response_format } : undefined,
          description: rule.description,
          provider: rule.provider || 'cloud',
          source: 'database'
        };
      } else {
        inactiveRules[rule.task_type] = rule.model_id;
      }
    }

    const allTaskTypes = Object.keys(defaults) as TaskType[];
    const merged: Record<string, any> = {};
    for (const tt of allTaskTypes) {
      merged[tt] = activeRules[tt] || { ...defaults[tt], source: 'default' };
    }

    return Response.json({
      ok: true,
      total_task_types: allTaskTypes.length,
      active_from_db: Object.keys(activeRules).length,
      using_defaults: allTaskTypes.length - Object.keys(activeRules).length,
      inactive_rules: Object.keys(inactiveRules).length,
      routing: merged,
      inactive: inactiveRules
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();
    const { task_type, model_id, temperature, max_tokens, top_p, response_format, description, active, provider } = body;

    if (!task_type || !model_id) {
      return Response.json({ ok: false, error: 'task_type and model_id are required' }, { status: 400 });
    }

    const validTaskTypes: TaskType[] = [
      'content_generation',
      'content_crafting',
      'deep_analysis',
      'research_synthesis',
      'quality_evaluation',
      'media_description',
      'learning_extraction',
      'format_decision',
      'article_writing',
      'thread_writing',
      'performance_analysis',
      'shield_check',
      'repo_artifact',
      'casual_generation'
    ];

    if (!validTaskTypes.includes(task_type)) {
      return Response.json({
        ok: false,
        error: `Invalid task_type. Valid types: ${validTaskTypes.join(', ')}`,
        valid_types: validTaskTypes
      }, { status: 400 });
    }

    if (provider !== undefined && provider !== 'cloud' && provider !== 'local') {
      return Response.json({ ok: false, error: 'provider must be cloud or local' }, { status: 400 });
    }

    const supabase = supabaseAdmin();
    const payload: Record<string, any> = {
      task_type,
      model_id,
      temperature: temperature ?? 0.18,
      max_tokens: max_tokens ?? 2000,
      top_p: top_p ?? null,
      response_format: response_format ?? 'json_object',
      description: description ?? null,
      active: active ?? true,
      updated_at: new Date().toISOString()
    };
    if (provider !== undefined) {
      payload.provider = provider;
    }
    const { data, error } = await supabase
      .from('model_routing_rules')
      .upsert(payload, { onConflict: 'task_type' })
      .select('*')
      .single();

    if (error) {
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    clearRoutingCache();

    return Response.json({
      ok: true,
      action: 'upserted',
      rule: data,
      message: `Routing rule for '${task_type}' updated to use '${model_id}'. Cache cleared.`
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const taskType = url.searchParams.get('task_type');

    if (!taskType) {
      return Response.json({ ok: false, error: 'task_type query parameter is required' }, { status: 400 });
    }

    const supabase = supabaseAdmin();
    const { data, error } = await supabase
      .from('model_routing_rules')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('task_type', taskType)
      .select('*')
      .single();

    if (error) {
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }

    clearRoutingCache();

    return Response.json({
      ok: true,
      action: 'deactivated',
      rule: data,
      message: `Routing rule for '${taskType}' deactivated. Will fall back to default.`
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
