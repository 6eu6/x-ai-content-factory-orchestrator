# Lean Core — the simplified growth loop

This document describes the new, deliberately small architecture introduced to
replace the over-engineered legacy pipeline, and explains how to migrate to it
safely and what to delete later.

## Why this exists

The legacy system grew into ~80 Supabase tables, ~60 API routes, ~90 lib files,
40+ tests, and 15+ migrations — to do one job: suggest a handful of good tweets,
replies, and quotes per day for manual publishing.

The result, measured from the live database:

- Over one week, **762 raw opportunities → ~12 selected** (<2% pass rate); several
  days produced **0**.
- Top rejection reasons: `shield_not_passed` (mostly `missing_originality`),
  `intelligence_rejected:generic_only`, `low_originality_potential`, plus **54
  hard parse/JSON crashes** (`intelligence_parse_failed`, `ai_judge_failed:
  Unexpected end of JSON input`) counted as rejections.
- Five stacked AI gates with near-impossible thresholds (originality ≥ 7.8,
  evidence_safety ≥ 8) — an AI judging another AI's "originality" is noise.
- The learning loop was **theater**: 3,262 "algorithm rules" + 1,654 "viral
  patterns" scraped from *other* accounts, while `x_publication_metrics` and
  `performance_scans` had **0 rows** — nothing learned from the account's own
  results.

And the account being grown (`@30piq`) had **0 followers, 6 posts, bio "Just
curious", name "User"** — no foundation for any tool to grow.

## The lean loop

One readable pass, light enough to run in a single Vercel function (no Oracle
worker / durable queue needed):

```
load config
  -> harvest recent tweets from niche source accounts   (lib/lean/harvest.ts)
  -> pull the account's OWN best posts as few-shot (RAG) (lib/lean/memory.ts)
  -> generate replies + quotes + standalone in one call  (lib/lean/generate.ts)
  -> one simple deterministic gate + dedupe              (lib/lean/gate.ts)
  -> format + deliver to Telegram                        (lib/lean/run.ts)
  -> human publishes manually
```

### Files

| File | Responsibility |
| --- | --- |
| `lib/lean/config.ts` | Single editable config: niche, voice, daily mix, source selection |
| `lib/lean/harvest.ts` | Fetch + rank recent niche tweets (freshness-weighted) |
| `lib/lean/memory.ts` | Real RAG: retrieve the account's own winning posts; recent-dup list |
| `lib/lean/generate.ts` | One model call → full daily batch as JSON |
| `lib/lean/gate.ts` | One deterministic gate (English, ≤280, real prose, no bait) + dedupe |
| `lib/lean/run.ts` | Orchestrator + Telegram formatting |
| `app/api/lean-run/route.ts` | Entry point: `POST /api/lean-run?telegram=1` |

### Running it

```bash
# Manual / from Vercel:
curl -X POST "$PUBLIC_BASE_URL/api/lean-run?telegram=1" \
  -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET"

# Daily cron (vercel.json) hitting the same route with ?cron=1 also works.
```

Tunable via env (all optional, sensible defaults):
`LEAN_NICHE`, `LEAN_VOICE`, `LEAN_REPLIES`, `LEAN_QUOTES`, `LEAN_STANDALONE`,
`LEAN_SOURCE_LIMIT`, `LEAN_TWEETS_PER_SOURCE`.

## How the learning actually compounds

The generator is fed the account's **own** highest-scoring posts (from
`published_decisions.outcome_score` and `content_log` engagement). As you publish
and outcomes get recorded, the few-shot context improves automatically. Ten real
results from your account are worth more than 3,000 scraped rules.

To close the loop, record outcomes for what you publish (URL + later metrics)
into `published_decisions` / `content_log`. That is the only "learning"
infrastructure the lean path needs.

## Prerequisite the tool cannot fix for you

Before expecting growth, fix the account foundation: real display name, a niche
bio, avatar + banner, and a single narrow niche. A 0-follower "User / Just
curious" account will not grow regardless of suggestion quality.

## Migration & deprecation plan (staged, reversible)

The lean path is added **alongside** the legacy pipeline so nothing breaks while
you validate it. Once the lean loop is delivering daily and you've confirmed it
on the live account, the following can be deleted (all recoverable via git):

**Legacy lib (candidates for removal once lean is validated):**
`opportunity-intelligence.ts`, `opportunity-judge.ts`, `originality-enhancer.ts`,
`originality-context.ts`, `numeric-claim-guard.ts`, `near-pass-polish.ts`,
`candidate-selector.ts`, `quality-validator.ts`, `content-engine-v3.ts`,
`content-type-engine.ts`, `niche-alignment.ts`, `signature-voice.ts`,
`pipeline-contracts.ts`, `pipeline-queue.ts`, `pipeline-worker.ts`,
`pipeline-run-tracker.ts`, plus the `repo-*` investment/build/validation stack.

**Legacy API routes:** the `repo-*`, `*-repair*`, `viral-*`, `research-intel*`,
`learning-*`, `production-cycle`, `discovery-run`, `growth-learning-run` routes.

**Legacy Supabase tables (archive then drop):** the scraped-learning tables
(`x_algorithm_learning_rules`, `viral_style_patterns`, `viral_tweet_analyses`,
`mcp_opportunity_map`), the `repo_*` family, and the unused `content_*`
opportunity tables. Keep: `accounts`, `sources`, `published_decisions`,
`content_log`, `decision_runs`, `account_state`, `model_routing_rules`,
`telegram_bot_state`.

Do not delete anything until the lean loop has produced and you have published
from it for a few days. Delete in small PRs, not all at once.

## When (not) to add complexity back

Add a layer only when a concrete, observed need demands it — and only after the
lean loop has grown ONE account. Multi-account, multi-language, deeper RAG
memory, and a SaaS wrapper are all reasonable *later*; building them now repeats
the exact mistake that produced the 80-table maze.
