# OPERATIONS RUNBOOK — x-ai-content-factory-orchestrator

**Date:** 2026-06-01
**Audience:** Operator / DevOps
**Worker Host:** Oracle Ubuntu VPS
**API Host:** Vercel (auto-deploy on push)
**Supabase Project:** `qmoictvgwavhirnexscz`

---

## 1. Quick Reference: Deploy & Restart

### One-command deploy + restart

```bash
cd ~/x-ai-content-factory-orchestrator && git pull origin main && npm install && pm2 restart pipeline-worker && pm2 logs pipeline-worker --lines 10
```

This single command: (1) pulls the latest code from `main`, (2) installs any new dependencies, (3) restarts the PM2-managed worker, and (4) shows the last 10 log lines to confirm the worker started successfully. Vercel auto-deploys on push, so the API routes are updated automatically — no manual Vercel action needed.

### Individual commands

| Action | Command |
|--------|---------|
| Pull + install | `git pull origin main && npm install` |
| Start worker | `pm2 start "npm run worker:pipeline" --name pipeline-worker` |
| Restart worker | `pm2 restart pipeline-worker` |
| Stop worker | `pm2 stop pipeline-worker` |
| View logs | `pm2 logs pipeline-worker --lines 100` |
| View errors only | `pm2 logs pipeline-worker --err --lines 50` |
| Monitor resources | `pm2 monit` |
| Check status | `pm2 status` |
| Run tests | `npx vitest run` |
| Health check | `curl -s https://x-ai-content-factory-orchestrator.vercel.app/api/health \| jq .ok` |
| Trigger daily run | `curl -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET" https://x-ai-content-factory-orchestrator.vercel.app/api/daily-run` |

---

## 2. SQL Diagnostic Blocks

### 2.1 Latest Run Health

```sql
-- Latest pipeline run status and timing
SELECT
  id,
  source,
  account_handle,
  status,
  current_step,
  created_at,
  updated_at,
  EXTRACT(EPOCH FROM (COALESCE(completed_at, now()) - created_at))::int AS duration_seconds,
  (debug_log->0->>'message') AS first_log_entry
FROM pipeline_runs
ORDER BY created_at DESC
LIMIT 5;
```

**What to look for:**
- `status` should be `completed` for recent runs
- `duration_seconds` should be under 300 (5 min) for normal runs
- `current_step` on a `running` run older than 10 min indicates a stuck run
- `failed` status means something broke — check `debug_log` for details

### 2.2 Failed Tasks

```sql
-- Tasks that failed in the last 24 hours
SELECT
  pt.id,
  pt.run_id,
  pt.task_type,
  pt.account_handle,
  pt.attempts,
  pt.error_message,
  pt.updated_at,
  pr.status AS run_status
FROM pipeline_tasks pt
LEFT JOIN pipeline_runs pr ON pt.run_id = pr.id
WHERE pt.status = 'failed'
  AND pt.updated_at > now() - interval '24 hours'
ORDER BY pt.updated_at DESC
LIMIT 20;
```

**What to look for:**
- `scan_account` failures usually mean TwitterAPI.io rate limits or network issues
- `opportunity_judge` failures usually mean AI model API errors
- `attempts > 1` means the task was retried and failed again — may need manual intervention
- `error_message` contains the specific failure reason

### 2.3 Quality Trend (Last 14 Days)

```sql
-- Average decision scores and recommendation counts over time
SELECT
  DATE(dr.created_at) AS run_date,
  COUNT(*) AS runs,
  AVG(dr.selected_count) AS avg_selected,
  AVG(dr.raw_opportunities) AS avg_raw_opportunities,
  AVG((dr.budget->>'gate_accepted')::int) AS avg_gate_accepted,
  AVG((dr.budget->>'gate_rejected')::int) AS avg_gate_rejected
FROM decision_runs dr
WHERE dr.created_at > now() - interval '14 days'
GROUP BY DATE(dr.created_at)
ORDER BY run_date DESC;
```

