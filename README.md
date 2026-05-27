# X AI Content Factory Orchestrator

نظام آلي متكامل لزراعة حساب تويتر `@30piq` في مجال AI × الإنتاجية × النمو المهني.

**المبدأ الأساسي**: النظام يُنتج المحتوى ويفحصه ويسلمه عبر تليغرام — والنشر يدوي دائمًا. لا يوجد نشر تلقائي إلى تويتر أبدًا.

## Pipeline

```
زحف → تعلّم → تذكر → درع الحماية → مسار النماذج → توليد → تسليم تليغرام → نشر يدوي → مسح النتائج → تعلّم سببي → تحديث الذاكرة
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Framework** | Next.js 16 (App Router) + TypeScript |
| **Database** | Supabase (PostgreSQL) — 32+ tables |
| **AI Gateway** | OpenRouter (13 task-specific model routes) |
| **Twitter** | TwitterAPI.io (read-only) |
| **Search** | Serper.dev + SerpApi |
| **Delivery** | Telegram Bot API |
| **Deployment** | Vercel (cron jobs configured) |
| **Code Hosting** | GitHub (`6eu6/x-ai-content-factory-orchestrator`) |

## Architecture

- **16 lib files** — Business logic layer (model-router, account-shield, content-type-engine, media-pipeline, publishing-pipeline, performance-feedback, etc.)
- **42 API routes** — All endpoints for the full pipeline
- **Telegram Bot** — 14+ Arabic commands with interactive keyboard
- **All AI calls** go through `callModel()` from `lib/model-router.ts` — no direct OpenAI client usage

## Environment Variables

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ORCHESTRATOR_SECRET
OPENAI_API_KEY
OPENAI_BASE_URL
OPENAI_MODEL
OPENROUTER_REFERER
OPENROUTER_TITLE
X_BEARER_TOKEN
X_USERNAME
TWITTERAPI_IO_KEY
TWITTERAPI_IO_BASE_URL
GITHUB_TOKEN
GITHUB_OWNER
SERPER_API_KEY
SERPAPI_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_WEBHOOK_SECRET
TELEGRAM_ALLOWED_CHAT_ID
PUBLIC_BASE_URL
```

## API Routes (42 endpoints)

### Core
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | System health check (public, no auth) |
| `/api/db-setup` | GET | Check/create database tables |
| `/api/check-account` | GET | Check @30piq account status |
| `/api/daily-run` | GET/POST | Main daily orchestrator |
| `/api/model-router` | GET/POST/DELETE | Model routing rules management |
| `/api/shield-check` | POST | Content safety check (11 checks) |
| `/api/format-decision` | GET/POST | Content format selection |
| `/api/production-cycle` | GET/POST | Generate production cards |
| `/api/generate-media` | POST | Media generation |
| `/api/publish-pack` | POST | Format + deliver content pack |
| `/api/account-performance-scan` | GET | Performance scan with causal learning |
| `/api/learning-cycle` | GET/POST | Smart learning cycle |
| `/api/weekly-review` | GET | Weekly review |
| `/api/viral-account-scan` | GET/POST | Deep viral account analysis |
| `/api/viral-discovery-run` | GET/POST | Autonomous viral discovery |
| `/api/research-intel-v4` | GET | Source research |
| `/api/research-intel-run` | GET/POST | Research intelligence |
| `/api/discovery-run` | GET | GitHub + web discovery |
| `/api/memory-maintenance-run` | GET | Memory maintenance |
| `/api/growth-learning-run` | GET/POST | Growth learning |
| `/api/learning-reflection-run` | GET/POST | Self-reflection |
| `/api/log-user-action` | POST | User action logging |
| `/api/github-create-repo` | POST | GitHub repo creation |
| `/api/debug-twitterapi` | GET | TwitterAPI diagnostics |
| `/api/system-cleanup` | POST | Test data cleanup |

### Repo Pipeline
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/repo-ingest` | GET/POST | Ingest GitHub repository |
| `/api/repo-deep-learn` | GET/POST | Deep learning from repo |
| `/api/repo-deep-learn-excerpt` | GET/POST | Deep learn from stored excerpts |
| `/api/repo-style-learn` | GET/POST | Learn repo style templates |
| `/api/repo-build-planner` | GET/POST | Plan repo builds |
| `/api/repo-artifact-writer` | GET/POST | Write repo artifacts |
| `/api/repo-artifact-repair` | GET/POST | Repair repo artifacts |
| `/api/repo-validation-run` | GET | Validate repo build |
| `/api/repo-post-push-validation` | GET | Post-push validation |
| `/api/repo-create-and-push` | POST | Create and push repo to GitHub |
| `/api/repo-investment-run` | GET | Repo investment evaluation |
| `/api/launch-content-from-repo` | GET/POST | Launch content from owned repo |
| `/api/launch-content-repair` | GET/POST | Repair launch content |
| `/api/launch-content-repair-strict` | GET/POST | Strict repair |
| `/api/launch-content-repair-v2` | GET/POST | Repair v2 |

### Telegram Bot
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/telegram/webhook` | POST | Bot command handler (14+ Arabic commands) |
| `/api/telegram/setup` | GET | Set Telegram webhook URL |

## Telegram Bot Commands

