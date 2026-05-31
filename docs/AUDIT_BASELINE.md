# AUDIT BASELINE — Phase 0 Freeze

**Date:** 2026-06-01
**Auditor:** System-wide deep audit

---

## Current State

### Git
- **Latest commit SHA:** `2472765e77a444c4168afb99aa72affb738de2d3`
- **Branch:** `main`
- **Recent 10 commits:**
  1. `2472765` feat(S1.3): Account Growth Lens — broaden niche without allowing forced angles
  2. `5fdf5e0` fix(S1.2): propagate post_length_policy into craft/select/judge/polish
  3. `66eef52` Phase S1.2: Account Posting Limits + Polish Hard Cap
  4. `06dff0b` feat(M1): structured memory compaction for token savings + quality learning
  5. `e29c608` fix(2G.3): near-pass polish crash when results.length > judgedOpportunities.length
  6. `74134d3` Phase S1.1: Source Freshness Gate for Reply/Quote Recommendations
  7. `c9868cd` Phase S1: Pipeline Contract Stabilization & Replay Testing
  8. `7738ced` Phase 2G.3 Hotfix: Fix opportunity_judge undefined crafted_text crash
  9. `7efceca` Phase 2G.3: Dual Candidate Generation + Internal Selection
  10. `e0d9266` Phase 2G.2 — Brief-Locked Signature Polish + Signature Validator Fix

### Versions
- **Node:** v24.15.0
- **Next.js:** ^16.2.6
- **TypeScript:** 6.0.3
- **Vitest:** 3.2.4

### Package Scripts
| Script | Command |
|--------|---------|
| `dev` | `next dev` |
| `build` | `next build --webpack` |
| `start` | `next start` |
| `lint` | `next lint` |
| `test` | `vitest run` |
| `worker:pipeline` | `tsx scripts/pipeline-worker.ts` |

### Environment Assumptions
- **Supabase project:** `qmoictvgwavhirnexscz`
- **No .env files in repo** (gitignored; credentials on Vercel/Oracle VPS only)
- **AI gateway:** OpenRouter (OPENAI_BASE_URL=https://openrouter.ai/api/v1)
- **X API:** TwitterAPI.io for scanning
- **Telegram:** Bot-based recommendation delivery (manual publish only)
- **Worker:** Persistent Oracle VPS worker via PM2 (`scripts/pipeline-worker.ts`)
- **Fallback:** Vercel serverless via `app/api/pipeline-worker/route.ts`

---

## Build Status

| Check | Status | Details |
|-------|--------|---------|
| `npm run build` | PASS | All routes compiled successfully. 30+ API routes + static pages. |
| `npx tsc --noEmit` | PASS | Zero type errors. |
| `npx vitest run` | PASS | **35 test files, 913 tests, all passing.** Duration: 6.27s |

### Test Files (35)
- `phase2f-near-pass-polish.test.ts` (41 tests)
- `phase2d-quality.test.ts` (88 tests)
- `phase2c-quality.test.ts` (68 tests)
- `phase2a-ledger.test.ts` (45 tests)
- `phase2d1-model-routing.test.ts` (25 tests)
- `phase2c1-quality.test.ts` (59 tests)
- `phase2c2-quality.test.ts` (12 tests)
- `phase2b-quality.test.ts` (82 tests)
- `phase-s1-3-account-growth-lens.test.ts` (40 tests)
- `phase-s1-2-post-length-policy.test.ts` (45 tests)
- `phase-m1-structured-memory.test.ts` (17 tests)
- `phase2g1-signature-voice.test.ts` (15 tests)
- `phase2e3-rejection-transparency.test.ts` (15 tests)
- `phase2g3-dual-candidate.test.ts` (10 tests)
- `rule-performance.test.ts` (25 tests)
- `phase-s1-1-freshness-gate.test.ts` (16 tests)
- `feedback-loop.test.ts` (68 tests)
- `phase2e1-discovery-audit.test.ts` (19 tests)
- `phase2g-originality-context.test.ts` (14 tests)
- `phase2d2-brief-crafting.test.ts` (17 tests)
- `content-policy.test.ts` (30 tests)
- `phase2g2-brief-locked-polish.test.ts` (13 tests)
- `phase2d3-crafting-contract.test.ts` (19 tests)
- `phase2d-integration-fix.test.ts` (28 tests)
- `phase2g3-hotfix2-near-pass-mismatch.test.ts` (8 tests)
- `cron-reliability.test.ts` (19 tests)
- `telegram-parsing.test.ts` (8 tests)
- `phase2g3-hotfix-candidate-crash.test.ts` (7 tests)
- `decision-engine.test.ts` (4 tests)
- `performance-outcome.test.ts` (20 tests)
- `brain-quality.test.ts` (10 tests)
- `parse-model-json.test.ts` (6 tests)
- `x-scoring.test.ts` (4 tests)
- `retry.test.ts` (7 tests)
- `pipeline-contract-replay.test.ts` (9 tests)

---

## Current Failures

**None.** All builds, typechecks, and tests pass cleanly.

---

## Baseline Established

This baseline confirms the project is in a healthy, buildable, testable state. All subsequent audit phases can reference this as the known-good state.

**No edits should be made until all audit phases document findings. Only Phase 13 allows small safe fixes.**
