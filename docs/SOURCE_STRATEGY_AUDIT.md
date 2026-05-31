# Source Strategy Audit — x-ai-content-factory-orchestrator

> **Project**: x-ai-content-factory-orchestrator
> **Target Account**: @30piq
> **Audit Date**: 2026-06-04
> **Method**: Static analysis of `lib/pipeline-queue.ts`, `lib/pipeline-worker.ts`, `lib/content-engine-v3.ts`, `lib/tweet-candidate-scorer.ts`, migration files, and `scripts/source-quality-audit.ts`
> **Scope**: Account selection logic, source pool health, category model, quality scoring, scan allocation

---

## 1. Executive Summary

The current source strategy for the x-ai-content-factory-orchestrator is **primitive and purely rotational**. Account selection depends on just two signals — `last_checked` (oldest-first rotation) and `tier` (lower tier = higher priority) — with no consideration for source quality, content category, historical yield, or exploration of new sources. The `source_quality_scores` table, created in the 2026-05-31 migration, exists in the database schema but is **not integrated into the selection pipeline** — it is only used by the offline `scripts/source-quality-audit.ts` script.

**Critical issues identified:**

- **Invalid handles waste scan slots**: Emoji handles, Arabic labels, and punctuation strings (e.g., "🔥", "أخبار", "AI/ML") exist in the `accounts` table and consume over-fetch capacity. The over-fetch formula (`min(max(accountLimit * 4, accountLimit + 10), 100)`) compensates for this, but invalid handles still appear in the candidate set before filtering, and the 100-row cap means heavily polluted source pools may not yield enough valid accounts.
- **No category-based allocation**: The `category` column was added in the 2026-05-27 alignment migration but remains mostly `NULL`. There is no category-weighted selection logic. Every account is treated identically regardless of whether it covers AI tools, digital culture, or internet business.
- **No performance feedback loop**: The pipeline has no mechanism to adjust scan frequency based on historical yield. An account that has produced zero opportunities across 10 scans receives the same priority as one that consistently generates publishable content.
- **No exploration/exploitation split**: The system never randomly samples from untested or low-tier accounts. All selection is deterministic based on rotation order, meaning potentially valuable sources outside the current rotation window may never be discovered.
- **No source cooldown or failure tracking**: Accounts that repeatedly fail API calls or produce empty timelines are not deprioritized. They continue consuming scan slots on every rotation.

**Proposed S1.4 Source Strategy** addresses all five gaps through weighted category allocation, source quality scoring integration, cooldown logic, failure tracking, and an experimental exploration quota. This document details the current state, proposed model, and implementation roadmap.

---

## 2. Current Account Selection Audit

### 2.1 Selection Logic — `createPipelineTasks` (pipeline-queue.ts)

The account selection pipeline operates in two stages:

**Stage 1: Database Query**

```typescript
const { data, error } = await supabase
  .from('accounts')
  .select('handle')
  .order('last_checked', { ascending: true, nullsFirst: true })
  .order('tier', { ascending: true })
  .limit(fetchLimit);
```

This fetches `fetchLimit` rows from the `accounts` table, ordered by:
1. `last_checked ASC, NULLS FIRST` — accounts that have never been checked, or were checked longest ago, appear first.
2. `tier ASC` — among accounts with the same `last_checked` value, lower-tier accounts are preferred (tier 1 before tier 2 before tier 3).

Only the `handle` column is selected. No category, followers, or quality data is fetched.

**Stage 2: Validation and Slicing — `selectValidAccounts`**

```typescript
const filtered = candidates.filter(account => {
  const handle = account.handle?.trim();
  if (!handle || !isValidXHandle(handle)) {
    excludedInvalidHandles.push(account.handle);
    return false;
  }
  return true;
});
const validAccounts = filtered.slice(0, accountLimit);
```

This filters out invalid handles and slices to `accountLimit`. If no valid accounts remain, it falls back to the configured username (`30piq`) if that handle is valid.

### 2.2 Handle Validation — `isValidXHandle` (pipeline-queue.ts)

```typescript
export const VALID_X_HANDLE_REGEX = /^[A-Za-z0-9_]{1,15}$/;

export function isValidXHandle(handle: string | null | undefined): boolean {
  if (!handle) return false;
  const trimmed = handle.trim();
  return trimmed.length > 0 && VALID_X_HANDLE_REGEX.test(trimmed);
}
```

