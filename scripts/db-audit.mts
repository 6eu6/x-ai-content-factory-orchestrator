#!/usr/bin/env npx tsx
/**
 * DB Audit Script — x-ai-content-factory-orchestrator
 * 
 * Connects to Supabase and performs a comprehensive audit:
 * 1. Lists ALL tables in the public schema with their row counts
 * 2. For each table, shows columns, types, and nullable status
 * 3. Checks for any tables that appear orphaned or unused
 * 4. Verifies critical tables exist and have data
 * 5. Cross-references code with actual DB tables
 * 
 * Usage: npx tsx scripts/db-audit.mts
 * 
 * Output: Full audit report to stdout
 */

import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { writeFileSync, readFileSync, existsSync } from 'fs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://qmoictvgwavhirnexscz.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SPEC_CACHE = '/tmp/supabase_openapi.json';

if (!SUPABASE_SERVICE_ROLE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_ROLE_KEY env var required');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ─── Classifications ──────────────────────────────────────

const CLASSIFICATIONS: Record<string, string[]> = {
  ACTIVE_RUNTIME: ['pipeline_runs','pipeline_tasks','account_state','decision_runs','daily_checkins','model_routing_rules','published_decisions'],
  ACTIVE_MEMORY: ['compact_operator_rules','source_author_memory','memory_compaction_runs','x_algorithm_learning_rules','viral_style_patterns','viral_tweet_analyses','working_memory','system_learning_rules'],
  ACTIVE_TELEGRAM: ['telegram_bot_state','content_deliveries'],
  ACTIVE_COST_LOGGING: ['pipeline_cost_ledger','rejection_ledger','session_logs'],
  ACTIVE_SOURCE_POOL: ['accounts','source_quality_scores'],
  LEGACY: ['sources','content_opportunities','original_content_hypotheses','raw_research_items','content_log','action_queue','viral_scan_runs','viral_account_patterns','content_format_decisions','content_production_cards','learning_tweet_queue','learning_cycles','behavior_limits','performance_scans'],
};

function classify(name: string): string {
  for (const [cls, tables] of Object.entries(CLASSIFICATIONS)) {
    if (tables.includes(name)) return cls;
  }
  return 'EXPERIMENTAL/UNKNOWN';
}

// ─── Code-referenced tables (from grep of .from('table_name')) ──

const CODE_TABLES = new Set([
  'pipeline_runs','pipeline_tasks','account_state','decision_runs',
  'daily_checkins','model_routing_rules','published_decisions',
  'compact_operator_rules','source_author_memory','memory_compaction_runs',
  'x_algorithm_learning_rules','viral_style_patterns','viral_tweet_analyses',
  'working_memory','system_learning_rules',
  'telegram_bot_state','content_deliveries',
  'pipeline_cost_ledger','rejection_ledger','session_logs',
  'accounts','source_quality_scores',
  'sources','content_opportunities','original_content_hypotheses',
  'raw_research_items','content_log','action_queue','viral_scan_runs',
  'viral_account_patterns','content_format_decisions','content_production_cards',
  'learning_tweet_queue','learning_cycles','behavior_limits','performance_scans',
  'source_performance','quality_failure_patterns','prompt_improvement_candidates',
  'mcp_opportunity_map','growth_learning_runs','trends','creator_intel',
  'discovered_items','repo_source_files','repo_extracted_rules',
  'requirement_status','target_plans',
  'system_cleanup_registry','system_cleanup_batches','repo_sources',
  'repo_creation_decisions','discovery_sources','discovery_runs',
  'system_reflections',
  'repo_validation_runs','repo_build_plans','repo_build_artifacts',
  'repo_artifact_requirements','repo_style_templates','verification_events',
  'owned_repo_projects','x_timeline_scan_targets','growth_experiment_backlog',
  'repo_writer_quality_rules','weekly_reviews','github_repos',
  'repo_publication_events',
]);

const CRITICAL_TABLES = [
  'source_quality_scores','pipeline_runs','rejection_ledger',
  'pipeline_cost_ledger','compact_operator_rules','source_author_memory',
];

// ─── Fetch OpenAPI spec (with caching) ────────────────────

async function getOpenAPISpec(): Promise<any> {
  if (existsSync(SPEC_CACHE)) {
    return JSON.parse(readFileSync(SPEC_CACHE, 'utf-8'));
  }
  console.log('Fetching OpenAPI spec from PostgREST...');
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/`, {
    headers: { 'apikey': SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!resp.ok) throw new Error(`OpenAPI fetch failed: ${resp.status}`);
  const spec = await resp.json();
  writeFileSync(SPEC_CACHE, JSON.stringify(spec));
  return spec;
}

// ─── Get row count via curl (fast, parallel-friendly) ─────

function getRowCountCurl(table: string): number {
  try {
    const out = execSync(
      `curl -s --max-time 10 -X HEAD -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" -H "Prefer: count=exact" "${SUPABASE_URL}/rest/v1/${table}?select=id&limit=0" -D - 2>/dev/null`,
      { encoding: 'utf-8', timeout: 15000 }
    );
    const m = out.match(/content-range:\s*\*\/(\d+)/i);
    return m ? parseInt(m[1], 10) : -2;
  } catch { return -1; }
}

