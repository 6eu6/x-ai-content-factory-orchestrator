import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';

/**
 * GET /api/db-setup
 *
 * يفحص الجداول المطلوبة ويعطي حالة كل واحد
 * ويرجع SQL اللي لازم ينشّذ في Supabase Dashboard
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();

    const requiredTables = [
      'model_routing_rules',
      'performance_scans',
      'content_deliveries',
      'working_memory'
    ];

    const existingTables = [
      'x_algorithm_learning_rules',
      'viral_style_patterns',
      'mcp_opportunity_map',
      'growth_learning_runs',
      'repo_source_files',
      'repo_extracted_rules',
      'discovered_items',
      'accounts',
      'content_log',
      'system_learning_rules',
      'account_state',
      'content_opportunities'
    ];

    const tableStatus: Record<string, { exists: boolean; rows?: number; error?: string }> = {};

    // افحص الجداول المطلوبة — حاول select صف واحد بدل count
    for (const table of requiredTables) {
      try {
        const { data, error } = await supabase
          .from(table)
          .select('id')
          .limit(1);

        if (error) {
          // لو الخطأ يقول الجدول غير موجود
          const msg = String(error.message || error.code || '').toLowerCase();
          if (msg.includes('could not find') || msg.includes('does not exist') || msg.includes('pgrst205')) {
            tableStatus[table] = { exists: false, error: error.message };
          } else {
            // خطأ ثاني — الجدول ممكن موجود بس فيه مشكلة
            tableStatus[table] = { exists: true, error: error.message, rows: 0 };
          }
        } else {
          tableStatus[table] = { exists: true, rows: data?.length || 0 };
        }
      } catch (e: any) {
        tableStatus[table] = { exists: false, error: e.message };
      }
    }

    // افحص الجداول الموجودة
    for (const table of existingTables) {
      try {
        const { data, error } = await supabase
          .from(table)
          .select('id')
          .limit(1);

        if (!error) {
          tableStatus[table] = { exists: true, rows: data?.length || 0 };
        }
      } catch {}
    }

    const missingTables = requiredTables.filter(t => !tableStatus[t]?.exists);
    const needsMigration = missingTables.length > 0;

    return Response.json({
      ok: true,
      needs_migration: needsMigration,
      missing_tables: missingTables,
      table_status: tableStatus,
      migration_sql_path: '/supabase-migrations.sql',
      instructions: needsMigration
        ? `Run the SQL in /supabase-migrations.sql in your Supabase Dashboard → SQL Editor → New Query. Missing tables: ${missingTables.join(', ')}`
        : 'All required tables exist. No migration needed.'
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