The regex enforces X's actual handle constraints: 1-15 characters, only ASCII letters, digits, and underscores. This correctly rejects:
- Emoji handles (e.g., "🔥", "💡AI")
- Arabic/RTL text (e.g., "أخبار_تقنية")
- Punctuation/symbols (e.g., "AI/ML", "C++", "web3.io")
- Empty or whitespace-only handles

However, the guard is **reactive, not preventive** — invalid handles remain in the `accounts` table and continue to appear in query results, wasting over-fetch capacity on every run.

### 2.3 Over-Fetch Formula — `calculateFetchLimit`

```typescript
export function calculateFetchLimit(accountLimit: number): number {
  return Math.min(Math.max(accountLimit * 4, accountLimit + 10), 100);
}
```

For the default `accountLimit` of 10, this yields `min(max(40, 20), 100) = 40`. The 4x multiplier compensates for invalid handles that will be filtered out. However, the 100-row hard cap means that if the source pool is heavily polluted (>60% invalid handles with `last_checked = NULL`), valid accounts beyond row 100 may never be reached. This is a structural risk that grows as invalid handles accumulate.

### 2.4 Scan Configuration

| Parameter | Default | Configurable Via | Constraint |
|-----------|---------|-----------------|------------|
| `accountLimit` | 10 | `DAILY_SCAN_ACCOUNT_LIMIT` env var / `enqueuePipelineRun` options | 1-30 |
| `tweetsPerAccount` | 8 | `DAILY_SCAN_TWEETS_PER_ACCOUNT` env var / `enqueuePipelineRun` options | 1-25 |
| `fetchLimit` | 40 | Computed from `accountLimit` | Capped at 100 |

The configuration is static — there is no dynamic adjustment based on:
- Pipeline run outcomes (e.g., if all 10 accounts produce zero opportunities, increase `accountLimit` next run)
- Source pool health (e.g., skip accounts with known API failures)
- Time-of-day patterns (e.g., scan more during peak activity hours)

### 2.5 Worker-Side Handle Guard — `processScanAccount` (pipeline-worker.ts)

```typescript
if (!isValidXHandle(handle)) {
  return {
    ok: true,
    result: {
      account_handle: handle,
      tweets_analyzed: 0,
      viral_found: 0,
      _skipped_invalid_handle: true,
      _invalid_handle_reason: `Handle "${handle}" does not match valid X handle pattern...`,
    }
  };
}
```

