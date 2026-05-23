import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'system-cleanup-v1-dry-run-first';

const TABLES = [
  'x_publication_metrics',
  'repo_growth_snapshots',
  'repo_publication_events',
  'repo_investment_decisions',
  'repo_validation_runs',
  'repo_build_artifacts',
  'repo_artifact_requirements',
  'repo_build_plans',
  'owned_repo_projects',
  'content_production_cards',
  'content_format_decisions',
  'repo_creation_decisions',
  'content_opportunities',
  'repo_extracted_rules',
  'repo_source_files',
  'repo_sources',
  'discovered_items',
  'discovery_runs',
  'system_reflections',
  'system_learning_rules',
  'quality_failure_patterns',
  'prompt_improvement_candidates',
  'source_performance',
  'session_logs'
];

async function countRows(supabase: any, table: string) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq('test_run', true);
  if (error) return { table, count: null, error: error.message };
  return { table, count: count || 0 };
}

async function deleteRows(supabase: any, table: string) {
  const { error } = await supabase.from(table).delete().eq('test_run', true);
  if (error) return { table, deleted: false, error: error.message };
  return { table, deleted: true };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode') || 'dry_run';
    const confirm = url.searchParams.get('confirm') || '';
    const includeGithub = url.searchParams.get('include_github') === 'true';

    const counts = [];
    for (const table of TABLES) counts.push(await countRows(supabase, table));

    const { data: githubObjects } = await supabase
      .from('system_cleanup_registry')
      .select('*')
      .eq('cleanup_status', 'pending')
      .order('created_at', { ascending: false });

    const summary = {
      warning: 'Dry run by default. This endpoint is for cleaning trial data only.',
      mode,
      includeGithub,
      github_cleanup_note: includeGithub ? 'GitHub deletion is not automated in v1. Review and delete/archive manually or implement explicit delete later.' : 'GitHub objects are reported only.',
      tables: counts,
      github_objects: githubObjects || []
    };

    const { data: batch } = await supabase.from('system_cleanup_batches').insert({
      cleanup_type: 'trial_cleanup',
      mode,
      status: mode === 'execute' ? 'started' : 'dry_run_completed',
      target_scope: { test_run: true, includeGithub },
      summary
    }).select('*').single();

    if (mode !== 'execute') {
      const log = await insertSessionLog({
        actions_completed: ['system_cleanup', VERSION, 'dry_run'],
        decisions_made: [summary],
        pending_tasks: ['Review cleanup summary. Execute only when final system version is ready.'],
        next_recommendation: 'Use mode=execute&confirm=DELETE_TRIAL_DATA only when you want to purge trial Supabase rows.'
      });
      return Response.json({ ok: true, version: VERSION, mode: 'dry_run', batch_id: batch?.id, summary, sessionLog: log });
    }

    if (confirm !== 'DELETE_TRIAL_DATA') {
      return Response.json({ ok: false, version: VERSION, error: 'Execution blocked. Add confirm=DELETE_TRIAL_DATA to delete trial Supabase rows. GitHub repos are not deleted by this endpoint.' }, { status: 400 });
    }

    const deleted = [];
    for (const table of TABLES) deleted.push(await deleteRows(supabase, table));

    await supabase.from('system_cleanup_batches').update({
      status: 'completed',
      summary: { ...summary, deleted },
      completed_at: new Date().toISOString()
    }).eq('id', batch?.id);

    const log = await insertSessionLog({
      actions_completed: ['system_cleanup', VERSION, 'execute'],
      decisions_made: [{ deleted }],
      pending_tasks: includeGithub ? ['Manually review GitHub repos in cleanup registry for archive/delete.'] : [],
      next_recommendation: 'Re-run system-health and seed production configuration after cleanup.'
    });

    return Response.json({ ok: true, version: VERSION, mode: 'execute', batch_id: batch?.id, deleted, github_objects: githubObjects || [], sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