**What to look for:**
- `avg_selected` should be 1–3 for healthy runs
- `avg_selected = 0` on multiple days means the pipeline is not finding quality opportunities
- Sudden drop in `avg_raw_opportunities` may indicate scanning issues
- High `avg_gate_rejected` with low `avg_selected` means the pipeline finds opportunities but they fail quality gates

### 2.4 Source Performance

```sql
-- Source quality scores by account
SELECT
  account_handle,
  AVG(quality_score) AS avg_quality,
  COUNT(*) AS scans,
  AVG(follower_count) AS avg_followers,
  AVG(tweets_analyzed) AS avg_tweets_per_scan
FROM source_quality_scores
WHERE created_at > now() - interval '7 days'
GROUP BY account_handle
ORDER BY avg_quality DESC
LIMIT 20;
```

**What to look for:**
- Low `avg_quality` (< 0.4) sources are producing consistently poor opportunities
- High `avg_quality` (> 0.7) sources are the best candidates for more frequent scanning
- Sources with `scans > 5` and `avg_quality < 0.3` should be considered for removal from the scan pool

### 2.5 Memory Health

```sql
-- Memory rule statistics
SELECT
  rule_type,
  COUNT(*) AS total_rules,
  AVG(confidence) AS avg_confidence,
  AVG(support_count) AS avg_support,
  MAX(last_seen_at) AS most_recent,
  COUNT(*) FILTER (WHERE last_seen_at < now() - interval '30 days') AS stale_rules,
  COUNT(*) FILTER (WHERE confidence < 0.4) AS low_confidence_rules
FROM compact_operator_rules
GROUP BY rule_type
ORDER BY total_rules DESC;
```

**What to look for:**
- `stale_rules` should be decayed (M1.1 proposal)
- `low_confidence_rules` should not be retrieved (M1.1 confidence floor)
- `anti_pattern` should not dominate — if it's > 80% of total rules, the positive signal extraction is missing
- `avg_confidence` below 0.5 means most rules are weakly validated

```sql
-- Source author memory coverage
SELECT
  source_author,
  common_topics,
  array_length(bad_angles, 1) AS bad_angle_count,
  confidence,
  support_count,
  last_seen_at
FROM source_author_memory
ORDER BY support_count DESC
LIMIT 15;
```

### 2.6 S1.2 / S1.3 Diagnostics

```sql
-- S1.2: Post length policy compliance
SELECT
  pr.id AS run_id,
  pr.created_at,
  pt.result->>'post_length_policy' AS post_length_policy,
  COUNT(pt2.id) FILTER (WHERE pt2.result->>'too_long_over_hard_limit' IS NOT NULL) AS over_limit_candidates
FROM pipeline_runs pr
LEFT JOIN pipeline_tasks pt ON pt.run_id = pr.id AND pt.task_type = 'load_account_state'
LEFT JOIN pipeline_tasks pt2 ON pt2.run_id = pr.id AND pt2.task_type = 'opportunity_judge'
WHERE pr.created_at > now() - interval '7 days'
GROUP BY pr.id, pr.created_at, pt.result
ORDER BY pr.created_at DESC
LIMIT 10;
```

```sql
-- S1.3: Account Growth Lens — source quality and forced angles
SELECT
  pt.account_handle,
  pt.result->>'_skipped_invalid_handle' AS skipped_invalid,
  pt.result->>'empty_reason' AS empty_reason,
  pt.result->>'tweets_analyzed' AS tweets_analyzed
FROM pipeline_tasks pt
WHERE pt.task_type = 'scan_account'
  AND pt.created_at > now() - interval '7 days'
ORDER BY pt.created_at DESC
LIMIT 20;
```

**What to look for:**
- `_skipped_invalid_handle = true` means S1.3 caught an invalid handle (good)
- `empty_reason` tells you why a scan returned nothing (rate limit, protected account, no viral tweets)
- If most accounts return `empty_reason`, the source pool needs refreshing

---

## 3. Post-Run Checklist

After every pipeline run (whether triggered via Telegram, cron, or API), check the following:

### Immediate (within 5 minutes)

