# Operating Contract — 30-Day @30piq Experiment

This document is the source of truth for current repository terminology and operating scope.

## Scope

Current goal:

- Run a 30-day growth/content recommendation experiment for `@30piq` only.
- Generate English-only X/Twitter content recommendations.
- Deliver recommendations and run reports to Telegram.
- Keep final publishing manual.

Out of scope for the current phase:

- SaaS productization.
- Multi-tenant accounts.
- Arabic X content.
- Auto-posting.
- Apify.
- Local models.
- Replacing Oracle worker with Vercel execution.

## Architecture

| Component | Current role |
| --- | --- |
| Vercel | Lightweight Telegram webhook, enqueue, status, cancel, health APIs |
| Supabase | Queue, run/task state, memory, outputs, decision logs |
| Oracle Cloud worker | Persistent heavy processor for `pipeline_tasks` |
| TwitterAPI.io | Read-only X data source |
| OpenRouter | AI model gateway |
| Telegram | Arabic control panel and report delivery |
| Human operator | Manual publishing and final judgment |

## Canonical terms

Use these terms in docs, issues, prompts, commit reports, and comments:

| Term | Meaning |
| --- | --- |
| `pipeline_runs` | Supabase table tracking each pipeline run |
| `pipeline_tasks` | Supabase queue of resumable pipeline tasks |
| `pipeline-worker` | PM2 process name for the Oracle worker |
| Oracle worker | Long-lived Ubuntu worker processing queued tasks |
| Decision Run | Completed run report sent to Telegram |
| English publish gate | Quality/language/sourcing gate before decision selection |
| Cost Ledger | Durable provider/API/model cost tracking planned for Phase 2A |
| Rejection Ledger | Durable publish-gate rejection diagnostics planned for Phase 2A |

Deprecated or misleading terms:

| Avoid | Use instead |
| --- | --- |
| `x-content-worker` | `pipeline-worker` |
| local model phase | not current scope |
| Apify crawler | not current scope |
| SaaS system | 30-day `@30piq` experiment |
| Arabic content account | English-only `@30piq` X account |
| Telegram pipeline runner | Telegram control panel / enqueue UI |
| Vercel heavy pipeline | Oracle worker pipeline |

## Current checkpoint

Phase 1 is complete:

- Oracle instance is provisioned.
- SSH access works.
- Node.js, npm, and PM2 are installed.
- Repository build succeeds.
- `.env.local` and `.env.worker` are configured on the server.
- `npm run worker:pipeline` runs successfully.
- PM2 process `pipeline-worker` is online and saved for reboot.
- Supabase queue processing works.
- Telegram receives Decision Run reports.

No full-run restart is required for documentation cleanup.

## Latest observed run outcome

The latest confirmed Decision Run completed successfully but produced no publish recommendation:

- `0` accepted publish recommendations.
- Main rejection categories:
  - `missing_originality`
  - `unsourced_numeric_claims`

Interpretation:

- This is not a worker failure.
- This is not a reason to reduce quality thresholds.
- This means Phase 2A should add cost and rejection observability before content-tuning changes.

## Phase 2A target

Implement:

1. Cost Ledger for provider/model/API cost visibility.
2. Rejection Ledger for publish-gate diagnostics.

Phase 2A must not:

- Lower `min_final_score`.
- Reduce scanned accounts.
- Reduce `tweetsPerAccount`.
- Add Apify.
- Add local models.
- Enable auto-posting.
- Move heavy work back into Vercel or Telegram.

## Review checklist

Before accepting any implementation:

- Check for direct heavy pipeline execution inside Telegram webhook.
- Check that Vercel routes enqueue/status/cancel only for long-running work.
- Check that worker processing remains queue-based.
- Check that decisions happen after merged account results.
- Check that final X content remains English-only.
- Check that recommendations remain manually published.
- Check that quality gates are not weakened.
- Check that any new terminology follows this contract.
