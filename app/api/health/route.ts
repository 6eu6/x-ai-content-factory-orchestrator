import { supabaseAdmin } from '../../../lib/supabase';

/**
 * GET /api/health
 *
 * فحص صحة النظام — بدون حاجة لسر
 * يفحص اتصال Supabase ويظهر حالة الجداول الأساسية
 * + يختبر الأعمدة المهمة اللي الكود يحتاجها
 */
export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  const supabase = supabaseAdmin();

  // 1. Check Supabase connection
  try {
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
  const keyTables = ['accounts', 'learning_tweet_queue', 'telegram_bot_state', 'content_log', 'content_opportunities', 'viral_scan_runs', 'viral_tweet_analyses', 'viral_account_patterns', 'x_algorithm_learning_rules', 'viral_style_patterns', 'mcp_opportunity_map', 'performance_scans', 'content_deliveries', 'working_memory', 'learning_cycles', 'original_content_hypotheses', 'raw_research_items', 'session_logs', 'account_state', 'daily_checkins', 'action_queue', 'content_format_decisions', 'content_production_cards', 'trends', 'creator_intel', 'discovered_items', 'repo_source_files', 'repo_extracted_rules', 'requirement_status', 'target_plans', 'growth_learning_runs', 'system_learning_rules'];
  const tableStatus: Record<string, { exists: boolean; rows?: number }> = {};

  for (const table of keyTables) {
    try {
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

  // 3. Test critical column access — insert attempts to verify columns
  const columnTests: Record<string, { ok: boolean; detail?: string }> = {};

  // Test viral_scan_runs columns
  try {
    const { data, error } = await supabase.from('viral_scan_runs').select('id,creator_handle,scan_version,tweets_analyzed,model_used,reused_cached_result').limit(1);
    columnTests.viral_scan_runs_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with new columns` };
  } catch (e: any) {
    columnTests.viral_scan_runs_columns = { ok: false, detail: e.message };
  }

  // Test viral_tweet_analyses columns
  try {
    const { data, error } = await supabase.from('viral_tweet_analyses').select('id,scan_run_id,creator_handle,tweet_text,hook_formula,adaptation_for_30piq').limit(1);
    columnTests.viral_tweet_analyses_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with new columns` };
  } catch (e: any) {
    columnTests.viral_tweet_analyses_columns = { ok: false, detail: e.message };
  }

  // Test viral_account_patterns columns
  try {
    const { data, error } = await supabase.from('viral_account_patterns').select('id,scan_run_id,creator_handle,rule,evidence,apply_to_30piq').limit(1);
    columnTests.viral_account_patterns_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with new columns` };
  } catch (e: any) {
    columnTests.viral_account_patterns_columns = { ok: false, detail: e.message };
  }

  // Test trends columns
  try {
    const { data, error } = await supabase.from('trends').select('id,content_type_suggestion').limit(1);
    columnTests.trends_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with new columns` };
  } catch (e: any) {
    columnTests.trends_columns = { ok: false, detail: e.message };
  }

  // Test creator_intel columns
  try {
    const { data, error } = await supabase.from('creator_intel').select('id,creator_handle,post_url,hook_pattern,format_pattern,why_it_worked,adaptation_idea').limit(1);
    columnTests.creator_intel_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with new columns` };
  } catch (e: any) {
    columnTests.creator_intel_columns = { ok: false, detail: e.message };
  }

  // Test content_opportunities v3 columns
  try {
    const { data, error } = await supabase.from('content_opportunities').select('id,selected_format,format_decision_reason,depth_score,freshness_score,visual_score,technical_score,uniqueness_score,updated_at').limit(1);
    columnTests.content_opportunities_v3_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with v3 columns` };
  } catch (e: any) {
    columnTests.content_opportunities_v3_columns = { ok: false, detail: e.message };
  }

  // Test content_log v3 columns
  try {
    const { data, error } = await supabase.from('content_log').select('id,source_urls,quality_reasons,content_opportunity_id').limit(1);
    columnTests.content_log_v3_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with v3 columns` };
  } catch (e: any) {
    columnTests.content_log_v3_columns = { ok: false, detail: e.message };
  }

  // Test content_format_decisions v3 columns
  try {
    const { data, error } = await supabase.from('content_format_decisions').select('id,learning_cycle_id,content_opportunity_id,selected_format,format_reason,depth_score,freshness_score,visual_score,technical_score,uniqueness_score,source_quality_score,viral_fit_score,low_follower_risk,expected_primary_signal,expected_secondary_signal,production_requirements,decision_payload,updated_at').limit(1);
    columnTests.content_format_decisions_v3_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with v3 columns` };
  } catch (e: any) {
    columnTests.content_format_decisions_v3_columns = { ok: false, detail: e.message };
  }

  // Test content_production_cards v3 columns
  try {
    const { data, error } = await supabase.from('content_production_cards').select('id,format_decision_id,content_opportunity_id,source_urls,viral_mechanic,original_angle,audience_pain,algorithm_basis,source_basis,format_basis,quality_basis,quality_reasons,publish_status,status').limit(1);
    columnTests.content_production_cards_v3_columns = { ok: !error, detail: error?.message || `${data?.length ?? 0} rows with v3 columns` };
  } catch (e: any) {
    columnTests.content_production_cards_v3_columns = { ok: false, detail: e.message };
  }

  const allColumnsOk = Object.values(columnTests).every(t => t.ok);

  return Response.json({
    ok: checks.supabase?.ok && allTablesExist && allColumnsOk,
    version: 'v3-simplified-pipeline',
    checks,
    tables: tableStatus,
    total_tables_checked: keyTables.length,
    healthy_tables: Object.values(tableStatus).filter(t => t.exists).length,
    missing_tables: keyTables.filter(t => !tableStatus[t]?.exists),
    column_tests: columnTests,
    all_columns_ok: allColumnsOk,
    instructions: !allTablesExist
      ? 'Some tables are missing. Run the SQL in /supabase-migrations.sql in Supabase Dashboard → SQL Editor.'
      : !allColumnsOk
        ? 'Tables exist but some columns are missing. Run the ALTER TABLE statements in /supabase-migrations.sql to add missing columns.'
        : 'All tables and columns are accessible. System is healthy.'
  });
}