- [ ] **Worker alive?** `pm2 status` — worker should be `online` or `stopping` (if between batches)
- [ ] **Run completed?** Check the latest `pipeline_runs` row — `status` should be `completed`
- [ ] **Telegram delivered?** Check Telegram chat for the decision message — should show scan stats, gate stats, and recommendations
- [ ] **No stuck tasks?** `SELECT COUNT(*) FROM pipeline_tasks WHERE status = 'stuck' AND updated_at > now() - interval '1 hour'` — should be 0

### Short-term (within 1 hour)

- [ ] **Recommendations make sense?** Read the delivered recommendations — do they match the account's niche and quality standards?
- [ ] **Decision scores reasonable?** Check that `min_final_score` matches the account stage (7.8 for stage 0, 7.0 for stage 3)
- [ ] **Source age appropriate?** Reply recommendations should have source_age_hours < 72h; quote recommendations < 7d
- [ ] **No duplicate recommendations?** Check that selected candidates don't share the same source_tweet_url

### Daily (end of day)

- [ ] **Quality trend stable?** Check the quality trend SQL for the day — avg_selected should be consistent
- [ ] **Memory compaction ran?** Check `memory_compaction_runs` for today's entry — should have `status = completed`
- [ ] **Cost within budget?** Check `pipeline_cost_ledger` for today's total cost
- [ ] **No recurring failures?** Check failed tasks SQL — same error 3+ times indicates a systemic issue

### Weekly

- [ ] **Source pool freshness** — Are the same 10 accounts being scanned every day? Consider rotating in new sources
- [ ] **Memory rule quality** — Check memory health SQL — decay stale rules, remove low-confidence rules
- [ ] **Performance feedback** — Are published posts getting performance data? Run performance scan if not

---

## 4. Common Troubleshooting Scenarios

### Scenario 1: Worker Not Processing Tasks

**Symptoms:** Tasks pile up in `queued` status, no `completed` tasks for 30+ minutes, Telegram is silent.

**Diagnosis:**
```bash
pm2 status                    # Is worker online?
pm2 logs pipeline-worker --lines 50  # Any errors?
```

```sql
SELECT status, COUNT(*) FROM pipeline_tasks
WHERE created_at > now() - interval '2 hours'
GROUP BY status;
```

**Resolution:**
1. If worker is `stopped` or `errored`: `pm2 restart pipeline-worker`
2. If worker is `online` but not processing: Check `.env.worker` for correct `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
3. If tasks are `stuck`: Run cleanup — `curl -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET" "https://x-ai-content-factory-orchestrator.vercel.app/api/pipeline-runs?cleanup=1"`
4. If worker crashes on startup: Check PM2 error logs for missing env vars or dependency errors

### Scenario 2: All Runs Return Zero Recommendations

**Symptoms:** Every run shows `selected_count = 0`, Telegram shows "لا توجد توصية" message.

**Diagnosis:**
```sql
-- Where are opportunities being lost?
SELECT
  'raw' AS stage, COUNT(*) AS count
FROM pipeline_tasks WHERE task_type = 'merge_scan_results' AND created_at > now() - interval '24 hours'
UNION ALL
SELECT 'after_intelligence', AVG((result->>'intelligence_selected_count')::int)::int
FROM pipeline_tasks WHERE task_type = 'opportunity_intelligence' AND created_at > now() - interval '24 hours'
UNION ALL
SELECT 'after_judge', AVG((result->>'judge_passed_count')::int)::int
FROM pipeline_tasks WHERE task_type = 'opportunity_judge' AND created_at > now() - interval '24 hours'
UNION ALL
SELECT 'after_gate', AVG((result->>'gate_accepted')::int)::int
FROM pipeline_tasks WHERE task_type = 'publish_gate' AND created_at > now() - interval '24 hours';
```

**Resolution:**
1. If raw opportunities are 0: Source scanning is failing — check TwitterAPI.io key and rate limits
2. If intelligence_selected is 0: Sources are producing low-quality content — refresh source pool
3. If judge_passed is 0: Crafted text is failing quality checks — check model routing and prompt quality
4. If gate_accepted is 0: Content is being caught by freshness or policy gates — check S1.1/S1.2 settings

### Scenario 3: Telegram Bot Not Responding

**Symptoms:** Commands sent to the bot get no response, no delivery messages appear.

