-- ============================================================================
-- X Growth Brain — canonical Supabase schema (lean)
-- Run this on a fresh project to bootstrap. Idempotent (IF NOT EXISTS).
-- ============================================================================

create extension if not exists vector;
create extension if not exists pg_trgm;

-- ── Profiles: one row per account being grown (multi-account / multi-language) ──
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  account_handle text unique not null,
  niche text not null,
  tweet_language text not null default 'en',
  bot_language text not null default 'ar',
  voice text,
  mix jsonb not null default '{"replies":6,"quotes":3,"standalone":4}'::jsonb,
  source_handles text[] not null default '{}',
  active boolean not null default true,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists profiles_single_default on profiles(is_default) where is_default = true;

-- ── Brain: real RAG memory (retrieval + learning + pruning) ──
create table if not exists brain_memory (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                 -- algorithm | voice | outcome | insight | source_pattern | anti_pattern
  content text not null,
  embedding vector(1536),
  weight real not null default 5,
  niche text,
  language text not null default 'en',
  source text,
  support_count int not null default 0,
  contradiction_count int not null default 0,
  use_count int not null default 0,
  last_used_at timestamptz,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  content_hash text generated always as (md5(lower(content))) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists brain_memory_dedupe on brain_memory(content_hash);
create index if not exists brain_memory_kind_idx on brain_memory(kind) where status='active';
create index if not exists brain_memory_niche_idx on brain_memory(niche) where status='active';
create index if not exists brain_memory_trgm_idx on brain_memory using gin (content gin_trgm_ops);
create index if not exists brain_memory_hnsw_idx on brain_memory using hnsw (embedding vector_cosine_ops);

create or replace function match_brain_memory(
  query_embedding vector(1536),
  match_count int default 8,
  filter_kind text default null,
  filter_niche text default null,
  min_weight real default 0
)
returns table (id uuid, kind text, content text, weight real, similarity float)
language sql stable as $$
  select m.id, m.kind, m.content, m.weight, 1 - (m.embedding <=> query_embedding) as similarity
  from brain_memory m
  where m.status='active' and m.embedding is not null and m.weight >= min_weight
    and (filter_kind is null or m.kind = filter_kind)
    and (filter_niche is null or m.niche is null or m.niche = filter_niche)
  order by m.embedding <=> query_embedding
  limit match_count;
$$;

-- ── Source accounts to harvest/learn from ──
create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  handle text unique not null,
  tier int default 2,
  category text,
  followers bigint,
  active boolean default true,
  notes text,
  last_checked timestamptz,
  created_at timestamptz default now()
);

-- ── Published posts + measured outcomes (closes the learning loop) ──
create table if not exists published_decisions (
  id uuid primary key default gen_random_uuid(),
  account_handle text not null,
  published_url text,
  published_text text,
  source_tweet_url text,
  content_type text,
  status text default 'published',
  outcome_label text,
  outcome_score numeric,
  performance_checked_at timestamptz,
  performance_payload jsonb,
  feedback_applied_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ── Optional: historical content log (read as a winners source for RAG) ──
create table if not exists content_log (
  id bigserial primary key,
  content_type text,
  final_text text,
  tweet_url text,
  views int default 0,
  likes int default 0,
  performance_score double precision,
  published_at timestamptz default now()
);

-- ── Telegram control-panel state ──
create table if not exists telegram_bot_state (
  chat_id text primary key,
  user_id text,
  username text,
  last_message text,
  current_flow text,
  flow_payload jsonb default '{}'::jsonb,
  updated_at timestamptz default now()
);

-- ── Per-task model routing (overrides code defaults; optional) ──
create table if not exists model_routing_rules (
  id uuid primary key default gen_random_uuid(),
  task_type text not null,
  model_id text not null,
  temperature real,
  max_tokens int,
  top_p real,
  response_format text,
  provider text,
  description text,
  active boolean default true,
  created_at timestamptz default now()
);

-- Seed a default profile if none exists.
insert into profiles (account_handle, niche, tweet_language, bot_language, is_default, active)
values ('30piq', 'AI tools, AI workflows, and building with AI', 'en', 'ar', true, true)
on conflict (account_handle) do nothing;
