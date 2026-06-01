# X Growth Brain

A lean, self-improving system that suggests X (Twitter) **replies, quotes, and
original tweets** for organic account growth. Publishing is **manual** — the tool
proposes, a human decides. Deployed on Vercel; data and memory live in Supabase.

It replaces an earlier, over-engineered pipeline (80+ tables, 5 stacked AI gates,
~0 usable output) with one readable loop grounded in a real retrieval-augmented
**brain** that learns from the account's own results.

## How it works

```
daily cycle (one cron call → /api/lean-cycle)
  1. crawl    distil fresh niche patterns into the brain   (outward learning)
  2. feedback measure yesterday's posts, learn from them   (inward learning)
  3. suggest  generate today's batch, grounded in the brain → Telegram
  4. prune    (weekly) forget stale / contradicted memories
human reviews in Telegram → publishes manually → logs the post → loop improves
```

### The brain (real RAG, not storage)

- `brain_memory` (pgvector + pg_trgm): every memory has an embedding, a kind
  (`algorithm` / `voice` / `outcome` / `source_pattern` / `anti_pattern`), a
  weight, and reinforcement/contradiction counters.
- **Retrieval**: generation recalls the most relevant algorithm mechanics, live
  niche patterns, the account's proven winners, and patterns to avoid — so output
  follows the brain instead of being generic.
- **Learning in**: measured outcomes become weighted memories (good → `outcome`,
  weak → `anti_pattern`).
- **Learning out**: continuous crawl distils transferable patterns.
- **Forgetting**: weekly pruning decays unused memories and archives the
  contradicted ones, keeping the proven core sharp.

## Project layout

```
app/api/
  lean-cycle/    daily: crawl → feedback → suggest → (weekly) prune   [cron]
  lean-run/      generate + deliver suggestions on demand
  lean-crawl/    outward learning only
  lean-feedback/ inward learning only
  brain/         stats / backfill embeddings / prune / recall
  telegram/      webhook (bilingual control panel), setup, diagnose
  health/
lib/
  lean/   config, profile, harvest, memory, generate, gate, run, feedback, crawl
  brain/  embed, store, retrieve, prune
  (infra) env, supabase, retry, telegram, x, model-router, cost-ledger, ...
supabase/schema.sql   canonical schema (run on a fresh project)
docs/LEAN_ARCHITECTURE.md
```

## Setup

1. Create a Supabase project and run `supabase/schema.sql`.
2. Set environment variables (see `.env.example`).
3. Deploy to Vercel. The daily cron in `vercel.json` hits `/api/lean-cycle`.
4. Point the Telegram webhook at `/api/telegram/webhook` (via `/api/telegram/setup`).
5. Seed brain embeddings once: `POST /api/brain?action=backfill&limit=600`.

## Telegram control panel

Bilingual (Arabic/English, per profile). Buttons + commands:

- **Suggest** — generate today's batch now
- `niche <text>` — change the niche
- `lang en|ar` — language of published tweets
- `bot en|ar` — language of the control panel
- **Add account** / **Accounts** — manage source handles
- `published 1 <url>` — log a post you published (so the brain can learn from it)
- **Brain** / **Settings** — status

## Multi-account / multi-language / SaaS

Each account is a row in `profiles` (handle, niche, languages, voice, mix). The
same engine runs any profile, so adding an account or a language needs data, not
code. Prove growth on one account first, then generalize. See
`docs/LEAN_ARCHITECTURE.md`.

## What the tool does not do

- It does not auto-publish. Publishing is always a human decision.
- It does not guarantee growth. Growth = a strong brain + a real account
  foundation (name, bio, avatar, one narrow niche) + consistent human replies.
  The tool is the first of those three.

## Development

```bash
npm install
npm test          # vitest
npm run build     # next build
```