| Button | Triggers |
|--------|----------|
| 🧪 تشغيل خطة اليوم | `/api/daily-run` |
| 📊 حالة الحساب | Supabase query (account_state) |
| 📊 مسح الأداء | `/api/account-performance-scan` |
| 🧠 حالة التعلم | Supabase query (learning tables) |
| 🏭 إنتاج المحتوى | `/api/production-cycle` |
| ✅ محتوى جاهز للنشر | Supabase query (content cards) |
| 🔍 دورة تعلم ذكية | `/api/learning-cycle` |
| 🚀 تشغيل فحص تعلم | `/api/viral-account-scan` |
| 🧭 محرك القرار | `/api/format-decision` |
| 📦 زحف مستودع | Flow: awaiting_repo_url → `/api/repo-ingest` |
| ➕ إضافة حساب للتعلم | Flow: awaiting_learning_account |
| 🔗 إضافة تغريدة للتعلم | Flow: awaiting_learning_tweet |
| 📋 المهام اليومية | Supabase query (action_queue) |
| 🛡 فحص الحماية | Shield check on recent content |
| 🔎 اكتشاف تلقائي | `/api/research-intel-v4` |
| 📅 مراجعة أسبوعية | `/api/weekly-review` |
| 🧹 صيانة الذاكرة | `/api/memory-maintenance-run` |
| 📈 تعلم النمو | `/api/growth-learning-run` |

## Cron Jobs (vercel.json)

| Schedule | Endpoint | Description |
|----------|----------|-------------|
| Daily 06:00 UTC | `/api/daily-run` | Main daily orchestrator |
| Daily 03:00 UTC | `/api/memory-maintenance-run` | Memory maintenance |
| Daily 20:00 UTC | `/api/account-performance-scan` | Performance scan |

## Safety Rules

1. **النشر يدوي دائمًا** — المحتوى يُسلّم عبر تليغرام والإنسان ينشره يدويًا
2. **OpenRouter هو البوابة** — كل استدعاء AI يمر عبر `callModel()` من model-router
3. **درع الحماية إلزامي** — كل محتوى يمر عبر account-shield قبل التسليم
4. **تعلّم سببي** — الأداء يُربط بقواعد وأنماط محددة
5. **أمان الحسابات الصغيرة** — إذا المتابعين < 500: لا روابط خارجية، لا هاشتاقات
6. **تصفية مصدرية** — كل بحث يمر عبر source-bound.ts

## Database (32+ Tables)

### Core Tables
`model_routing_rules`, `performance_scans`, `content_deliveries`, `working_memory`

### Learning Tables
`x_algorithm_learning_rules`, `viral_style_patterns`, `mcp_opportunity_map`, `system_learning_rules`

### Content & Production
`content_log`, `content_opportunities`, `content_format_decisions`, `content_production_cards`, `original_content_hypotheses`

### Accounts & Scanning
`accounts`, `account_state`, `viral_scan_runs`, `viral_tweet_analyses`, `viral_account_patterns`

### Repo Pipeline
`repo_sources`, `repo_source_files`, `repo_creation_decisions`, `repo_build_plans`, `repo_build_artifacts`, `repo_artifact_requirements`, `repo_validation_runs`, `owned_repo_projects`, `repo_publication_events`, `repo_investment_decisions`, `repo_style_templates`, `repo_writer_quality_rules`

### Other
`session_logs`, `daily_checkins`, `action_queue`, `trends`, `creator_intel`, `learning_tweet_queue`, `learning_cycles`, `telegram_bot_state`, `growth_learning_runs`, `discovery_runs`, `discovered_items`, `discovery_sources`, `sources`, `quality_failure_patterns`, `prompt_improvement_candidates`, `source_performance`, `system_reflections`, `github_repos`, `repo_growth_snapshots`

## Self-Hosting & Local Model (Raspberry Pi)

البنية مهيّأة للتشغيل الذاتي على Raspberry Pi دون إعادة كتابة — التبديل **إعدادات لا كود**:

### 1. تشغيل نموذج محلي لمهام مختارة (هجين)
كل استدعاء AI يمر عبر `callModel()` في `lib/model-router.ts`، الذي يختار المزوّد لكل مهمة:
- `provider = 'cloud'` (افتراضي) → OpenRouter/OpenAI عبر `OPENAI_BASE_URL`.
- `provider = 'local'` → نموذج محلي عبر `LOCAL_AI_BASE_URL` (مثل Ollama).

**خطوات التحويل** (بلا تعديل كود):
1. على الـ Pi: `ollama serve` ثم `ollama pull qwen2.5:7b`.
2. اضبط `LOCAL_AI_BASE_URL=http://localhost:11434/v1`.
3. أضف عمود المزوّد مرة واحدة: `ALTER TABLE model_routing_rules ADD COLUMN IF NOT EXISTS provider text;`
4. وجّه المهام الخفيفة محليًا، مثلاً:
   ```sql
   INSERT INTO model_routing_rules (task_type, model_id, provider, temperature, max_tokens, active)
   VALUES ('shield_check', 'qwen2.5:7b', 'local', 0.0, 800, true);
   ```
   ابقِ المهام الثقيلة (`deep_analysis`, `learning_extraction`) على `cloud` — النماذج 7B لا تضاهيها.

### 2. الاستضافة 24/7
- `npm run build && npm start` تحت `pm2` أو `systemd` لإعادة التشغيل التلقائي.
- بدل Vercel cron: `systemd timer` أو `node-cron` يستدعي `GET /api/daily-run?secret=...`.
- اضبط `PUBLIC_BASE_URL` على عنوان الـ Pi، ثم استدعِ `/api/telegram/setup` لتحديث الـ webhook.
- المهام الخلفية محمولة عبر `lib/background.ts` (`waitUntil` على Vercel، وإكمال طبيعي على Node الدائم).

### 3. الموثوقية
- كل استدعاءات الشبكة (النموذج، Telegram، TwitterAPI.io، البحث) تمر عبر `lib/retry.ts` (تراجع أسي على 429/5xx/أخطاء الشبكة).
- إصدارات الحزم مثبّتة (لا `latest`) لبناء قابل للتكرار.
- اختبارات الوحدة: `npm test` (vitest).
