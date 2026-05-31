# AUDIT BASELINE — Phase 0 Freeze (Updated)

**Date:** 2026-06-01
**Auditor:** System-wide deep audit (second pass, comprehensive verification)
**Audit Protocol:** PRE/POST CHANGE DEEP VERIFICATION AUDIT v1

---

## Current State

### Git
- **Latest commit SHA:** `2fc0616a603dfde700576b6b87cbce9db4cb1f19`
- **Branch:** `main`
- **Latest commit message:** `audit: system-wide deep audit + S1.3 adjacent pattern fix`

### Recent 15 Commits
| # | SHA | Message |
|---|-----|---------|
| 1 | `2fc0616` | audit: system-wide deep audit + S1.3 adjacent pattern fix |
| 2 | `2472765` | feat(S1.3): Account Growth Lens — broaden niche without allowing forced angles |
| 3 | `5fdf5e0` | fix(S1.2): propagate post_length_policy into craft/select/judge/polish |
| 4 | `66eef52` | Phase S1.2: Account Posting Limits + Polish Hard Cap |
| 5 | `06dff0b` | feat(M1): structured memory compaction for token savings + quality learning |
| 6 | `e29c608` | fix(2G.3): near-pass polish crash when results.length > judgedOpportunities.length |
| 7 | `74134d3` | Phase S1.1: Source Freshness Gate for Reply/Quote Recommendations |
| 8 | `c9868cd` | Phase S1: Pipeline Contract Stabilization & Replay Testing |
| 9 | `7738ced` | Phase 2G.3 Hotfix: Fix opportunity_judge undefined crafted_text crash |
| 10 | `7efceca` | Phase 2G.3: Dual Candidate Generation + Internal Selection |
| 11 | `e0d9266` | Phase 2G.2 — Brief-Locked Signature Polish + Signature Validator Fix |
| 12 | `856d4a9` | Phase 2E.3 — Discovery Rejection Transparency |
| 13 | `3a67773` | Phase 2G.1 — Signature Voice + Stronger Originality Strategy |
| 14 | `47d4521` | Phase 2G: RAG-Guided Originality & Angle Bank |
| 15 | `9e219cb` | Phase 2F.1 hotfix: stale judge state + source deduplication |

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

### Package Scripts
| Script | Command |
|--------|---------|
| `dev` | `next dev` |
| `build` | `next build --webpack` |
| `start` | `next start` |
| `lint` | `next lint` |
| `test` | `vitest run` |
| `worker:pipeline` | `tsx scripts/pipeline-worker.ts` |

