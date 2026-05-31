import { assertAuthorized } from '../../../lib/env';
import { Pool } from 'pg';

/**
 * POST /api/apply-migration
 *
 * Applies a specific migration SQL to the database.
 * Requires: x-orchestrator-secret header + database_url in body
 *
 * Body:
 * - database_url: PostgreSQL connection string (required)
 * - sql: SQL to execute (optional, defaults to source_quality_scores migration)
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();

    const databaseUrl = body.database_url as string;
    if (!databaseUrl) {
      return Response.json({
        ok: false,
        error: 'database_url is required. Get it from Supabase Dashboard > Settings > Database > Connection string.',
        hint: 'Format: postgres://postgres.[ref]:[YOUR-DB-PASSWORD]@aws-0-eu-west-2.pooler.supabase.com:6543/postgres'
      }, { status: 400 });
    }

    const sql = body.sql as string || `CREATE TABLE IF NOT EXISTS source_quality_scores (
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

    const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });

    try {
      // Pre-check
      const preCheck = await pool.query("SELECT to_regclass('public.source_quality_scores') as result;");
      if (preCheck.rows[0].result) {
        const count = await pool.query("SELECT count(*) FROM public.source_quality_scores;");
        await pool.end();
        return Response.json({
          ok: true,
          message: 'Table source_quality_scores already exists',
          pre_check: preCheck.rows[0],
          row_count: count.rows[0].count,
        });
      }

      // Apply
      await pool.query(sql);

      // Verify
      const verify = await pool.query("SELECT to_regclass('public.source_quality_scores') as result;");
      const count = await pool.query("SELECT count(*) FROM public.source_quality_scores;");
      const columns = await pool.query(`
        SELECT column_name, data_type, column_default, is_nullable
        FROM information_schema.columns
        WHERE table_schema='public' AND table_name='source_quality_scores'
        ORDER BY ordinal_position;
      `);
      const indexes = await pool.query(`
        SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname='public' AND tablename='source_quality_scores';
      `);
      const rls = await pool.query(`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname='source_quality_scores';
      `);
      const constraints = await pool.query(`
        SELECT conname, contype, pg_get_constraintdef(oid) as condef
        FROM pg_constraint WHERE conrelid='public.source_quality_scores'::regclass;
      `);

      await pool.end();

      return Response.json({
        ok: true,
        message: 'Migration applied successfully',
        verification: {
          table_exists: verify.rows[0].result,
          row_count: count.rows[0].count,
          columns: columns.rows,
          indexes: indexes.rows,
          rls: rls.rows,
          constraints: constraints.rows,
        }
      });
    } catch (dbErr: any) {
      try { await pool.end(); } catch {}
      return Response.json({ ok: false, error: dbErr.message }, { status: 500 });
    }
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 401 });
  }
}
