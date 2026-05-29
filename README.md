# X AI Content Factory Orchestrator

English-only X content recommendation system for the 30-day `@30piq` growth experiment.

This repository is **not** a SaaS product, **not** an Arabic account project, **not** an auto-posting bot, and currently **does not** use Apify or local models.

Telegram is only an Arabic control panel. Final publishable X content must be English only. Publishing is always manual.

## Current confirmed operating state

Phase 1 is complete:

- Oracle Cloud worker is running on Ubuntu ARM64.
- The worker runs `npm run worker:pipeline` under PM2 as `pipeline-worker`.
- Supabase queue processing works through `pipeline_runs` and `pipeline_tasks`.
- Telegram receives Arabic decision-run reports.
- The latest confirmed full run completed all pipeline tasks for `@30piq`.
- The publish gate correctly blocked weak recommendations instead of lowering quality.

Do **not** restart the full pipeline just to validate documentation changes.

## Current production architecture

```text
Telegram Arabic UI
  -> Vercel webhook / enqueue / status routes
  -> Supabase pipeline_runs + pipeline_tasks queue
  -> Oracle Cloud persistent worker
  -> TwitterAPI.io read-only X data
  -> OpenRouter model calls
  -> English publish gate
  -> decision engine
  -> decision_runs + Telegram report
  -> manual publishing only
```

## Runtime responsibility split

| Layer | Responsibility |
| --- | --- |
| Vercel | Telegram webhook, lightweight APIs, enqueue, cancel, status, health checks |
| Supabase | Durable queue, memory, run state, task state, results, decision logs |
| Oracle Cloud worker | Heavy pipeline task execution outside Vercel request lifecycle |
| TwitterAPI.io | Read-only X/Twitter data fetching |
| OpenRouter | Model gateway for AI calls |
| Telegram | Arabic control panel and report delivery only |
| Human operator | Final manual publishing decision |

## Hard product rules

1. Final X content must be English only.
2. Telegram UI can be Arabic.
3. Publishing is manual only.
4. No auto-posting to X/Twitter.
5. No Arabic inside `crafted_text`.
6. No JSON wrappers or raw invalid model output in Telegram recommendations.
7. No invalid source URLs such as `x.com/📋/status/...`.
8. Do not lower quality thresholds as an architectural fix.
9. Do not reduce account count to hide runtime problems.
10. Do not reduce `tweetsPerAccount` to hide runtime problems.
11. Do not use `lightMode` as the permanent architecture.
12. Final decision must happen globally after scan results are merged, not per account.
13. Do not add Apify in the current phase.
14. Do not add local models in the current phase.
15. Do not turn this into a SaaS architecture during the current 30-day experiment.

## Pipeline terminology

Use these names consistently:

| Preferred term | Meaning |
| --- | --- |
| `pipeline_runs` | Durable run tracker in Supabase |
| `pipeline_tasks` | Durable task queue in Supabase |
| `pipeline-worker` | PM2 process name for the Oracle worker |
| Oracle worker | Persistent Ubuntu worker that processes queued tasks |
| Telegram control panel | Arabic UI for commands, status, and reports |
| English publish gate | Final language/quality/sourcing gate before decision |
| Decision Run | Telegram-facing report for one completed pipeline run |
| Cost Ledger | Phase 2 cost tracking for provider/model/API usage |
| Rejection Ledger | Phase 2 diagnostics for publish-gate rejections |

Avoid using outdated labels such as:

- `x-content-worker` for the PM2 process.
- `local models` as a current implementation target.
- `Apify` as a current data source.
- `SaaS` as the current product goal.
- `Arabic content account` for `@30piq`.
- `full pipeline in Telegram webhook` as an acceptable architecture.

## Current npm scripts

```bash
npm run build
npm run test
npm run worker:pipeline
```

`npm run worker:pipeline` starts `scripts/pipeline-worker.ts`, which loads `.env.worker`, `.env.local`, then `.env`, validates Supabase configuration, and continuously processes the queue.

## Worker deployment notes

Current confirmed Oracle deployment:

- Region: `eu-frankfurt-1`
- Shape: `VM.Standard.A1.Flex`
- OCPU: `1`
- RAM: `6GB`
- OS: Ubuntu 20.04 ARM64
- Runtime: Node.js `v22.22.2`, npm `10.9.7`, PM2 `7.0.1`
- PM2 process: `pipeline-worker`

Expected worker commands:

```bash
npm run build
pm2 start "npm run worker:pipeline" --name pipeline-worker
pm2 save
pm2 startup
pm2 save
```

## Environment variables

Server-side runtime variables include:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ORCHESTRATOR_SECRET
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENROUTER_REFERER
OPENROUTER_TITLE
X_USERNAME
TWITTERAPI_IO_KEY
TWITTERAPI_IO_BASE_URL
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_ALLOWED_CHAT_ID
PUBLIC_BASE_URL
```

Keep secrets in Vercel/Oracle environment files only. Do not commit `.env.local` or `.env.worker`.

## Current next phase

The next phase is **Phase 2A: Cost Ledger + Rejection Ledger**.

Do not start by weakening the publish gate. The latest confirmed result showed:

- `0` publish recommendations
- main rejection causes: `missing_originality` and `unsourced_numeric_claims`

That is a diagnostics problem first, not a reason to lower quality.

Phase 2A should add durable observability for:

- total estimated cost per run
- cost by provider
- cost by task type
- model/token usage where available
- publish-gate rejection reasons
- shield rejection reasons
- source URL count
- numeric-claim diagnostics
- opportunity preview/hash

## Development workflow

Before changing behavior:

1. Confirm the change preserves the current architecture.
2. Confirm Telegram buttons enqueue/status/cancel instead of running heavy work inline.
3. Confirm the Oracle worker remains the heavy task processor.
4. Confirm publish gate and decision thresholds are not lowered.
5. Run `npm run build` and `npm test` when code changes are made.

Documentation-only changes do not require restarting the worker.

## Repository

GitHub: `6eu6/x-ai-content-factory-orchestrator`
Default branch: `main`
