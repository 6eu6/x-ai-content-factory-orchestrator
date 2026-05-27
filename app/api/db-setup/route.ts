import { supabaseAdmin } from '../../../lib/supabase';
import { Pool } from 'pg';

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

/**
 * POST /api/db-setup
 *
 * يشغّل alignment migration مباشرة على Supabase
 * Body: { action: 'run_alignment' }
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();
    if (body?.action !== 'run_alignment') {
      return Response.json({ ok: false, error: 'Unknown action. Use action: "run_alignment"' }, { status: 400 });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    if (!supabaseUrl) {
      return Response.json({ ok: false, error: 'SUPABASE_URL not set' }, { status: 500 });
    }

    // Build PostgreSQL connection string from Supabase URL + service role key
    const ref = supabaseUrl.replace('https://', '').replace('.supabase.co', '');
    const dbUrl = `postgres://postgres.${ref}:${process.env.SUPABASE_SERVICE_ROLE_KEY}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;

    const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    const results: string[] = [];

    try {
      // 1. Add provider column to model_routing_rules
      await pool.query(`ALTER TABLE model_routing_rules ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'cloud'`);
      results.push('model_routing_rules.provider column added');

      // 2. Add columns to accounts
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS category TEXT`);
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS followers INTEGER`);
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS avg_engagement NUMERIC`);
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS our_reply_count INTEGER DEFAULT 0`);
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_reply_date TIMESTAMPTZ`);
      await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_checked TIMESTAMPTZ`);
      results.push('accounts alignment columns added');

      // 3. Create decision_runs table
      await pool.query(`CREATE TABLE IF NOT EXISTS decision_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_handle TEXT NOT NULL,
        account_stage TEXT NOT NULL,
        raw_opportunities INTEGER DEFAULT 0,
        selected_count INTEGER DEFAULT 0,
        held_count INTEGER DEFAULT 0,
        budget JSONB DEFAULT '{}',
        selected_payload JSONB DEFAULT '[]',
        held_summary JSONB DEFAULT '[]',
        run_source TEXT DEFAULT 'daily_run',
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
      await pool.query(`ALTER TABLE decision_runs ENABLE ROW LEVEL SECURITY`);
      try {
        await pool.query(`CREATE POLICY "Service role full access" ON decision_runs FOR ALL USING (true) WITH CHECK (true)`);
      } catch {}
      results.push('decision_runs table created');

      // 4. Create behavior_limits table
      await pool.query(`CREATE TABLE IF NOT EXISTS behavior_limits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_handle TEXT NOT NULL,
        stage TEXT NOT NULL,
        max_original_posts_per_day INTEGER DEFAULT 2,
        max_replies_per_day INTEGER DEFAULT 8,
        max_quotes_per_day INTEGER DEFAULT 2,
        min_minutes_between_actions INTEGER DEFAULT 35,
        max_same_author_interactions_per_day INTEGER DEFAULT 2,
        links_allowed BOOLEAN DEFAULT false,
        hashtags_allowed BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now(),
        UNIQUE(account_handle, stage)
      )`);
      await pool.query(`ALTER TABLE behavior_limits ENABLE ROW LEVEL SECURITY`);
      try {
        await pool.query(`CREATE POLICY "Service role full access" ON behavior_limits FOR ALL USING (true) WITH CHECK (true)`);
      } catch {}
      results.push('behavior_limits table created');

    } finally {
      await pool.end();
    }

    return Response.json({ ok: true, action: 'run_alignment', results });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
