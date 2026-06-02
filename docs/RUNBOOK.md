# Operations Runbook — X Growth Brain

Everything needed to take the system from a fresh deploy to a running, verified
state. Read top to bottom once.

## 0) Prerequisite the tool cannot do for you

Fix the account foundation first, or growth will not happen regardless of code:
- Real display name (not "User")
- A niche bio (what `@30piq` is about)
- Avatar + banner
- One narrow niche (already set: AI tools / workflows / building with AI)

## 1) Two runtimes (important mental model)

| Runtime | Runs what | How it starts |
| --- | --- | --- |
| **Vercel** | API routes + Telegram webhook (commands, ✅/🔍 buttons) — event-driven | auto on git push to `main` |
| **Oracle VM worker** | the continuous engine: opportunity radar + once-daily crawl/feedback/digest/prune | `npm run worker` under PM2 |

There are **no crons** (GitHub + Vercel crons removed). The worker is the only
scheduler. The `/api/lean-*` routes exist for **manual** runs/tests only.

## 2) Environment variables

Set the **same** core vars in **both** places (Vercel project settings **and**
the Oracle `.env`). `ORCHESTRATOR_SECRET` / `PUBLIC_BASE_URL` are only needed on
Vercel.

| Var | Where | Purpose |
| --- | --- | --- |
| `SUPABASE_URL` | both | database |
| `SUPABASE_SERVICE_ROLE_KEY` | both | database (server key) |
| `OPENAI_API_KEY` | both | OpenRouter key (chat models) |
| `OPENAI_BASE_URL` = `https://openrouter.ai/api/v1` | both | model gateway |
| `EMBEDDINGS_API_KEY` | both | embeddings (OpenAI) — enables semantic RAG |
| `EMBEDDINGS_BASE_URL` = `https://api.openai.com/v1` | both | embeddings endpoint |
| `EMBEDDINGS_MODEL` = `text-embedding-3-small` | both | embeddings model |
| `TWITTERAPI_IO_KEY` | both | read-only X data |
| `TWITTERAPI_IO_BASE_URL` = `https://api.twitterapi.io` | both | X data base |
| `X_USERNAME` = `30piq` | both | the account |
| `TELEGRAM_BOT_TOKEN` | both | bot |
| `TELEGRAM_WEBHOOK_SECRET` | both | webhook auth |
| `TELEGRAM_ALLOWED_CHAT_ID` | both | only you can use the bot |
| `SERPER_API_KEY` | both | 🔍 Deep research button (optional) |
| `ORCHESTRATOR_SECRET` | Vercel | protects `/api/*` |
| `PUBLIC_BASE_URL` = `https://x-ai-content-factory-orchestrator.vercel.app` | Vercel | webhook URL |
| `LEAN_POLL_MINUTES` (default 20) | Oracle | radar interval |
| `LEAN_DAILY_OPP_CAP` (default 2) | Oracle | max opportunity pushes/day |

## 3) One-time setup (after env is set, Vercel is READY)

Replace `BASE` and `SECRET` with your `PUBLIC_BASE_URL` and `ORCHESTRATOR_SECRET`.

```bash
# a) Point Telegram at the webhook (enables commands + ✅/🔍 buttons)
curl "https://BASE/api/telegram/setup" -H "x-orchestrator-secret: SECRET"

# b) Backfill brain embeddings once (turns on semantic retrieval; ~595 rows)
curl -X POST "https://BASE/api/brain?action=backfill&limit=600" -H "x-orchestrator-secret: SECRET"

# c) Health + brain stats
curl "https://BASE/api/health"
curl "https://BASE/api/brain?action=stats" -H "x-orchestrator-secret: SECRET"
```

## 4) Validate WITHOUT the worker (one manual run)

This proves the whole chain (harvest → brain → generate → gate → Telegram)
before you turn on the continuous worker.

```bash
curl -X POST "https://BASE/api/lean-run?telegram=1" -H "x-orchestrator-secret: SECRET"
```

Expected: a Telegram digest message arrives with replies/quotes/standalone, each
showing **source handle · age · type · why**. The JSON response shows
`accepted`, `generated`, `rejected[]` (with reasons). If `accepted` is low, the
gate is working — check the `rejected` reasons, do **not** loosen quality.

## 5) Start the Oracle worker (the continuous engine)

```bash
cd <repo> && git pull origin main && npm install
# put the env vars above into .env on the VM
pm2 delete pipeline-worker 2>/dev/null   # remove the old, deleted worker
pm2 start "npm run worker" --name x-growth-worker
pm2 save
pm2 logs x-growth-worker
```

First-log expectation:
```
[worker] starting — poll every 20m, daily cap 2/account
[worker] @30piq: surfaced N opportunity(ies)
[worker] cycle done in Xs — sleeping ...
```

## 6) What to expect after it's running

- Within the first cycle (~minutes), if fresh high-momentum niche tweets exist,
  you get **opportunity cards** in Telegram: source + age + media type + why,
  the suggested reply/quote, a media tip, and **✅ Published / 🔍 Deep research**
  buttons.
- Once per day: a **digest** (standalone ideas + mix) plus background
  crawl/feedback/media-learning; weekly pruning on Sundays.
- Quiet periods are normal — the daily cap and freshness filter mean it only
  pings you for genuine opportunities (quality over quantity).

## 7) How to verify it works precisely

| Check | How | Pass condition |
| --- | --- | --- |
| Web/API live | `curl https://BASE/api/health` | `ok: true` |
| Semantic brain on | `/api/brain?action=stats` | `with_embedding` ≈ 595 |
| Manual run works | step 4 | Telegram digest arrives |
| Worker running | `pm2 status` | `x-growth-worker` online |
| Opportunities flowing | `select count(*) from opportunities;` | grows over time |
| No flooding | Telegram | ≤ `LEAN_DAILY_OPP_CAP` cards/day |
| No auto-post | your X profile | nothing posted automatically |
| Fresh sources | opportunity card age | replies ≤48h, quotes ≤168h |
| Buttons work | tap ✅ on a card | `opportunities.status='published'`, a `voice` memory appears |
| Learning closes | after publishing real posts + tapping ✅ | `brain_memory kind='voice'` count rises |

## 8) Daily usage

1. Opportunity card arrives → if you like it, post it manually on X.
2. Tap **✅ Published** (logs it, teaches the brain your taste).
3. For a tool/feature you want to explain on video, tap **🔍 Deep research** →
   get a sourced brief + clip script → record your own clip.
4. Optional: send `published <your post url>` to enable real engagement
   measurement (feedback loop scores it and feeds the brain).
5. Change settings anytime in chat: `niche <text>`, `lang en|ar`, `bot en|ar`.

## 9) Tuning

- More replies / fewer standalone for a small account: already set to
  `replies:2, quotes:1, standalone:0` (change anytime via the Telegram `mix 2 1 0` command).
- Too many/few pings: adjust `LEAN_DAILY_OPP_CAP`.
- Slower/faster radar: adjust `LEAN_POLL_MINUTES`.
- Freshness windows: `LEAN_REPLY_MAX_HOURS` (48), `LEAN_QUOTE_MAX_HOURS` (168).
