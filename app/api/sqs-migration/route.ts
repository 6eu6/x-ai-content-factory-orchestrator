import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { Pool } from 'pg';

const MIGRATION_SQL = `CREATE TABLE IF NOT EXISTS source_quality_scores (
  source_handle TEXT PRIMARY KEY,
  scans_count INT DEFAULT 0,
  tweets_analyzed INT DEFAULT 0,
  raw_opportunities_count INT DEFAULT 0,
  selected_count INT DEFAULT 0,
  rescued_count INT DEFAULT 0,
  judge_passed_count INT DEFAULT 0,
  publish_gate_accepted_count INT DEFAULT 0,
  rejection_reason_counts JSONB DEFAULT '{}',
  avg_publishability_score NUMERIC DEFAULT 0,
  avg_originality_potential_score NUMERIC DEFAULT 0,
  avg_niche_fit_score NUMERIC DEFAULT 0,
  avg_usefulness_score NUMERIC DEFAULT 0,
  opportunity_yield_rate NUMERIC DEFAULT 0,
  selected_rate NUMERIC DEFAULT 0,
  rejection_rate NUMERIC DEFAULT 0,
  source_quality_score NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);`;

const VERIFY_SQL = "SELECT to_regclass('public.source_quality_scores') as result;";
const COUNT_SQL = "SELECT count(*)::int FROM public.source_quality_scores;";
const COLUMNS_SQL = `
  SELECT column_name, data_type, column_default, is_nullable
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'source_quality_scores'
  ORDER BY ordinal_position;`;
const INDEXES_SQL = `
  SELECT indexname, indexdef FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'source_quality_scores';`;
const RLS_SQL = `
  SELECT relrowsecurity, relforcerowsecurity FROM pg_class
  WHERE relname = 'source_quality_scores';`;
const POLICIES_SQL = `
  SELECT policyname, cmd, permissive, roles FROM pg_policies
  WHERE schemaname = 'public' AND tablename = 'source_quality_scores';`;
const CONSTRAINTS_SQL = `
  SELECT conname, contype, pg_get_constraintdef(oid) as condef
  FROM pg_constraint WHERE conrelid = 'public.source_quality_scores'::regclass;`;

function getProjectRef(): string {
  const url = process.env.SUPABASE_URL || '';
  return url.replace('https://', '').replace('.supabase.co', '');
}

async function tryConnect(dbUrl: string): Promise<{ ok: boolean; pool: Pool; error?: string }> {
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
  try {
    const client = await pool.connect();
    client.release();
    return { ok: true, pool };
  } catch (e: any) {
    try { await pool.end(); } catch {}
    return { ok: false, pool: pool, error: e.message };
  }
}

/**
 * GET /api/sqs-migration — Check if source_quality_scores table exists
 */
export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();

    const { data, error } = await supabase
      .from('source_quality_scores')
      .select('source_handle')
      .limit(1);

    if (!error) {
      return Response.json({
        ok: true,
        table_exists: true,
        message: 'source_quality_scores table already exists',
        can_select: true,
      });
    }

    const msg = (error.message || '').toLowerCase();
    if (msg.includes('could not find') || msg.includes('does not exist') || msg.includes('pgrst205')) {
      const ref = getProjectRef();
      const hasDbUrl = !!(process.env.DATABASE_URL || process.env.SUPABASE_DB_URL);

      return Response.json({
        ok: true,
        table_exists: false,
        message: 'source_quality_scores table is MISSING — needs creation',
        connection_methods: {
          DATABASE_URL: hasDbUrl ? 'SET' : 'NOT SET',
        },
        migration_sql: MIGRATION_SQL,
        instructions: 'Apply the migration SQL in the Supabase Dashboard > SQL Editor, or POST to this endpoint with a database_url.',
      });
    }

    return Response.json({ ok: false, error: error.message });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

/**
 * POST /api/sqs-migration — Create source_quality_scores table
 * Tries all available connection methods.
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);

    // First, check if table already exists via REST API
    const supabase = supabaseAdmin();
    const { error: checkErr } = await supabase
      .from('source_quality_scores')
      .select('source_handle')
      .limit(1);

    if (!checkErr) {
      return Response.json({ ok: true, message: 'Table already exists, no action needed.' });
    }

    const ref = getProjectRef();
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const results: Record<string, any> = {};

    // Try all possible connection strings
    const connectionAttempts: { name: string; url: string }[] = [];

    // Method 1: Custom database_url from request body (highest priority)
    try {
      const body = await req.json();
      if (body?.database_url) {
        connectionAttempts.unshift({ name: 'custom-database_url', url: body.database_url });
      }
    } catch {}

    // Method 2: DATABASE_URL environment variable
    const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (dbUrl) {
      connectionAttempts.push({ name: 'DATABASE_URL', url: dbUrl });
    }

    // Method 3: Pooler connections with service_role key as password
    const regions = ['eu-west-2', 'us-east-1'];
    const ports = [6543, 5432];
    for (const region of regions) {
      for (const port of ports) {
        connectionAttempts.push({
          name: `pooler-${region}-${port}`,
          url: `postgres://postgres.${ref}:${serviceKey}@aws-0-${region}.pooler.supabase.com:${port}/postgres`,
        });
      }
    }

    // Method 4: Direct database connection
    connectionAttempts.push({
      name: 'direct-db',
      url: `postgres://postgres:${serviceKey}@db.${ref}.supabase.co:5432/postgres`,
    });

    for (const attempt of connectionAttempts) {
      const { ok, pool, error } = await tryConnect(attempt.url);
      if (!ok) {
        results[attempt.name] = { connected: false, error };
        continue;
      }

      try {
        // Pre-check
        const preCheck = await pool.query(VERIFY_SQL);
        if (preCheck.rows[0]?.result) {
          results[attempt.name] = { connected: true, table_already_exists: true };
          await pool.end();
          continue;
        }

        // Apply migration
        await pool.query(MIGRATION_SQL);

        // Verify
        const verify = await pool.query(VERIFY_SQL);
        const count = await pool.query(COUNT_SQL);
        const columns = await pool.query(COLUMNS_SQL);
        const indexes = await pool.query(INDEXES_SQL);
        const rls = await pool.query(RLS_SQL);
        const policies = await pool.query(POLICIES_SQL);
        const constraints = await pool.query(CONSTRAINTS_SQL);

        await pool.end();

        return Response.json({
          ok: true,
          message: 'Migration applied successfully via ' + attempt.name,
          verification: {
            table_exists: verify.rows[0]?.result,
            row_count: count.rows[0]?.count,
            columns: columns.rows,
            indexes: indexes.rows,
            rls: rls.rows,
            policies: policies.rows,
            constraints: constraints.rows,
          },
          all_attempts: results,
        });
      } catch (e: any) {
        results[attempt.name] = { connected: true, migration_failed: true, error: e.message };
        try { await pool.end(); } catch {}
      }
    }

    return Response.json({
      ok: false,
      message: 'All connection methods failed. The migration SQL must be applied manually via the Supabase Dashboard SQL Editor.',
      migration_sql: MIGRATION_SQL,
      verification_queries: {
        check_table: VERIFY_SQL,
        count_rows: COUNT_SQL,
      },
      attempts: results,
      instructions: [
        '1. Go to https://supabase.com/dashboard/project/' + ref + '/sql',
        '2. Click "New Query"',
        '3. Paste the migration SQL',
        '4. Click "Run"',
        '5. Then run: SELECT to_regclass(\'public.source_quality_scores\');',
        '6. Expected result: source_quality_scores (confirms table exists)',
      ],
    }, { status: 200 });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
