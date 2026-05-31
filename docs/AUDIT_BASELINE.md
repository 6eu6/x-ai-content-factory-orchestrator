# AUDIT BASELINE — Phase 0 Freeze (Updated 2026-06-01)

**Date:** 2026-06-01
**Auditor:** PRE/POST CHANGE DEEP VERIFICATION AUDIT v1
**Audit Protocol:** Sections A–K comprehensive verification

---

## Current State

### Git
- **Latest commit SHA:** `25cda8fc66bfc6af9ef34da60a7421aae153b63c`
- **Branch:** `main`
- **Working tree:** Clean (no uncommitted changes)

### Recent Commits
| # | SHA | Message |
|---|-----|---------|
| 1 | `25cda8f` | docs: mark P0-3 and P1-4 as COMPLETE in roadmap |
| 2 | `96fd4f9` | fix: P0-3 hard-reject brief_crafting_parse_failed + P1 prompt drift + deprecation warning |
| 3 | `3b28c0f` | docs: update audit reports with 2026-06-01 verification findings |
| 4 | `2fc0616` | audit: system-wide deep audit + S1.3 adjacent pattern fix |
| 5 | `2472765` | feat(S1.3): Account Growth Lens — broaden niche without allowing forced angles |
| 6 | `5fdf5e0` | fix(S1.2): propagate post_length_policy into craft/select/judge/polish |
| 7 | `66eef52` | Phase S1.2: Account Posting Limits + Polish Hard Cap |
| 8 | `06dff0b` | feat(M1): structured memory compaction for token savings + quality learning |
| 9 | `e29c608` | fix(2G.3): near-pass polish crash when results.length > judgedOpportunities.length |
| 10 | `74134d3` | Phase S1.1: Source Freshness Gate for Reply/Quote Recommendations |

### Versions
| Dependency | Version |
|-----------|---------|
| Node | v24.15.0 |
| Next.js | ^16.2.6 |
| TypeScript | 6.0.3 |
| Vitest | 3.2.4 |
| OpenAI SDK | ^6.39.0 |
| Supabase JS | ^2.106.1 |
| Zod | ^4.4.3 |
| pg | ^8.21.0 |

### Build & Test Status

| Check | Status | Details |
|-------|--------|---------|
| `npm install` | PASS | Dependencies resolved |
| `npx tsc --noEmit` | PASS | Zero type errors |
| `npm run build` | PASS | All 55 API routes compiled |
| `npx vitest run` | PASS | **35 test files, 922 tests, all passing** |

### Environment Keys Verified

| Key | Status |
|-----|--------|
| SUPABASE_URL | OK — reachable, auth works |
| SUPABASE_SERVICE_ROLE_KEY | OK — service_role JWT valid |
| ORCHESTRATOR_SECRET | OK |
| OPENAI_API_KEY (OpenRouter) | OK — sk-or-v1-* format |
| OPENAI_BASE_URL | OK — openrouter.ai/api/v1 |
| TWITTERAPI_IO_KEY | OK |
| TELEGRAM_BOT_TOKEN | OK |
| TELEGRAM_ALLOWED_CHAT_ID | OK — 5654610649 |
| GITHUB_TOKEN | OK — ghp_* |
| X_USERNAME | OK — 30piq |

---

## Hard Invariants Baseline

| # | Invariant | Status |
|---|-----------|--------|
| 1 | No auto-posting to X | VERIFIED — all X API calls are read-only |
| 2 | Telegram remains manual recommendation only | VERIFIED — all Telegram calls are send-only |
| 3 | Telegram message says "manual copy/publish only" | VERIFIED — Arabic text present |
| 4 | No candidate can bypass shield/judge/publish_gate | VERIFIED with gap — legacy daily-runner still callable |
| 5a | final_candidate_score >= 7.8 | VERIFIED — opportunity-judge.ts:58 |
| 5b | originality_score >= 7.8 | VERIFIED — opportunity-judge.ts:61 |
| 5c | usefulness_score >= 7 | VERIFIED — opportunity-judge.ts:64 |
| 5d | evidence_safety_score >= 8 | VERIFIED — opportunity-judge.ts:67 |
| 5e | brief_alignment_score >= 7.5 | VERIFIED — opportunity-judge.ts:70 |
| 6 | S1.2 post length: hard_limit=280, target=240, allow_longform=false | VERIFIED |
| 7 | S1.3 Account Growth Lens: broad lens with transferable angles | VERIFIED |
| 8 | No threshold changes | VERIFIED — all 5 thresholds match spec |
| 9 | "No recommendation" is acceptable | VERIFIED |

---

## Active Issues (from 2026-06-01 Deep Verification Audit)

### P0 — CRITICAL

| ID | Finding | Impact |
|----|---------|--------|
| J1 | `source_quality_scores` table MISSING from production DB | Source quality feedback loop is completely non-functional. Migration file exists but was never applied. |

### P1 — HIGH

| ID | Finding | Impact |
|----|---------|--------|
| C1/H1 | Memory compaction skipped when `notify_telegram=false` | Memory rules go stale, degrading quality over time |
| B4 | 9 stale "AI x Productivity x Career Growth" prompts in content-type-engine.ts, media-pipeline.ts, content.ts, viral-discovery-run/route.ts, growth.ts | Prompt drift — content generation uses outdated narrow lens |
| B4b | content-engine-v3.ts:990 overly-broad prompt "can tweet about anything" | Contradicts S1.3 lens boundaries |

### P2 — MEDIUM

| ID | Finding | Impact |
|----|---------|--------|
| C2 | opportunity_judge does NOT enforce post length policy | Wastes compute on text that will fail at publish_gate |
| B3 | Legacy daily-runner.ts bypasses judge/shield (still callable via API) | Unjudged content could reach publish_gate |

### P3 — LOW

| ID | Finding | Impact |
|----|---------|--------|
| C3 | Micro-repair uses getDefaultPostLengthPolicy() instead of injected | Won't adapt if @30piq upgrades to Premium |
| B2 | Decision engine thresholds (7.0-7.8) lower than judge gate (7.8) | Misleading but not a safety hole |
| F1 | 3 corrupted accounts in DB (emoji/Arabic entries) | Harmless but messy |

---

## Database State

### Critical Tables
| Table | Rows | Status |
|-------|------|--------|
| pipeline_cost_ledger | 3,802 | ACTIVE |
| compact_operator_rules | 33 | ACTIVE |
| source_author_memory | 1 | ACTIVE (karpathy only) |
| pipeline_runs | 35 | ACTIVE |
| published_decisions | 6 | ACTIVE |
| accounts | 27 | ACTIVE (3 corrupted) |
| memory_compaction_runs | 5 | ACTIVE |
| **source_quality_scores** | **MISSING** | **Migration not applied** |

### Corrupted Accounts (to delete)
- `📋` (emoji)
- `قائمة` (Arabic "list")
- `الحسابات` (Arabic "accounts")

---

## VERDICT: **NEEDS FOLLOW-UP**

System is NOT in a dangerous state. No auto-posting, no threshold violations, no security holes. However, P0 + 3x P1 issues must be fixed before considering the system fully operational.

**Required actions before next change:**
1. Apply `source_quality_scores` migration to production DB (P0)
2. Fix memory compaction placement (P1)
3. Update 9 stale prompts to S1.3 lens (P1)
4. Fix content-engine-v3.ts overly-broad prompt (P1)

After each fix, run POST-CHANGE verification per the audit protocol.
