import { supabaseAdmin } from '../../../lib/supabase';

/**
 * GET /api/health
 *
 * فحص صحة النظام — بدون حاجة لسر
 * يفحص اتصال Supabase ويظهر حالة الجداول الأساسية
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // 1. Check Supabase connection
  try {
    const supabase = supabaseAdmin();
    const { data, error } = await supabase.from('model_routing_rules').select('task_type').eq('active', true).limit(1);
    if (error) {
      checks.supabase = { ok: false, detail: error.message };
    } else {
      checks.supabase = { ok: true, detail: `${data?.length ?? 0} routing rules found` };
    }
  } catch (e: any) {
    checks.supabase = { ok: false, detail: e.message };
  }

  // 2. Check key tables exist and have data
  const keyTables = ['accounts', 'learning_tweet_queue', 'telegram_bot_state', 'content_log', 'content_opportunities', 'viral_scan_runs', 'viral_tweet_analyses', 'viral_account_patterns', 'x_algorithm_learning_rules', 'viral_style_patterns', 'mcp_opportunity_map'];
  const tableStatus: Record<string, { exists: boolean; rows?: number }> = {};

  for (const table of keyTables) {
    try {
      const supabase = supabaseAdmin();
      const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
      if (error) {
        tableStatus[table] = { exists: false };
      } else {
        tableStatus[table] = { exists: true, rows: count ?? 0 };
      }
    } catch {
      tableStatus[table] = { exists: false };
    }
  }

  const allTablesExist = Object.values(tableStatus).every(t => t.exists);

  return Response.json({
    ok: checks.supabase?.ok && allTablesExist,
    version: 'v2-db-migration-fix',
    checks,
    tables: tableStatus,
    total_tables_checked: keyTables.length,
    healthy_tables: Object.values(tableStatus).filter(t => t.exists).length,
    missing_tables: keyTables.filter(t => !tableStatus[t]?.exists),
    instructions: !allTablesExist
      ? 'Some tables are missing. Run the SQL in /supabase-migrations.sql in Supabase Dashboard → SQL Editor.'
      : 'All key tables are accessible.'
  });
}