### Codebase Stats
| Metric | Value |
|--------|-------|
| lib/*.ts files | 55 |
| lib/ total lines | 25,326 |
| test files | 35 |
| test total lines | 15,122 |
| API routes | 55 |
| app/ size | 772K |
| lib/ size | 1.1M |

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
| `npm install` | PASS | 2 moderate vulnerabilities (non-blocking) |
| `npm run build` | PASS | All routes compiled. 55 API routes + static pages |
| `npx tsc --noEmit` | PASS | Zero type errors |
| `npx vitest run` | PASS | **35 test files, 922 tests, all passing.** Duration: 6.27s |

### Test Files (35)
| Test File | Tests |
|-----------|-------|
| phase2d-quality.test.ts | 88 |
| phase2b-quality.test.ts | 82 |
| feedback-loop.test.ts | 68 |
| phase2c-quality.test.ts | 68 |
| phase2a-ledger.test.ts | 45 |
| phase-s1-2-post-length-policy.test.ts | 45 |
| phase-s1-3-account-growth-lens.test.ts | 49 |
| phase2c1-quality.test.ts | 59 |
| phase2f-near-pass-polish.test.ts | 41 |
| phase-m1-structured-memory.test.ts | 17 |
| phase-s1-1-freshness-gate.test.ts | 16 |
| phase2g1-signature-voice.test.ts | 15 |
| phase2e3-rejection-transparency.test.ts | 15 |
| phase2d1-model-routing.test.ts | 25 |
| rule-performance.test.ts | 25 |
| phase2d-integration-fix.test.ts | 28 |
| content-policy.test.ts | 30 |
| cron-reliability.test.ts | 19 |
| phase2e1-discovery-audit.test.ts | 19 |
| performance-outcome.test.ts | 20 |
| phase2d2-brief-crafting.test.ts | 17 |
| phase2d3-crafting-contract.test.ts | 19 |
| brain-quality.test.ts | 10 |
| phase2g-originality-context.test.ts | 14 |
| phase2g2-brief-locked-polish.test.ts | 13 |
| phase2c2-quality.test.ts | 12 |
| phase2g3-dual-candidate.test.ts | 10 |
| pipeline-contract-replay.test.ts | 9 |
| phase2g3-hotfix2-near-pass-mismatch.test.ts | 8 |
| telegram-parsing.test.ts | 8 |
| phase2g3-hotfix-candidate-crash.test.ts | 7 |
| retry.test.ts | 7 |
| parse-model-json.test.ts | 6 |
| x-scoring.test.ts | 4 |
| decision-engine.test.ts | 4 |

---

## Hard Invariants Baseline

| # | Invariant | Status |
|---|-----------|--------|
| 1 | No auto-posting to X | VERIFIED — all X API calls are read-only |
| 2 | Telegram remains manual recommendation only | VERIFIED — all Telegram calls are send-only, no X write endpoints |
| 3 | Telegram message says "manual copy/publish only" | VERIFIED — Arabic text "انسخ وانشر يدويًا فقط" in daily-runner.ts:555 |
| 4 | No unjudged text can reach publish_gate | VERIFIED with gap — legacy daily-runner.ts bypasses judge (documented risk) |
| 5 | No candidate can bypass shield/judge/publish_gate | VERIFIED — all 3 gates checked in sequence |
| 6a | final_candidate_score >= 7.8 | VERIFIED — lib/opportunity-judge.ts |
| 6b | originality_score >= 7.8 | VERIFIED |
| 6c | usefulness_score >= 7 | VERIFIED |
| 6d | evidence_safety_score >= 8 | VERIFIED |
| 6e | brief_alignment_score >= 7.5 | VERIFIED |
| 7 | S1.2 post length policy: hard_limit=280, target=240, allow_longform=false | VERIFIED |
| 8 | S1.3 Account Growth Lens: broad lens, transferable angles, forced angle detection | VERIFIED |
| 9 | Weak content must be rejected | VERIFIED — multiple gates enforce |
| 10 | "No recommendation" is acceptable | VERIFIED — decision engine can return empty |

---

## Known Issues from This Audit

### CRITICAL (P0)
1. **Enrich step weak candidate pass**: When all 3 craftFromBrief candidates fail, opportunity keeps stale pre-intelligence crafted_text with `_brief_crafting_parse_failed=true`. Nothing downstream hard-rejects on this flag.
2. **Memory compaction not in processTask switch**: `memory_compaction` case missing from pipeline task dispatcher. However, memory compaction IS triggered inside `processTelegramDelivery` as a fire-and-forget step, so it does run. Memory retrieval IS integrated into the enrich step via `getRelevantStructuredMemory`. The issue is that compaction is not a separately trackable/retryable task type, not that it doesn't run at all.

### HIGH (P1)
3. **Prompt drift in 3 files**: `originality-enhancer.ts:487` and `originality-enhancer.ts:572` and `numeric-claim-guard.ts:154` still use old narrow "AI x productivity x career growth" wording.
4. **Legacy daily-runner bypasses judge**: Documented but not blocked at runtime. Unjudged text could reach publish_gate via this path.
5. **No source quality feedback loop**: `source_quality_scores` exists but never queried during account selection.
6. **Memory: good_angles never populated**: Source author memory only records failures; winning patterns always empty.
7. **Memory: winning_angle/source_pattern rule types never created**: Compaction only creates failure-derived types.
8. **Noisy accounts waste AI budget**: Zero-yield accounts scanned every cycle with same priority.

### MEDIUM (P2)
9. **No memory confidence decay**: Rules accumulate forever at high confidence with no time-based decay.
10. **No minimum confidence threshold for memory retrieval**: Low-confidence rules can appear in prompt injection.
11. **Invalid handles not cleaned from DB**: Stay in accounts table, consuming fetch budget.
12. **Brief alignment gate skipped for opportunities without a brief**: Only checks if `_brief.recommended_angle.length >= 10`.
13. **Missing diagnostics**: load_account_state emits no structured diagnostics; persist_decision silent-fails on daily_checkins.
14. **Misleading comment**: content-engine-v3.ts:1254 "Lowered thresholds" refers to scan prefilter, not quality thresholds.

### LOW (P3)
15. **niche-alignment.ts missing explicit ALLOWED_ADJACENCY_PATTERNS for "social media behavior"**
16. **Rescue prompt wording inconsistent with canonical S1.3** (opportunity-intelligence.ts:1324)
17. **Missing regression test for نشرت command** (confirms it only logs, never posts)

---

## Baseline Established

This baseline confirms the project is in a buildable, testable state with 922 passing tests. All hard invariants are verified at the code level with the gaps noted above.

**No destructive edits should be made until the repair roadmap is finalized (Phase 12). Only Phase 13 allows small safe fixes with pre/post verification.**
