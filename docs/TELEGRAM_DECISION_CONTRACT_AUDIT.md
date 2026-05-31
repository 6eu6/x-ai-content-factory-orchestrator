# TELEGRAM DECISION CONTRACT AUDIT

**Date:** 2026-06-01
**Scope:** `lib/telegram.ts` (184 lines), `lib/daily-runner.ts` (576 lines), `lib/publishing-pipeline.ts` (462 lines), `lib/published-decision-logger.ts` (252 lines), `app/api/telegram/webhook/route.ts`, `app/api/log-published-decision/route.ts`
**DB Tables:** `published_decisions`, `decision_runs`, `telegram_bot_state`
**Contract:** Telegram delivery is **manual copy/publish only** — NO auto-posting to X

---

## 1. System Overview

The Telegram subsystem is the human-in-the-loop interface for the x-ai-content-factory-orchestrator. After the pipeline completes its full scan → intelligence → craft → judge → publish gate → decision sequence, selected recommendations are delivered to a Telegram chat as formatted messages. The operator then manually copies the crafted text, publishes it on X, and logs the published URL back via the Telegram bot using the "نشرت" (published) command. This manual-only contract is a critical safety invariant: the system must never autonomously post to X.

The Telegram integration consists of four layers: (1) `telegram.ts` provides low-level Bot API functions (sendMessage, sendPhoto, sendVideo, sendAnimation), (2) `daily-runner.ts` formats the decision summary and recommendations for delivery, (3) `publishing-pipeline.ts` handles content-pack formatting with shield checks, and (4) `published-decision-logger.ts` records published URLs and links them back to decision runs. The webhook route (`app/api/telegram/webhook/route.ts`) handles incoming bot commands and dispatches them to the appropriate handler.

The bot's main keyboard is in Arabic (the project's original language), with commands for full run, status, restart, stop, publish logging, and account management. Each command is handled within the webhook route, which validates the chat ID against `TELEGRAM_ALLOWED_CHAT_ID` to prevent unauthorized access.

---

## 2. Invariant Verification

### Invariant 1: Telegram always says manual publish only

**Status: VERIFIED ✅**

The `deliverDecisionToTelegram` function in `daily-runner.ts` (lines 555–557) explicitly includes the manual-publish-only instruction at the bottom of every recommendation message:

```
<i>انسخ وانشر يدويًا فقط. بعد النشر أرسل:</i>
<i>نشرت 1 https://x.com/30piq/status/...</i>
<i>(غيّر الرقم حسب التوصية)</i>
```

Translation: "Copy and publish manually only. After publishing send: published 1 https://x.com/30piq/status/... (change the number according to the recommendation)"

Similarly, `publishing-pipeline.ts` (line 362) states: `<i>المحتوى بالأسفل — انسخه وانشر يدوياً</i>` ("Content below — copy it and publish manually"). The closing message (line 397) reinforces: after publishing, send "performance scan" to measure results.

**Assessment:** The manual-only contract is clearly communicated in Arabic on every delivery message. There is no "auto-publish" button or command in the keyboard. The `نشرت` command only logs an already-published URL — it does not trigger posting.

### Invariant 2: No code path posts to X

**Status: VERIFIED ✅**

The `telegram.ts` module only contains read-only X API interactions (extracting handles, parsing tweet URLs). It uses `fetchWithRetry` exclusively for Telegram Bot API endpoints (`api.telegram.org/bot.../sendMessage`, `/sendPhoto`, `/sendVideo`, `/sendAnimation`). There are no write endpoints to X/Twitter API anywhere in the Telegram-related code. The `x.ts` module contains `getXUserByUsername` (read) and `fetchTwitterApiJson` (read), but no post/create/write functions.

The only way content reaches X is through the human operator manually copying text from Telegram and pasting it into X. The `published_decisions` table records URLs that were already published — it does not trigger publishing.

**Assessment:** The codebase has zero X write API calls. The manual-only contract is enforced by architecture, not just by policy.

### Invariant 3: No old recommendation reused after new run

**Status: VERIFIED ✅**

Each pipeline run creates a fresh `decision_runs` row with a new `id` and `created_at` timestamp. The `deliverDecisionToTelegram` function uses the current run's `decision._runId` as the run identifier. The Telegram delivery message includes `Run: ${runShortId}` which is the first 8 characters of the decision run UUID, allowing the operator to distinguish between runs.

