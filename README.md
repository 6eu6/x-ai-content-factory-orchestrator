# X Growth Brain

A lean, self-improving system that suggests X (Twitter) **replies, quotes, and
original tweets** for organic account growth. Publishing is **manual** — the tool
proposes, a human decides. Deployed on Vercel; data and memory live in Supabase.

It replaces an earlier, over-engineered pipeline (80+ tables, 5 stacked AI gates,
~0 usable output) with one readable loop grounded in a real retrieval-augmented
**brain** that learns from the account's own results.

## How it works

A persistent **Oracle worker** (`npm run worker`) drives everything — it has no
serverless time limit, rests between cycles, and runs autonomously:

```
every ~20 min (continuous opportunity radar)
  harvest fresh niche tweets
  → free deterministic prefilter (fresh + momentum + unseen)   ← keeps cost low
  → one batched model call scores the best, writes ready reply/quote + media tip
  → push an instant Telegram notification (link + suggestion + media tip)
     each card has two buttons:
       ✅ Published    → one tap closes the loop (marks used, feeds the brain)
       🔍 Deep research → on-demand web search → verified brief + clip script
  (strict daily cap per account — quality over quantity, no flooding)

once a day (heavier routine, same worker)
  crawl    distil fresh niche patterns into the brain          (outward learning)
  feedback measure yesterday's posts, learn from them          (inward learning)
  media    learn which media type wins in the niche right now
  digest   standalone tweet ideas + mix, grounded in the brain → Telegram
  prune    (weekly) forget stale / contradicted memories

human reviews in Telegram → publishes manually → logs the post → loop improves
```

The same logic is also exposed as `/api/lean-*` routes for manual/backup runs.

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

## Media policy

The system **detects** source media (text/photo/video/gif), **learns** which
format wins in the niche, and **recommends** what to attach — including, on
demand, a verified research brief + a clip script so you can record your **own**
original clip. It deliberately does **not** download or re-post other people's
media (copyright / account-suspension risk).

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