**Diagnosis:**
```bash
# Check webhook is set
curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo" | jq .
```

**Resolution:**
1. If webhook URL is empty: Re-set the webhook — `curl -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET" "https://x-ai-content-factory-orchestrator.vercel.app/api/telegram/setup"`
2. If webhook URL is set but `last_error_date` is recent: Check Vercel function logs for the webhook route
3. If `pending_update_count > 0`: The bot is falling behind — check Vercel function health
4. If `TELEGRAM_ALLOWED_CHAT_ID` is wrong: The bot is receiving messages but rejecting them — update the env var

### Scenario 4: High API Costs

**Symptoms:** Daily costs exceed expected range, `pipeline_cost_ledger` shows high totals.

**Diagnosis:**
```sql
SELECT
  DATE(created_at) AS cost_date,
  SUM(cost_usd) AS total_cost,
  COUNT(*) AS api_calls,
  AVG(cost_usd) AS avg_cost_per_call,
  MODE() WITHIN GROUP (ORDER BY task_type) AS most_frequent_task
FROM pipeline_cost_ledger
WHERE created_at > now() - interval '7 days'
GROUP BY DATE(created_at)
ORDER BY cost_date DESC;
```

**Resolution:**
1. If `opportunity_judge` costs are high: The judge is being called too many times — check `MAX_POLISH_CANDIDATES_PER_RUN` and candidate deduplication
2. If `selected_candidate_crafting` costs are high: Multi-candidate generation (3 variants per opportunity) is expensive — consider reducing for low-stage accounts
3. If `opportunity_intelligence` costs are high: Too many opportunities reaching the intelligence phase — check prefilter settings
4. Consider switching to cheaper models for low-priority tasks via `model_routing_rules`

### Scenario 5: Stuck Pipeline Runs

**Symptoms:** `pipeline_runs` shows `running` status for hours, no progress.

**Diagnosis:**
```sql
SELECT id, source, current_step, created_at, updated_at,
  EXTRACT(EPOCH FROM (now() - updated_at))::int AS seconds_since_update
FROM pipeline_runs
WHERE status = 'running'
ORDER BY created_at DESC;
```

**Resolution:**
1. If `seconds_since_update > 600`: The run is stuck — the Vercel function likely timed out or the worker crashed
2. Mark the run as failed:
   ```sql
   UPDATE pipeline_runs
   SET status = 'failed', completed_at = now(),
       debug_log = debug_log || '{"message": "manually marked as failed after stuck detection"}'::jsonb
   WHERE id = '<stuck-run-id>';
   ```
3. Mark stuck tasks as re-queueable:
   ```sql
   UPDATE pipeline_tasks
   SET status = 'queued', locked_at = NULL, locked_by = NULL
   WHERE run_id = '<stuck-run-id>' AND status = 'running';
   ```
4. Or use the API: `curl -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET" "https://x-ai-content-factory-orchestrator.vercel.app/api/pipeline-runs?cleanup=1"`

### Scenario 6: Model API Errors (OpenRouter)

**Symptoms:** Tasks fail with "AI call failed" or "model API error", judge/craft tasks show high failure rate.

**Diagnosis:**
```sql
SELECT
  task_type,
  error_message,
  COUNT(*) AS fail_count
FROM pipeline_tasks
WHERE status = 'failed'
  AND created_at > now() - interval '24 hours'
  AND error_message ILIKE '%AI%' OR error_message ILIKE '%model%' OR error_message ILIKE '%API%'
GROUP BY task_type, error_message
ORDER BY fail_count DESC
LIMIT 10;
```

**Resolution:**
1. If error is "rate limit exceeded": OpenRouter is throttling — reduce `MAX_TASKS_PER_BATCH` or add delays between tasks
2. If error is "model not found": Check `model_routing_rules` table for correct model IDs
3. If error is "context length exceeded": The input prompt is too long — check for excessively long source text or memory sections
4. If error is "invalid API key": Check `OPENAI_API_KEY` in `.env.worker`

---

## 5. Alert Thresholds