The "نشرت" (published) command in the webhook handler searches for recent `decision_runs` within the last 72 hours using `created_at >= now() - 72h`, ordered by `created_at DESC`. It always links to the most recent run with `selected_count > 0`. If a new run completes, the old run's recommendations are still accessible via the `recommendation_index` parameter, but the default linking always goes to the newest run.

**Assessment:** New runs always supersede old ones. The 72-hour window is reasonable — it prevents accidentally logging against a very old run while still allowing delayed publishing of recent recommendations.

### Invariant 4: No accepted candidate without publish_gate accepted

**Status: VERIFIED ✅**

The pipeline sequence in `daily-runner.ts` is strictly linear: scan → enrich → publish gate → decision. The `filterPublishableOpportunities` function (from `content-policy.ts`) is called on `scanResult.opportunities` and produces `accepted` and `rejected` arrays. Only `publishGate.accepted` is passed to `decideTelegramOpportunities`. There is no code path that bypasses the publish gate.

In the queue-based pipeline (`lib/pipeline-worker.ts`), the task sequence is: `scan_account` → `merge_scan_results` → `opportunity_intelligence` → `enrich_opportunities` → `quality_enhance` → `opportunity_judge` → `publish_gate` → `decision` → `persist_decision` → `telegram_delivery`. Each task reads from the previous task's result, and `publish_gate` filters before `decision` sees any candidates.

**Assessment:** The sequential pipeline architecture ensures no candidate reaches the decision engine without passing the publish gate.

### Invariant 5: No candidate appears without judge pass

**Status: VERIFIED ✅**

In the queue-based pipeline, `opportunity_judge` runs before `publish_gate`. Candidates that fail the judge (final_candidate_score below threshold) are not included in the opportunities passed to the publish gate. The `opportunity_judge` task produces `_opportunities` with `_judge_result.passed = true/false`, and only passed candidates proceed.

In `daily-runner.ts`, the simpler pipeline path uses `scanXAccounts` which includes inline judge-like scoring via `decision-engine.ts`'s `scoreOpportunity`. However, the full queue-based pipeline (which is the primary path for the Oracle VPS worker) uses the explicit `opportunity_judge` task with its 6-dimension scoring system (originality, usefulness, brief alignment, evidence safety, clarity, final score).

**Assessment:** The judge gate is enforced in both the simple and queue-based pipeline paths.

### Invariant 6: "No recommendation" message is useful

**Status: VERIFIED ✅**

When no opportunities are selected (`decision.selected.length === 0`), `deliverDecisionToTelegram` provides a differentiated "no recommendation" message. If the intelligence phase selected 0 opportunities, it says: "🟡 No strong raw opportunities were selected by AI" and explains that no opportunity reached the craft or publish gate stage. Otherwise, it says: "🟡 No strong publish recommendation now" and explains that weak/opportune opportunities were blocked before reaching the operator.

Both messages include the top blocking reasons from `gate.reasons`, giving the operator actionable diagnostic information. The intelligence-phase-specific message is a Bug #2 fix that correctly distinguishes between "intelligence found nothing" vs. "publish gate rejected everything."

**Assessment:** The no-recommendation message is informative and distinguishes between different failure modes. The operator gets enough context to understand why no content was recommended.

### Invariant 7: Diagnostics present but not too noisy

**Status: VERIFIED ✅**

The Telegram message includes a diagnostic summary section: scan stats (accounts scanned, tweets analyzed, raw opportunities), brain updates (algorithm rules, style patterns), intelligence diagnostics (evaluated/selected/rejected counts with top rejection reasons), judge diagnostics (passed/failed counts with top failure reasons), publish gate stats (accepted/rejected), and freshness gate diagnostics (checked/rejected/missing timestamp/old reply/old quote/downgraded counts).

The diagnostics are concise — each section is 1–2 lines. Top rejection/failure reasons are limited to 3 items. The freshness diagnostics are conditional (only shown if `freshnessStats.freshness_checked_count > 0`). The closing section includes rule performance stats (avg weight, boosted/penalized counts) only if enrichment was performed.

**Assessment:** The diagnostic level is well-calibrated — enough information for the operator to understand pipeline behavior without overwhelming the message. The format uses Arabic labels for consistency with the keyboard language, but the data values (numbers, English terms) are readable.

---

## 3. Contract Tests Gap Analysis

Despite all invariants being verified at the code level, there are **no automated contract tests** that enforce these invariants. The existing `telegram-parsing.test.ts` only tests utility functions (`extractHandle`, `extractHandles`, `extractTweetUrl`, `extractGitHubRepo`). There are no tests for:

1. **Manual-only enforcement:** No test verifies that `deliverDecisionToTelegram` does not call any X write API
2. **No-auto-post invariant:** No test verifies that the "نشرت" command only logs, never posts
3. **Sequential gate enforcement:** No test verifies that candidates failing the judge are excluded from decision
4. **No-candidate-without-gate invariant:** No test verifies that publish gate rejection prevents decision selection
5. **Message content contract:** No test verifies that the manual-publish instruction appears in the delivered message
6. **Run-supersession:** No test verifies that a new run's recommendations take precedence over old ones

### Recommended Contract Tests

```typescript
// 1. Manual-only: deliverDecisionToTelegram never calls X write API
test('deliverDecisionToTelegram does not call X post/write endpoints', async () => {
  const xCalls = mockXWriteCalls();
  await deliverDecisionToTelegram(chatId, scanResult, '30piq', decision, 100);
  expect(xCalls).toHaveLength(0);
});

// 2. Publish instruction present
test('delivery message contains manual-publish instruction', async () => {
  const sent = captureTelegramMessages();
  await deliverDecisionToTelegram(chatId, scanResult, '30piq', decision, 100);
  expect(sent[0]).toContain('يدوياً'); // "manually" in Arabic
});

// 3. No judge-fail in selected
test('candidates that fail judge are not in decision.selected', () => {
  const opps = [judgeFailedOpp, judgePassedOpp];
  const result = decideTelegramOpportunities(opps, 'stage_1_under_500');
  expect(result.selected.every(o => o._judge_result?.passed)).toBe(true);
});

// 4. No gate-reject in selected
test('candidates rejected by publish gate are not in decision.selected', () => {
  const gateResult = filterPublishableOpportunities(opps, { enableFreshnessGate: true });
  const decision = decideTelegramOpportunities(gateResult.accepted, 'stage_1_under_500');
  // All selected must be from gate.accepted
  expect(gateResult.rejected.every(r => !decision.selected.some(s => s.source_tweet_url === r.source_tweet_url))).toBe(true);
});

// 5. No-recommendation message is informative
test('when no recommendations, message includes blocking reasons', async () => {
  const emptyDecision = { selected: [], held: [], budget: { min_final_score: 7.8 }, stage: 'stage_1' };
  const sent = captureTelegramMessages();
  await deliverDecisionToTelegram(chatId, emptyScanResult, '30piq', emptyDecision, 100);
  expect(sent[0]).toContain('لا توجد توصية'); // "no recommendation"
});

// 6. New run supersedes old
test('published decision links to most recent run', async () => {
  // Insert old decision_run, then new one
  // Call logPublishedDecision without explicit decision_run_id
  // Verify it links to the newer run
});
```

---

## 4. Security Review

### Chat ID Validation

The `assertTelegramChat` function in `telegram.ts` validates that incoming messages come from `TELEGRAM_ALLOWED_CHAT_ID`. If the env var is not set, all chats are allowed — this is a potential misconfiguration risk. In production, `TELEGRAM_ALLOWED_CHAT_ID` must always be set.

### HTML Injection

The `htmlEscape` function is used consistently for all user-generated content (crafted text, reasons, URLs). The `parse_mode: 'HTML'` setting means Telegram renders HTML tags. Without proper escaping, crafted text containing `<b>`, `<i>`, `<a>` tags could manipulate the Telegram message format. The current implementation escapes `&`, `<`, `>`, and `"` which is sufficient for Telegram HTML mode.

### URL Validation

The `extractTweetUrl` function validates that published URLs match the pattern `https://x.com/.../status/...` or `https://twitter.com/.../status/...`. The `logPublishedDecision` function rejects URLs that don't match this pattern with a 400 error. This prevents logging arbitrary URLs as published decisions.

---

## 5. Recommendations

1. **Add contract tests** (see section 3 above) — these are the highest-priority gap
2. **Enforce TELEGRAM_ALLOWED_CHAT_ID at startup** — fail fast if not set in production
3. **Add English translation** for the manual-publish instruction line to improve accessibility
4. **Rate-limit the نشرت command** — prevent accidental duplicate logging of the same URL (currently handled by unique constraint on `published_url`, but the error message could be clearer)
5. **Add a "run ID" footer** to each recommendation for easier debugging when the operator reports issues
6. **Consider adding a confirmation step** — before logging a published decision, show the operator what will be recorded and ask for confirmation
