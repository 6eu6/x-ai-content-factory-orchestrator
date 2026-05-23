import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';

/**
 * GET /api/db-setup
 *
 * يفحص كل الجداول المطلوبة ويعطي حالة كل واحد
 * + يحاول ينشئ الجداول الناقصة تلقائياً
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
      'content_opportunities',
      'session_logs',
      'daily_checkins',
      'action_queue',
      'trends',
      'creator_intel',
      'viral_scan_runs',
      'viral_tweet_analyses',
      'viral_account_patterns',
      'content_format_decisions',
      'content_production_cards',
      'original_content_hypotheses',
      'raw_research_items',
      'telegram_bot_state'
    ];

    const tableStatus: Record<string, { exists: boolean; rows?: number; error?: string }> = {};

    // افحص الجداول المطلوبة
    for (const table of requiredTables) {
      try {
        const { data, error } = await supabase
          .from(table)
          .select('id')
          .limit(1);

        if (error) {
          const msg = String(error.message || error.code || '').toLowerCase();
          if (msg.includes('could not find') || msg.includes('does not exist') || msg.includes('pgrst205')) {
            tableStatus[table] = { exists: false, error: error.message };
          } else {
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

    // سحب عدد القواعد في model_routing_rules لو موجودة
    let routingRulesCount = 0;
    if (tableStatus['model_routing_rules']?.exists) {
      try {
        const { count } = await supabase
          .from('model_routing_rules')
          .select('*', { count: 'exact', head: true })
          .eq('active', true);
        routingRulesCount = count || 0;
      } catch {}
    }

    return Response.json({
      ok: true,
      needs_migration: needsMigration,
      missing_tables: missingTables,
      table_status: tableStatus,
      routing_rules_count: routingRulesCount,
      total_tables_checked: requiredTables.length + existingTables.length,
      existing_tables_count: Object.values(tableStatus).filter(s => s.exists).length,
      migration_sql_path: '/supabase-migrations.sql',
      instructions: needsMigration
        ? `Run the SQL in /supabase-migrations.sql in your Supabase Dashboard → SQL Editor → New Query. Missing tables: ${missingTables.join(', ')}`
        : 'All required tables exist. No migration needed.'
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
