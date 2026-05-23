import { supabaseAdmin } from '../../../lib/supabase';

/**
 * GET /api/db-setup
 *
 * يفحص كل الجداول المطلوبة ويعطي حالة كل واحد
 * + يعطي تعليمات واضحة لو في جدول ناقص
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();

    const allTables = [
      'model_routing_rules',
      'performance_scans',
      'content_deliveries',
      'working_memory',
      'learning_tweet_queue',
      'accounts',
      'learning_cycles',
      'telegram_bot_state',
      'content_opportunities',
      'original_content_hypotheses',
      'raw_research_items',
      'content_log',
      'session_logs',
      'account_state',
      'daily_checkins',
      'action_queue',
      'viral_scan_runs',
      'viral_tweet_analyses',
      'viral_account_patterns',
      'x_algorithm_learning_rules',
      'viral_style_patterns',
      'mcp_opportunity_map',
      'growth_learning_runs',
      'system_learning_rules',
      'content_format_decisions',
      'content_production_cards',
      'trends',
      'creator_intel',
      'discovered_items',
      'repo_source_files',
      'repo_extracted_rules',
      'requirement_status',
      'target_plans'
    ];

    const tableStatus: Record<string, { exists: boolean; row_count?: number; error?: string; columns_ok?: boolean }> = {};

    for (const table of allTables) {
      try {
        const { data, error } = await supabase
          .from(table)
          .select('id')
          .limit(1);

        if (error) {
          const msg = String(error.message || error.code || '').toLowerCase();
          if (msg.includes('could not find') || msg.includes('does not exist') || msg.includes('pgrst205') || msg.includes('relation')) {
            tableStatus[table] = { exists: false, error: error.message };
          } else {
            tableStatus[table] = { exists: true, error: error.message, columns_ok: false };
          }
        } else {
          let rowCount = 0;
          try {
            const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
            rowCount = count || 0;
          } catch {}
          tableStatus[table] = { exists: true, row_count: rowCount, columns_ok: true };
        }
      } catch (e: any) {
        tableStatus[table] = { exists: false, error: e.message };
      }
    }

    const missingTables = allTables.filter(t => !tableStatus[t]?.exists);
    const tablesWithErrors = allTables.filter(t => tableStatus[t]?.exists && !tableStatus[t]?.columns_ok);
    const needsMigration = missingTables.length > 0 || tablesWithErrors.length > 0;

    let routingRulesCount = 0;
    if (tableStatus['model_routing_rules']?.exists) {
      try {
        const { count } = await supabase.from('model_routing_rules').select('*', { count: 'exact', head: true }).eq('active', true);
        routingRulesCount = count || 0;
      } catch {}
    }

    let accountsCount = 0;
    if (tableStatus['accounts']?.exists) {
      try {
        const { count } = await supabase.from('accounts').select('*', { count: 'exact', head: true });
        accountsCount = count || 0;
      } catch {}
    }

    let pendingTweets = 0;
    if (tableStatus['learning_tweet_queue']?.exists) {
      try {
        const { count } = await supabase.from('learning_tweet_queue').select('*', { count: 'exact', head: true }).eq('status', 'pending');
        pendingTweets = count || 0;
      } catch {}
    }

    return Response.json({
      ok: true,
      needs_migration: needsMigration,
      missing_tables: missingTables,
      tables_with_errors: tablesWithErrors,
      table_status: tableStatus,
      routing_rules_count: routingRulesCount,
      accounts_count: accountsCount,
      pending_learning_tweets: pendingTweets,
      total_tables_checked: allTables.length,
      existing_tables_count: Object.values(tableStatus).filter(s => s.exists).length,
      healthy_tables_count: Object.values(tableStatus).filter(s => s.exists && s.columns_ok).length,
      migration_sql_path: '/supabase-migrations.sql',
      instructions: needsMigration
        ? `Run the SQL in /supabase-migrations.sql in your Supabase Dashboard → SQL Editor → New Query. Missing tables: ${missingTables.join(', ')}. Tables with errors: ${tablesWithErrors.join(', ')}`
        : 'All tables exist and are accessible. No migration needed.'
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

function assertAuthorized(req: Request): void {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) throw new Error('Missing ORCHESTRATOR_SECRET');
  const url = new URL(req.url);
  const token = req.headers.get('x-orchestrator-secret') || url.searchParams.get('secret') || '';
  const isCron = url.searchParams.get('cron') === '1';
  const vercelCronHeader = req.headers.get('x-vercel-cron');
  if (token === secret) return;
  if (isCron && vercelCronHeader) return;
  throw new Error('Unauthorized');
}
