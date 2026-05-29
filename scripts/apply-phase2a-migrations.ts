/**
 * Apply Phase 2A migrations — pipeline_cost_ledger and rejection_ledger tables
 * 
 * Usage:
 *   npx tsx scripts/apply-phase2a-migrations.ts
 * 
 * This script should be run on the Oracle VPS where the .env.worker file
 * contains the correct SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 * 
 * Alternatively, you can apply the migrations manually via the Supabase Dashboard:
 *   1. Go to https://supabase.com/dashboard
 *   2. Select the project
 *   3. Go to SQL Editor
 *   4. Paste the contents of:
 *      - supabase-migrations/2026-05-29_pipeline_cost_ledger.sql
 *      - supabase-migrations/2026-05-29_rejection_ledger.sql
 *   5. Run each migration
 */

import { config } from 'dotenv';
import { resolve } from 'path';

// Load env vars
config({ path: resolve(process.cwd(), '.env.worker') });
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import { supabaseAdmin } from '../lib/supabase';
import { readFileSync } from 'fs';

async function main() {
  console.log('Phase 2A Migration Script');
  console.log('========================');

  // Verify Supabase connection
  const supabase = supabaseAdmin();
  const { data, error } = await supabase.from('pipeline_runs').select('id').limit(1);
  if (error) {
    console.error('ERROR: Cannot connect to Supabase:', error.message);
    console.error('Make sure SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set in .env.worker');
    process.exit(1);
  }
  console.log('Supabase connection OK');

  // Check if pipeline_cost_ledger already exists
  const costCheck = await supabase.from('pipeline_cost_ledger').select('id').limit(1);
  if (!costCheck.error) {
    console.log('pipeline_cost_ledger table already exists - skipping');
  } else {
    console.log('pipeline_cost_ledger table does NOT exist');
    console.log('Please apply the migration manually via Supabase Dashboard SQL Editor:');
    console.log('  File: supabase-migrations/2026-05-29_pipeline_cost_ledger.sql');
  }

  // Check if rejection_ledger already exists
  const rejCheck = await supabase.from('rejection_ledger').select('id').limit(1);
  if (!rejCheck.error) {
    console.log('rejection_ledger table already exists - skipping');
  } else {
    console.log('rejection_ledger table does NOT exist');
    console.log('Please apply the migration manually via Supabase Dashboard SQL Editor:');
    console.log('  File: supabase-migrations/2026-05-29_rejection_ledger.sql');
  }

  console.log('\nDone. If tables are missing, apply via Supabase Dashboard > SQL Editor.');
}

main().catch(console.error);
