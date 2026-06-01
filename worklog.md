---
Task ID: 1
Agent: main
Task: Fix stale downgrade bug, tighten budgets, add gated dynamic source discovery

Work Log:
- Read and analyzed all pipeline files: decision-engine.ts, content-policy.ts, pipeline-worker.ts, pipeline-queue.ts, source-selection.ts, source-discovery.ts (orchestrator copy)
- Fixed stale downgrade bug in content-policy.ts: removed downgrade-to-standalone logic, stale items always rejected
- Fixed decision-engine.ts: stage_0_new max_total=2, min_final_score=7.0, max_threads=0; all stages min_final_score=7.0, max_threads=0; safety threshold 6.5→7.0
- Added defense-in-depth stale filter in pipeline-worker.ts processDecision
- Created lib/source-discovery.ts with ENABLE_DYNAMIC_SOURCE_DISCOVERY env flag gating (default false)
- Updated .env.example with new flag documentation
- Updated tests/phase-s1-1-freshness-gate.test.ts for no-downgrade behavior
- Verified: no auto-posting code exists anywhere in the codebase
- All 34 directly-related tests pass, 0 new test failures introduced

Stage Summary:
- Commit SHA: c5b76a5d2df9ae71711fdff43ac4c6d2e6cc0386
- Push failed (no GitHub token in environment) — commit is local only
- All user requirements met: no downgrade, budgets tightened, discovery gated, no auto-post