| Metric | Warning Threshold | Critical Threshold | Action |
|--------|-------------------|--------------------|--------|
| Pipeline run duration | > 5 minutes | > 10 minutes | Check for stuck tasks, restart worker |
| Failed task rate | > 10% of tasks in 24h | > 25% of tasks in 24h | Check API health, model routing |
| Zero recommendations | 3 consecutive runs | 5 consecutive runs | Check source pool, judge thresholds |
| Stuck tasks | > 5 stuck tasks | > 10 stuck tasks | Run cleanup, check worker health |
| Memory rules total | > 500 rules | > 1000 rules | Run compaction cleanup, add decay |
| Low-confidence rules | > 30% below 0.4 | > 50% below 0.4 | Purge low-confidence rules |
| Daily API cost | > $2/day | > $5/day | Check model routing, reduce scan volume |
| Worker memory usage | > 512 MB | > 1 GB | Restart worker, add memory limit |
| Telegram delivery failure | 1 failed delivery | 3 consecutive failures | Check bot token, webhook setup |
| Stale source accounts | > 50% with quality < 0.3 | > 70% with quality < 0.3 | Refresh source pool |
| Unlinked published decisions | > 5 in 72h | > 10 in 72h | Check "نشرت" command flow |

---

## 6. Emergency Procedures

### Nuclear Option: Reset Everything

If the system is in a completely broken state and needs a clean restart:

```bash
# 1. Stop the worker
pm2 stop pipeline-worker

# 2. Reset stuck tasks
psql "$DATABASE_URL" -c "
  UPDATE pipeline_tasks SET status = 'queued', locked_at = NULL, locked_by = NULL
  WHERE status IN ('running', 'stuck');
  UPDATE pipeline_runs SET status = 'failed', completed_at = now()
  WHERE status = 'running';
"

# 3. Pull latest code
cd ~/x-ai-content-factory-orchestrator && git pull origin main && npm install

# 4. Restart worker
pm2 restart pipeline-worker

# 5. Trigger a fresh run
curl -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET" \
  https://x-ai-content-factory-orchestrator.vercel.app/api/daily-run

# 6. Verify
pm2 logs pipeline-worker --lines 20
```

### Partial Recovery: Just Restart the Worker

```bash
pm2 restart pipeline-worker && sleep 5 && pm2 logs pipeline-worker --lines 10
```

### Database-Only: Clear Stale State

```sql
-- Mark all stuck tasks as re-queueable
UPDATE pipeline_tasks
SET status = 'queued', locked_at = NULL, locked_by = NULL, attempts = 0
WHERE status IN ('running', 'stuck')
  AND locked_at < now() - interval '10 minutes';

-- Mark stuck runs as failed
UPDATE pipeline_runs
SET status = 'failed', completed_at = now()
WHERE status = 'running'
  AND updated_at < now() - interval '15 minutes';
```

---

## 7. Key File Locations

| Component | Path | Purpose |
|-----------|------|---------|
| Worker script | `scripts/pipeline-worker.ts` | Persistent worker entry point |
| Worker library | `lib/pipeline-worker.ts` | Task processing logic |
| Daily runner | `lib/daily-runner.ts` | Pipeline orchestration + Telegram delivery |
| Telegram lib | `lib/telegram.ts` | Bot API integration |
| Decision engine | `lib/decision-engine.ts` | Scoring and budget allocation |
| Content engine | `lib/content-engine-v3.ts` | Scan, merge, discover |
| Memory compaction | `lib/structured-memory-compaction.ts` | Rule generation from failures |
| Memory retrieval | `lib/structured-memory-retrieval.ts` | Runtime memory lookup |
| Quality validator | `lib/quality-validator.ts` | Pre-gate quality checks |
| Content policy | `lib/content-policy.ts` | Publish gate filter |
| Near-pass polish | `lib/near-pass-polish.ts` | Post-judge polishing |
| Health endpoint | `app/api/health/route.ts` | System health check |
| Webhook handler | `app/api/telegram/webhook/route.ts` | Telegram command handler |
| Env config | `lib/env.ts` | Environment variable management |
| PM2 config | (none, inline) | Worker started via `pm2 start "npm run worker:pipeline"` |
