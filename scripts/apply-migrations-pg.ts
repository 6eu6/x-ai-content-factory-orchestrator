import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(process.cwd(), '.env.worker') });
config({ path: resolve(process.cwd(), '.env.local') });
config({ path: resolve(process.cwd(), '.env') });

import pg from 'pg';
import { readFileSync } from 'fs';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// Extract project ref from URL
// https://qmoictvgwavhirnexscz.supabase.co -> qmoictvgwavhirnexscz
const projectRef = SUPABASE_URL.replace('https://', '').replace('.supabase.co', '');

// We need the DB password - check for DATABASE_URL env var
const DATABASE_URL = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || '';

if (!DATABASE_URL) {
  console.log('No DATABASE_URL found. Cannot apply migrations via pg.');
  console.log('Project ref:', projectRef);
  console.log('');
  console.log('To apply migrations, use one of:');
  console.log('1. Supabase Dashboard > SQL Editor (paste the SQL)');
  console.log('2. Set DATABASE_URL env var with the connection string');
  console.log('3. Run this script on the Oracle VPS where .env.worker has the credentials');
  process.exit(0);
}

async function main() {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  
  console.log('Connected to database');

  // Apply migration 1
  const sql1 = readFileSync(resolve(process.cwd(), 'supabase-migrations/2026-05-29_pipeline_cost_ledger.sql'), 'utf8');
  console.log('Applying migration 1: pipeline_cost_ledger...');
  await client.query(sql1);
  console.log('Migration 1 applied successfully');

  // Apply migration 2
  const sql2 = readFileSync(resolve(process.cwd(), 'supabase-migrations/2026-05-29_rejection_ledger.sql'), 'utf8');
  console.log('Applying migration 2: rejection_ledger...');
  await client.query(sql2);
  console.log('Migration 2 applied successfully');

  await client.end();
  console.log('Done!');
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