The worker also validates handles before scanning. If an invalid handle somehow reaches the scan step (shouldn't happen due to `selectValidAccounts`, but serves as a safety net), it returns a successful result with zero metrics and a `_skipped_invalid_handle` flag. This is correct behavior — it doesn't fail the task, but it does waste a task slot in the pipeline run.

### 2.6 Identified Gaps

| Gap | Impact | Severity |
|-----|--------|----------|
| No category weighting | All source types scanned equally; no guarantee of niche coverage | HIGH |
| No performance feedback | High-yield sources scanned as often as zero-yield sources | HIGH |
| No source cooldown | Empty/failed accounts consume slots every rotation | MEDIUM |
| No failure tracking | Repeated API failures for same account waste resources and delay pipeline | MEDIUM |
| No exploration quota | New/unknown accounts never discovered outside rotation order | MEDIUM |
| Invalid handles in pool | Wastes over-fetch capacity and clutters selection | LOW (mitigated by filtering) |
| No dynamic adjustment | Fixed scan size regardless of source pool health or recent outcomes | LOW |

---

## 3. Proposed Account Category Model

### 3.1 Category Definitions

The following categories are designed to align with @30piq's content niche — AI-native operators, builders, productivity, digital leverage, and internet business. Each category represents a distinct content pillar that should be represented in every scan run.

| Category | Slug | Description | Example Handles |
|----------|------|-------------|-----------------|
| **Core AI / Tools** | `core_ai_tools` | AI tool creators, API providers, model makers, AI infrastructure companies | `@OpenAI`, `@AnthropicAI`, `@cursor_ai`, `@repaborhq` |
| **Builders / Founders** | `builders_founders` | Startup founders, indie hackers, product builders, ship-fast community | `@levelsio`, `@marclouvion`, `@dannypostmaa` |
| **Productivity / Work** | `productivity_work` | Productivity experts, workflow designers, automation advocates, PKM community | `@tiagoforte`, `@mattmireles`, `@neuron_evangelist` |
| **Creator / Growth** | `creator_growth` | Creator economy, audience building, content strategy, newsletter operators | `@dickiebush`, `@heyeaslo`, `@raborhansen` |
| **Digital Culture** | `digital_culture` | Digital behavior, attention economy, internet trends, tech culture commentary | `@daborhsky`, `@paborhgraham`, `@gaborhtanaka` |
| **Internet Business** | `internet_business` | SaaS, online business, revenue models, bootstrapping, solopreneurship | `@paborhquinn`, `@aborhschiff`, `@robaborhfitz` |
| **Experimental / Trend** | `experimental_trend` | Trending accounts, viral moments, cross-domain signals, newly discovered sources | Any unclassified account with high engagement |
| **Noisy / Unknown** | `noisy_unknown` | Low-quality or unclassified accounts — high tweet volume but low relevance or excessive noise | Accounts with >80% rejection rate |
| **Invalid** | `invalid` | Emoji handles, Arabic labels, punctuation, UI strings — not valid X handles | "🔥", "أخبار", "AI/ML" |

### 3.2 Category Assignment Logic

Categories should be assigned through a combination of:

1. **Manual curation** for the top 20-30 core accounts (handles that are well-known and clearly belong to a category)
2. **Heuristic classification** for the remaining accounts based on:
   - `NICHE_KEYWORDS` matching in recent tweet content (from `viral_tweet_analyses`)
   - Bio/description keywords (if available from `account_state`)
   - Follower count heuristics (e.g., accounts with >500K followers are more likely `core_ai_tools` or `digital_culture`)
3. **Fallback to `noisy_unknown`** for accounts that cannot be classified by any heuristic
4. **Automatic `invalid` classification** for handles that fail `isValidXHandle()`

### 3.3 Category Column Migration

The `category` column already exists on the `accounts` table (added in the 2026-05-27 alignment migration as `TEXT`). No schema change is needed — only data population. The proposed SQL in Section 7 handles this.

---

## 4. Proposed Daily Scan Allocation

### 4.1 Allocation Framework

For a default run of 10 accounts, the proposed allocation ensures every content pillar is represented:

| Category | Allocation | Accounts (of 10) | Rationale |
|----------|-----------|-------------------|-----------|
| Core AI / Tools + Builders / Founders | 40% | 4 | @30piq's primary niche — AI-native operators and builders. These sources produce the most on-brand content. |
| Startups / Operators / Internet Business | 25% | 2-3 | Business-model content and operator insights. Secondary but important for audience relevance. |
| Creator / Digital Culture | 20% | 2 | Audience-building and cultural signals. Important for timeliness and shareability. |
| Experimental / Trend | 10% | 1 | Discovery of new viral moments and cross-domain signals. Keeps content fresh. |
| Random Exploration | 5% | 0-1 | Pure random sampling from the full pool (including accounts not recently scanned). Discovers unexpected high-value sources. |

### 4.2 Allocation Implementation

The allocation should be implemented as a weighted random selection within each category bucket:

1. Fetch accounts grouped by `category`
2. Within each category, order by `last_checked ASC NULLS FIRST` (preserving existing rotation logic)
3. Select the allocated number of accounts from each bucket
4. For the exploration quota, select a random account from the full pool that was not already selected
5. If a category bucket is empty (e.g., no `core_ai_tools` accounts remain unchecked), redistribute its slots to the next-highest-priority category

### 4.3 Fallback Behavior

If the source pool is too small or too polluted to fill all allocated slots:
- First, redistribute within the same priority tier (e.g., if `builders_founders` is empty, add another `core_ai_tools` account)
- Then, fall back to any valid account in rotation order
- Finally, fall back to the configured username as a last resort (existing behavior preserved)

### 4.4 Dynamic Adjustment (Future)

Once source quality scoring is integrated (Section 5), the allocation percentages can be dynamically adjusted:
- If `core_ai_tools` sources consistently produce high-yield opportunities, increase their allocation
- If `creator_growth` sources have declining yield, decrease their allocation
- This creates a feedback loop between scan outcomes and source strategy

---

## 5. Source Quality Scoring Proposal

### 5.1 Existing Infrastructure

The `source_quality_scores` table already exists, created in the 2026-05-31 migration:

```sql
CREATE TABLE IF NOT EXISTS source_quality_scores (
  source_handle TEXT PRIMARY KEY,
  scans_count INT DEFAULT 0,
  tweets_analyzed INT DEFAULT 0,
  raw_opportunities_count INT DEFAULT 0,
  selected_count INT DEFAULT 0,
  rescued_count INT DEFAULT 0,
  judge_passed_count INT DEFAULT 0,
  publish_gate_accepted_count INT DEFAULT 0,
  rejection_reason_counts JSONB DEFAULT '{}',
  avg_publishability_score NUMERIC DEFAULT 0,
  avg_originality_potential_score NUMERIC DEFAULT 0,
  avg_niche_fit_score NUMERIC DEFAULT 0,
  avg_usefulness_score NUMERIC DEFAULT 0,
  opportunity_yield_rate NUMERIC DEFAULT 0,
  selected_rate NUMERIC DEFAULT 0,
  rejection_rate NUMERIC DEFAULT 0,
  source_quality_score NUMERIC DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

This table is well-designed for the proposed scoring model. However, it is currently only populated by the offline `scripts/source-quality-audit.ts` script and is **not referenced by any pipeline code** during account selection or scan execution.

### 5.2 Proposed Integration Points

The quality scores should be integrated at three points in the pipeline:

**Point 1: Account Selection (pipeline-queue.ts)**

Join `accounts` with `source_quality_scores` during the candidate fetch query. Use `source_quality_score` as a tiebreaker when `last_checked` and `tier` are equal, and as a multiplier for scan frequency:

```sql
SELECT a.handle, a.category, a.tier, a.last_checked,
       COALESCE(s.source_quality_score, 0.5) AS quality
FROM accounts a
LEFT JOIN source_quality_scores s ON a.handle = s.source_handle
WHERE a.active = true
ORDER BY last_checked ASC NULLS FIRST, tier ASC, quality DESC
LIMIT $fetchLimit;
```

Higher-quality sources should be scanned more frequently. This can be achieved by adjusting the `last_checked` timestamp weighting — a source with quality > 0.7 gets a virtual "last_checked" that is older than its actual value, making it appear earlier in the rotation.

**Point 2: Post-Scan Score Update (pipeline-worker.ts)**

After each `scan_account` task completes, update the `source_quality_scores` row for the scanned account:

```typescript
// Increment scans_count
// Add tweets_analyzed to the running total
// Add raw_opportunities_count if opportunities were found
// Add selected_count / judge_passed_count / publish_gate_accepted_count from downstream results
// Recalculate opportunity_yield_rate, selected_rate, rejection_rate
// Recalculate source_quality_score as weighted composite
```

**Point 3: Pipeline Run Summary (pipeline-queue.ts)**

At the end of each pipeline run (in `finalizeRunIfReady`), aggregate the per-source quality updates and log a summary of which sources contributed opportunities and which were unproductive.

### 5.3 Source Quality Score Formula

The composite `source_quality_score` should be calculated as:

```
source_quality_score = (
  opportunity_yield_rate * 0.30 +
  selected_rate * 0.25 +
  avg_niche_fit_score / 10 * 0.20 +
  avg_publishability_score / 10 * 0.15 +
  avg_originality_potential_score / 10 * 0.10
) * (1 - rejection_rate * 0.5)
```

This formula:
- Weights yield rate most heavily (30%) — the most direct signal of source value
- Weights selection rate second (25%) — measures how often raw opportunities survive to publication
- Includes niche fit (20%), publishability (15%), and originality (10%) as quality signals
- Penalizes high rejection rates — sources that produce opportunities that always get rejected are lower value
- All component scores are normalized to 0-1 range, so the composite is also 0-1

### 5.4 Source Cooldown

Accounts that produce nothing useful for N consecutive scans should be temporarily deprioritized:

- **Cooldown threshold**: 3 consecutive scans with `raw_opportunities_count = 0` OR `rejection_rate > 0.9`
- **Cooldown duration**: Skip the account for the next 5 pipeline runs
- **Cooldown implementation**: Add a `cooldown_until TIMESTAMPTZ` column to `accounts`, or track in `source_quality_scores` via a `cooldown_until` field
- **Cooldown override**: If the account's `last_checked` is >7 days old, break cooldown and scan anyway (prevents stale data)

### 5.5 Source Failure Tracking

Track API failures per handle to avoid wasting scan slots on accounts that consistently fail:

- Add `api_failure_count INT DEFAULT 0` and `last_api_failure_at TIMESTAMPTZ` to `source_quality_scores`
- Increment on `AccountScanError` in `processScanAccount`
- If `api_failure_count >= 3` and `last_api_failure_at` is within the last 24 hours, skip the account
- Reset `api_failure_count` to 0 on a successful scan

### 5.6 Source Noise Suppression

Accounts with high rejection rates (>80%) should be downgraded:

- Move `category` to `noisy_unknown`
- Reduce their scan frequency by setting a higher virtual `last_checked` value
- After 5 consecutive noisy scans, apply cooldown (Section 5.4)
- If quality improves (rejection_rate drops below 50% for 3 consecutive scans), restore original category

---

## 6. Source Experimental Quota

### 6.1 Purpose

The experimental quota ensures the system continuously discovers new high-value sources rather than exclusively scanning the same accounts in rotation. Without exploration, the source pool becomes stagnant and may miss emerging voices or trend shifts.

### 6.2 Quota Allocation

- **5% of scan slots** (1 account in a 10-account run, rounded up) are reserved for random exploration
- Exploration accounts are selected by:
  1. Random sampling from the full `accounts` table
  2. Excluding accounts already selected for this run
  3. Preferring accounts with `last_checked IS NULL` or `last_checked > 7 days ago`
  4. Preferring accounts without `source_quality_scores` rows (never scored = never systematically evaluated)

### 6.3 Auto-Promotion: Experimental → Core

An experimental account is auto-promoted when its quality metrics exceed the promotion threshold:

```
Promotion conditions (ALL must be true):
- scans_count >= 3
- opportunity_yield_rate >= 0.15
- selected_rate >= 0.10
- source_quality_score >= 0.40
- category != 'invalid'
```

When promoted:
- Update `category` from `experimental_trend` or `noisy_unknown` to the appropriate niche category
- Set `tier` to 2 (standard priority)
- Log the promotion event for audit

### 6.4 Auto-Demotion: Core → Experimental

A core account is auto-demoted when its quality metrics decline:

```
Demotion conditions (ANY must be true):
- rejection_rate >= 0.85 over last 5 scans
- opportunity_yield_rate = 0 over last 5 scans
- source_quality_score < 0.15 over last 5 scans
- api_failure_count >= 3 in last 24 hours
```

When demoted:
- Move `category` to `noisy_unknown` or `experimental_trend`
- Increase `tier` to 3 (lower priority)
- Apply cooldown for 5 runs
- Log the demotion event for audit

### 6.5 Exploration Logging

Every exploration scan should be logged to a `source_exploration_log` table (new) with:
- `source_handle`
- `run_id`
- `discovered_via` ('random_exploration')
- `initial_quality_score` (set after first scan)
- `promotion_status` ('pending', 'promoted', 'demoted', 'neutral')

This provides an audit trail for the exploration system and helps evaluate whether the 5% quota is producing value.

---

## 7. Proposed SQL for Source Pool Cleanup

> **WARNING**: The SQL statements below are NON-DESTRUCTIVE. They only UPDATE and classify existing data. No rows are deleted. Do not execute without explicit approval and a database backup.

The full SQL file is located at `docs/sql/proposed_source_pool_cleanup.sql` and contains:

1. **Classify invalid handles** — Set `category = 'invalid'` for handles that fail `isValidXHandle` regex
2. **Update null categories** — Heuristic assignment based on existing notes/followers data
3. **Flag noisy accounts** — Identify high-rejection-rate accounts
4. **Update tiers based on follower count** — Assign tier 1 for >100K followers, tier 2 for 10K-100K, tier 3 for <10K
5. **Add cooldown_until column** — For source cooldown support (Section 5.4)
6. **Add exploration tracking columns** — For experimental quota support (Section 6)

See the SQL file for exact statements.

---

## 8. Implementation Roadmap for S1.4

### Phase 1: Categorize Existing Accounts (Priority: HIGH, Effort: LOW)

**Goal**: Populate the `category` column for all accounts in the source pool.

**Steps**:
1. Run the proposed `proposed_source_pool_cleanup.sql` to classify invalid handles and update null categories
2. Manually review and correct the top 30 accounts by assigning them to the correct category
3. Verify classification accuracy by sampling 20 accounts across categories
4. Add `category` to the `select` clause in `createPipelineTasks` for downstream use

**Acceptance criteria**: >90% of valid handles have a non-null, non-`noisy_unknown` category.

### Phase 2: Add Source Quality Scores Integration (Priority: HIGH, Effort: MEDIUM)

**Goal**: Make `source_quality_scores` a live part of the pipeline, not just an offline audit tool.

**Steps**:
1. Add a `updateSourceQualityScore(handle, scanResult)` function to `pipeline-worker.ts` or a new `lib/source-quality-tracker.ts`
2. Call it from `processScanAccount` after a successful scan
3. Call it from `processMergeScanResults` with aggregated results per source
4. Call it from `processPublishGate` with rejection/acceptance counts per source
5. Add the `source_quality_scores` JOIN to the candidate fetch query in `createPipelineTasks`
6. Use `source_quality_score` as a tiebreaker/weight in selection ordering

**Acceptance criteria**: Every pipeline run updates `source_quality_scores` for all scanned accounts; selection query uses quality as a factor.

### Phase 3: Implement Weighted Category Allocation (Priority: MEDIUM, Effort: MEDIUM)

**Goal**: Replace the single rotation-ordered query with category-bucketed selection.

**Steps**:
1. Refactor `createPipelineTasks` to accept a `categoryAllocation` config (defaulting to the percentages in Section 4)
2. Fetch accounts grouped by category, ordered by `last_checked ASC NULLS FIRST, quality DESC` within each group
3. Select the allocated number from each category bucket
4. Handle bucket exhaustion by redistributing unfilled slots to other categories
5. Add the random exploration selection (Section 6)
6. Preserve the existing `selectValidAccounts` / `isValidXHandle` filtering as a post-selection step

**Acceptance criteria**: Every pipeline run includes accounts from at least 3 distinct categories; no single category exceeds 50% of selected accounts.

### Phase 4: Add Cooldown and Failure Tracking (Priority: MEDIUM, Effort: LOW)

**Goal**: Prevent wasted scan slots on unproductive or failing accounts.

**Steps**:
1. Add `cooldown_until` column to `accounts` or `source_quality_scores`
2. Add `api_failure_count` and `last_api_failure_at` columns to `source_quality_scores`
3. Update `processScanAccount` to increment failure counters on `AccountScanError`
4. Update `processScanAccount` to reset failure counters on successful scan
5. Add cooldown check to the candidate fetch query: `WHERE cooldown_until IS NULL OR cooldown_until < NOW()`
6. Apply cooldown after 3 consecutive zero-yield scans or high rejection rates
7. Add cooldown override for accounts with `last_checked > 7 days` (stale data is worse than potential zero-yield)

**Acceptance criteria**: Accounts with 3+ consecutive zero-yield scans are automatically skipped for 5 runs; accounts with 3+ API failures in 24h are skipped.

### Phase 5: Add Experimental Quota and Auto-Promotion (Priority: LOW, Effort: MEDIUM)

**Goal**: Continuously discover new high-value sources and maintain source pool health.

**Steps**:
1. Create `source_exploration_log` table
2. Add exploration quota selection to `createPipelineTasks` (5% of slots, random sampling)
3. Implement auto-promotion logic: after 3+ scans, if quality thresholds are met, update category and tier
4. Implement auto-demotion logic: after 5+ consecutive poor scans, downgrade category and tier
5. Add promotion/demotion events to pipeline run logs
6. Build a `/api/source-strategy-report` endpoint for monitoring category health, exploration outcomes, and promotion/demotion activity

**Acceptance criteria**: Each pipeline run includes at least 1 exploration account; auto-promotion triggers correctly when thresholds are met; auto-demotion triggers correctly for consistently poor sources.

---

## Appendix A: Key Code References

| Module | Key Functions | Relevance |
|--------|--------------|-----------|
| `lib/pipeline-queue.ts` | `createPipelineTasks`, `selectValidAccounts`, `isValidXHandle`, `calculateFetchLimit`, `enqueuePipelineRun` | Account selection and validation — the core of source strategy |
| `lib/pipeline-worker.ts` | `processScanAccount`, `processMergeScanResults` | Where quality data should be captured and where invalid handle guard is applied |
| `lib/content-engine-v3.ts` | `scanSingleAccountForPipeline`, `mergeAndDiscoverOpportunities` | Per-account scan logic and opportunity discovery — produces the metrics that should feed quality scoring |
| `lib/tweet-candidate-scorer.ts` | `scoreAndPrefilterTweets`, `NICHE_KEYWORDS` | Tweet-level prefiltering — `NICHE_KEYWORDS` can be reused for category classification heuristics |
| `scripts/source-quality-audit.ts` | Source quality audit script | Currently the only consumer of `source_quality_scores` — needs to be replaced by live pipeline integration |
| `supabase-migrations/2026-05-31_source_quality_scores.sql` | Table schema | Schema for `source_quality_scores` — already exists but needs additional columns for cooldown/failure tracking |

## Appendix B: Accounts Table Schema

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | UUID PK | auto | |
| `handle` | TEXT NOT NULL UNIQUE | | The X handle — should match `/^[A-Za-z0-9_]{1,15}$/` |
| `username` | TEXT | | Often NULL or same as handle |
| `tier` | INTEGER | 2 | 1=high, 2=standard, 3=low — currently underutilized |
| `active` | BOOLEAN | true | Not used in selection queries |
| `notes` | TEXT | | Often contains "Followers: N, Scanned: timestamp" |
| `category` | TEXT | NULL | Added by alignment migration — mostly NULL |
| `followers` | INTEGER | NULL | Added by alignment migration — partially populated |
| `avg_engagement` | NUMERIC | NULL | Added by alignment migration — rarely populated |
| `our_reply_count` | INTEGER | 0 | Added by alignment migration |
| `last_reply_date` | TIMESTAMPTZ | NULL | Added by alignment migration |
| `last_checked` | TIMESTAMPTZ | NULL | Primary ordering column for selection |
| `discovered_at` | TIMESTAMPTZ | NULL | |
| `last_scanned_at` | TIMESTAMPTZ | NULL | Not used in selection queries |
| `created_at` | TIMESTAMPTZ | auto | |
| `updated_at` | TIMESTAMPTZ | auto | |

## Appendix C: source_quality_scores Table Schema

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `source_handle` | TEXT PK | | Logically references `accounts.handle` but no FK |
| `scans_count` | INT | 0 | Number of times this source has been scanned |
| `tweets_analyzed` | INT | 0 | Total tweets analyzed across all scans |
| `raw_opportunities_count` | INT | 0 | Total raw opportunities discovered |
| `selected_count` | INT | 0 | Opportunities that passed initial selection |
| `rescued_count` | INT | 0 | Opportunities rescued by near-pass polish |
| `judge_passed_count` | INT | 0 | Opportunities that passed the judge |
| `publish_gate_accepted_count` | INT | 0 | Opportunities that passed publish gate |
| `rejection_reason_counts` | JSONB | '{}' | Breakdown of rejection reasons |
| `avg_publishability_score` | NUMERIC | 0 | Average publishability across opportunities |
| `avg_originality_potential_score` | NUMERIC | 0 | Average originality across opportunities |
| `avg_niche_fit_score` | NUMERIC | 0 | Average niche fit across opportunities |
| `avg_usefulness_score` | NUMERIC | 0 | Average usefulness across opportunities |
| `opportunity_yield_rate` | NUMERIC | 0 | raw_opportunities / tweets_analyzed |
| `selected_rate` | NUMERIC | 0 | selected_count / raw_opportunities_count |
| `rejection_rate` | NUMERIC | 0 | 1 - (publish_gate_accepted / raw_opportunities) |
| `source_quality_score` | NUMERIC | 0 | Composite quality score (proposed formula in Section 5.3) |
| `updated_at` | TIMESTAMPTZ | NOW() | |
