# Oracle Ubuntu VPS Worker Deployment Guide

This guide covers setting up the persistent pipeline worker on an Oracle Ubuntu VPS.

## Overview

The pipeline worker (`scripts/pipeline-worker.ts`) runs as a long-lived process that continuously polls the Supabase `pipeline_tasks` queue and processes tasks. This moves heavy pipeline execution out of Vercel's request lifecycle.

## 1. Ubuntu Setup

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install required packages
sudo apt install -y curl git build-essential
```

## 2. Node.js LTS Install

```bash
# Install Node.js 20 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify
node --version  # Should be v20.x
npm --version
```

## 3. Clone Repository

```bash
# Clone the repository
cd ~
git clone https://github.com/6eu6/x-ai-content-factory-orchestrator.git
cd x-ai-content-factory-orchestrator
```

## 4. Install Dependencies

```bash
npm install
```

## 5. Configure Environment

Create a `.env.worker` file in the project root:

```bash
cp .env.local .env.worker  # or create from scratch
nano .env.worker
```

### Required Environment Variables

```env
# Supabase
SUPABASE_URL=https://qmoictvgwavhirnexscz.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>

# Telegram
TELEGRAM_BOT_TOKEN=<your-bot-token>
TELEGRAM_ALLOWED_CHAT_ID=<your-chat-id>
TELEGRAM_WEBHOOK_SECRET=<your-webhook-secret>

# Orchestrator
ORCHESTRATOR_SECRET=<your-secret>

# X/Twitter Provider
TWITTERAPI_IO_KEY=<your-key>
TWITTERAPI_IO_BASE_URL=https://api.twitterapi.io
X_BEARER_TOKEN=<your-bearer-token>
X_USERNAME=30piq

# AI Provider
OPENAI_API_KEY=<your-key>
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-4.1-mini
OPENROUTER_REFERER=https://x.com/30piq
OPENROUTER_TITLE=X AI Content Factory

# Pipeline Settings
DAILY_SCAN_ACCOUNT_LIMIT=10
DAILY_SCAN_TWEETS_PER_ACCOUNT=8
SEND_SELECTED_MEDIA_TO_TELEGRAM=true

# Search (used by content engine)
SEARCH_PROVIDER=auto
SERPER_API_KEY=<your-key>
SERPAPI_API_KEY=<your-key>

# Vercel (for public base URL)
PUBLIC_BASE_URL=https://x-ai-content-factory-orchestrator.vercel.app

# GitHub (if used by content engine)
GITHUB_TOKEN=<your-token>
GITHUB_OWNER=6eu6
GITHUB_DEFAULT_PRIVATE=true

# Cron settings (not used by worker but required by shared modules)
CRON_SCAN_ACCOUNT_LIMIT=2
CRON_SCAN_TWEETS_PER_ACCOUNT=3
CRON_MAX_RUNTIME_MS=45000
```

## 6. Run Supabase Migration

Before starting the worker, run the migration that creates the `pipeline_tasks` table:

1. Go to Supabase Dashboard > SQL Editor
2. Paste the contents of `supabase-migrations/2026-05-29_pipeline_tasks_queue.sql`
3. Execute the migration
4. Verify: `pipeline_tasks` table should exist with all columns

## 7. Manual Run

```bash
# Run the worker directly
npx tsx scripts/pipeline-worker.ts

# Or via npm script
npm run worker:pipeline
```

Press Ctrl+C to stop gracefully.

## 8. PM2 Run (Production)

### Install PM2

```bash
sudo npm install -g pm2
```

### Start Worker

```bash
# Start the worker with PM2
pm2 start "npm run worker:pipeline" --name pipeline-worker

# Verify it's running
pm2 status
pm2 logs pipeline-worker
```

### PM2 Startup (Auto-restart on Reboot)

```bash
# Generate startup script
pm2 startup
# Run the command PM2 outputs (requires sudo)

# Save current PM2 process list
pm2 save
```

### PM2 Commands

```bash
# View logs
pm2 logs pipeline-worker

# View recent logs (last 100 lines)
pm2 logs pipeline-worker --lines 100

# Restart worker
pm2 restart pipeline-worker

# Stop worker
pm2 stop pipeline-worker

# Delete worker from PM2
pm2 delete pipeline-worker

# Monitor
pm2 monit
```

## 9. Update Code and Restart

```bash
cd ~/x-ai-content-factory-orchestrator

# Pull latest changes
git pull origin main

# Install any new dependencies
npm install

# Restart the worker
pm2 restart pipeline-worker

# Check logs
pm2 logs pipeline-worker --lines 20
```

## 10. Monitoring

### Check Worker Health

```bash
# PM2 status
pm2 status

# Worker logs
pm2 logs pipeline-worker --lines 50

# Supabase queue status (via API)
curl -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET" \
  "https://x-ai-content-factory-orchestrator.vercel.app/api/pipeline-runs?limit=5&includeTasks=1&cleanup=1"
```

### Check Pipeline Tasks Directly

```sql
-- Check active tasks
SELECT id, task_type, status, account_handle, attempts, locked_by, locked_at, created_at
FROM pipeline_tasks
WHERE status IN ('queued', 'running', 'stuck')
ORDER BY created_at DESC;

-- Check task progress for a run
SELECT task_type, status, account_handle, attempts, error_message
FROM pipeline_tasks
WHERE run_id = '<run-id>'
ORDER BY step_order;

-- Check stuck tasks
SELECT id, task_type, account_handle, locked_at, locked_by
FROM pipeline_tasks
WHERE status = 'running' AND locked_at < now() - interval '10 minutes';
```

## 11. Troubleshooting

### Worker Won't Start

- Check env vars: `node -e "require('dotenv').config(); console.log(process.env.SUPABASE_URL)"`
- Check Node.js version: `node --version` (needs 18+)
- Check npm install completed: `ls node_modules/.package-lock.json`

### Tasks Stuck in "running"

- Check if worker is alive: `pm2 status`
- Mark stuck tasks: `curl -H "x-orchestrator-secret: $ORCHESTRATOR_SECRET" "https://x-ai-content-factory-orchestrator.vercel.app/api/pipeline-runs?cleanup=1"`
- Or run SQL: `UPDATE pipeline_tasks SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '10 minutes';`

### Worker Crashes Repeatedly

- Check PM2 logs: `pm2 logs pipeline-worker --err --lines 50`
- Check memory: `pm2 monit`
- Reduce MAX_TASKS_PER_BATCH in the script if needed
- Ensure all env vars are set in `.env.worker`

### High Memory Usage

- Reduce `MAX_TASKS_PER_BATCH` in the script
- Add `--max-old-space-size=512` to Node: `pm2 start "node --max-old-space-size=512 ./node_modules/.bin/tsx scripts/pipeline-worker.ts" --name pipeline-worker`