// ─── Main ─────────────────────────────────────────────────

async function main() {
  const log = (s: string) => console.log(s);

  log(`\n${'═'.repeat(70)}`);
  log(`  SUPABASE DB AUDIT — x-ai-content-factory-orchestrator`);
  log(`${'═'.repeat(70)}\n`);
  log(`Timestamp: ${new Date().toISOString()}`);
  log(`Supabase URL: ${SUPABASE_URL}`);

  // Step 1: Get OpenAPI spec
  const spec = await getOpenAPISpec();
  
  // Extract table names and schemas
  const dbTables: string[] = [];
  for (const path of Object.keys(spec.paths || {})) {
    const m = path.match(/^\/([a-z][a-z0-9_]*)$/);
    if (m) dbTables.push(m[1]);
  }
  dbTables.sort();
  log(`Tables from OpenAPI: ${dbTables.length}`);

  // Extract column info
  const tableSchemas: Record<string, Array<{name: string; type: string; nullable: boolean}>> = {};
  for (const table of dbTables) {
    const defn = spec.definitions?.[table];
    if (defn?.properties) {
      const required = new Set(defn.required || []);
      tableSchemas[table] = Object.entries(defn.properties).map(([name, prop]: [string, any]) => ({
        name,
        type: prop.format ? `${prop.type}(${prop.format})` : (prop.type || 'unknown'),
        nullable: !required.has(name),
      }));
    } else {
      tableSchemas[table] = [];
    }
  }

  // Step 2: Get row counts (parallel batches via curl)
  log('\nFetching row counts (parallel)...');
  const rowCounts: Record<string, number> = {};
  
  const BATCH = 10;
  for (let i = 0; i < dbTables.length; i += BATCH) {
    const batch = dbTables.slice(i, i + BATCH);
    const promises = batch.map(async (table) => {
      const count = getRowCountCurl(table);
      return { table, count };
    });
    const results = await Promise.all(promises);
    for (const r of results) rowCounts[r.table] = r.count;
    process.stdout.write(`  ${Math.min(i + BATCH, dbTables.length)}/${dbTables.length}\r`);
  }
  log(`  ${dbTables.length}/${dbTables.length} ✓   `);

  // Build table data
  const tableData = dbTables.map(name => ({
    name,
    rowCount: rowCounts[name] ?? -1,
    columns: tableSchemas[name] || [],
    classification: classify(name),
  }));

  // ── OUTPUT 1: All tables with row counts ──
  log(`\n${'═'.repeat(70)}`);
  log(`  1. ALL TABLES WITH ROW COUNTS`);
  log(`${'═'.repeat(70)}\n`);

  log('┌────────────────────────────────────┬─────────────┬──────────────────────────┐');
  log('│ Table Name                         │ Row Count   │ Classification           │');
  log('├────────────────────────────────────┼─────────────┼──────────────────────────┤');
  for (const t of tableData) {
    const name = t.name.padEnd(34).slice(0, 34);
    const count = (t.rowCount < 0 ? 'ERROR' : String(t.rowCount)).padStart(11).slice(0, 11);
    const cls = t.classification.padEnd(24).slice(0, 24);
    log(`│ ${name} │ ${count} │ ${cls} │`);
  }
  log('└────────────────────────────────────┴─────────────┴──────────────────────────┘');
  
  const totalRows = tableData.reduce((s, t) => s + (t.rowCount >= 0 ? t.rowCount : 0), 0);
  const emptyTables = tableData.filter(t => t.rowCount === 0);
  const errorTables = tableData.filter(t => t.rowCount < 0);
  log(`\nTotal tables: ${tableData.length}`);
  log(`Total rows across all tables: ${totalRows.toLocaleString()}`);
  log(`Empty tables (0 rows): ${emptyTables.length}`);
  log(`Error tables: ${errorTables.length}`);

  // ── OUTPUT 2: Column details (non-empty + critical) ──
  log(`\n${'═'.repeat(70)}`);
  log(`  2. COLUMN DETAILS PER TABLE (non-empty + critical)`);
  log(`${'═'.repeat(70)}`);

  const importantTables = tableData.filter(t => t.rowCount > 0 || CRITICAL_TABLES.includes(t.name) || t.classification.startsWith('ACTIVE'));

  for (const t of importantTables) {
    log(`\n${'─'.repeat(50)}`);
    log(`  ${t.name} (${t.rowCount} rows) [${t.classification}]`);
    log(`${'─'.repeat(50)}`);
    if (t.columns.length === 0) {
      log('  (no column info from OpenAPI)');
      continue;
    }
    log('  ┌──────────────────────────────┬────────────────────────┬──────────┐');
    log('  │ Column                       │ Type                   │ Nullable │');
    log('  ├──────────────────────────────┼────────────────────────┼──────────┤');
    for (const col of t.columns) {
      const name = col.name.padEnd(28).slice(0, 28);
      const type = col.type.padEnd(22).slice(0, 22);
      const nullable = (col.nullable ? 'YES' : 'NO').padEnd(8);
      log(`  │ ${name} │ ${type} │ ${nullable} │`);
    }
    log('  └──────────────────────────────┴────────────────────────┴──────────┘');
  }

  // ── OUTPUT 3: Orphaned tables ──
  log(`\n${'═'.repeat(70)}`);
  log(`  3. ORPHANED / UNUSED TABLE ANALYSIS`);
  log(`${'═'.repeat(70)}\n`);

  const dbTableSet = new Set(dbTables);
  const dbOnlyTables = dbTables.filter(t => !CODE_TABLES.has(t));
  const codeOnlyTables = [...CODE_TABLES].filter(t => !dbTableSet.has(t));

  log('A) Tables in DB but NOT referenced in code:');
  if (dbOnlyTables.length === 0) {
    log('  (none)');
  } else {
    for (const t of dbOnlyTables) {
      const row = tableData.find(td => td.name === t);
      log(`  - ${t} (${row?.rowCount ?? '?'} rows) [${row?.classification ?? '?'}]`);
    }
  }

  log('\nB) Tables referenced in code but MISSING from DB:');
  if (codeOnlyTables.length === 0) {
    log('  (none)');
  } else {
    for (const t of codeOnlyTables) {
      log(`  ⚠️  ${t} — referenced in code but NOT found in DB`);
    }
  }

  log('\nC) Empty tables (0 rows) — potential orphans:');
  for (const t of emptyTables) {
    const inCode = CODE_TABLES.has(t.name);
    log(`  - ${t.name} [${t.classification}] ${inCode ? '(in code)' : '⚠️ NOT in code — ORPHAN'}`);
  }

  // ── OUTPUT 4: Critical tables ──
  log(`\n${'═'.repeat(70)}`);
  log(`  4. CRITICAL TABLES VERIFICATION`);
  log(`${'═'.repeat(70)}\n`);

  for (const tableName of CRITICAL_TABLES) {
    const exists = dbTableSet.has(tableName);
    const row = tableData.find(t => t.name === tableName);
    const count = row?.rowCount ?? -1;
    
    if (!exists) {
      log(`  ❌ ${tableName}: MISSING FROM DB`);
    } else if (count === 0) {
      log(`  ⚠️  ${tableName}: EXISTS BUT EMPTY (0 rows)`);
    } else if (count < 0) {
      log(`  ❓ ${tableName}: EXISTS (count unavailable)`);
    } else {
      log(`  ✅ ${tableName}: HAS DATA (${count} rows, ${row?.columns.length ?? 0} columns)`);
    }
    
    if (row && row.columns.length > 0) {
      log(`     Columns: ${row.columns.map(c => c.name).join(', ')}`);
    }
  }

  // ── OUTPUT 5: Cross-reference ──
  log(`\n${'═'.repeat(70)}`);
  log(`  5. CODE vs DB FULL CROSS-REFERENCE`);
  log(`${'═'.repeat(70)}\n`);

  const allTableNames = [...new Set([...dbTables, ...CODE_TABLES])].sort();
  
  log('┌────────────────────────────────────┬──────────┬──────────┬──────────┬──────────────────────────┐');
  log('│ Table                               │ In DB    │ In Code  │ Rows     │ Classification           │');
  log('├────────────────────────────────────┼──────────┼──────────┼──────────┼──────────────────────────┤');
  
  for (const name of allTableNames) {
    const inDb = dbTableSet.has(name);
    const inCode = CODE_TABLES.has(name);
    const row = tableData.find(t => t.name === name);
    const rowCount = row?.rowCount ?? 'N/A';
    const cls = row?.classification ?? 'N/A';
    
    const nm = name.padEnd(34).slice(0, 34);
    const db = (inDb ? 'YES' : 'NO').padEnd(8);
    const code = (inCode ? 'YES' : 'NO').padEnd(8);
    const cnt = String(rowCount).padStart(8);
    const cl = cls.padEnd(24).slice(0, 24);
    const flag = !inDb || !inCode ? ' ⚠️' : '  ';
    
    log(`│ ${nm} │ ${db} │ ${code} │ ${cnt} │ ${cl} │${flag}`);
  }
  log('└────────────────────────────────────┴──────────┴──────────┴──────────┴──────────────────────────┘');

  // ── OUTPUT 6: Classification summary ──
  log(`\n${'═'.repeat(70)}`);
  log(`  6. CLASSIFICATION SUMMARY`);
  log(`${'═'.repeat(70)}\n`);

  const classGroups: Record<string, Array<{name: string; rows: number}>> = {};
  for (const t of tableData) {
    if (!classGroups[t.classification]) classGroups[t.classification] = [];
    classGroups[t.classification].push({ name: t.name, rows: t.rowCount });
  }
  
  for (const [cls, tables] of Object.entries(classGroups).sort()) {
    const clsRows = tables.reduce((s, t) => s + (t.rows >= 0 ? t.rows : 0), 0);
    log(`${cls} (${tables.length} tables, ${clsRows.toLocaleString()} total rows):`);
    for (const t of tables.sort((a, b) => b.rows - a.rows)) {
      log(`  - ${t.name} (${t.rows} rows)`);
    }
    log('');
  }

  // ── Final verdict ──
  log(`${'═'.repeat(70)}`);
  log(`  FINAL VERDICT`);
  log(`${'═'.repeat(70)}\n`);
  
  const criticalOk = CRITICAL_TABLES.every(t => {
    const row = tableData.find(td => td.name === t);
    return row && row.rowCount > 0;
  });
  const missingCritical = CRITICAL_TABLES.filter(t => !dbTableSet.has(t));
  const emptyCritical = CRITICAL_TABLES.filter(t => {
    const row = tableData.find(td => td.name === t);
    return row && row.rowCount === 0;
  });
  
  log(`Critical tables: ${criticalOk && !missingCritical.length && !emptyCritical.length ? '✅ ALL 6 PRESENT WITH DATA' : '❌ ISSUES FOUND'}`);
  if (missingCritical.length > 0) log(`  Missing from DB: ${missingCritical.join(', ')}`);
  if (emptyCritical.length > 0) log(`  Empty (0 rows): ${emptyCritical.join(', ')}`);
  
  log(`\nTotal DB tables: ${dbTables.length}`);
  log(`Total code-referenced tables: ${CODE_TABLES.size}`);
  log(`DB-only tables (not in code): ${dbOnlyTables.length}`);
  log(`Code-only tables (not in DB): ${codeOnlyTables.length}`);
  log(`Empty tables: ${emptyTables.length}`);
  log(`Error tables: ${errorTables.length}`);
  
  if (dbOnlyTables.length > 0) {
    log(`\nDB-only tables to investigate:`);
    dbOnlyTables.forEach(t => {
      const row = tableData.find(td => td.name === t);
      log(`  - ${t} (${row?.rowCount ?? '?'} rows)`);
    });
  }
  if (codeOnlyTables.length > 0) {
    log(`\nCode-only tables (need migration or dead code):`);
    codeOnlyTables.forEach(t => log(`  - ${t}`));
  }
  
  log('\n--- END OF AUDIT ---');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
