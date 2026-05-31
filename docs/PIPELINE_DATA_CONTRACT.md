# Pipeline Data Contract

This document defines the input/output contract for every pipeline stage.
Every stage must produce the fields listed below. Downstream stages must
tolerate missing optional fields without crashing.

---

## Common Return Shape

All stages return `TaskResult`:

```ts
{ ok: boolean; result: Record<string, any>; error?: string }
```

- **ok=true**: stage completed (even if result is empty / zero opportunities)
- **ok=false**: stage failed; `error` contains the message
- Empty result (`_opportunities: []`) is **ok=true**, not a failure

---

## 1. `load_account_state`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `username` | `task.payload.username` or `task.account_handle` or env `X_USERNAME` | yes |

### Output
| Field | Type | Notes |
|-------|------|-------|
| `username` | `string` | resolved X handle |
| `followers` | `number` | |
| `following` | `number` | |
| `tweets` | `number` | |

### Side Effects
- Upserts `account_state` table

### Safe Failure
- Returns `{ ok: false, error: err.message }`

---

## 2. `scan_account`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `account_handle` | `task.account_handle` or `task.payload.account_handle` | yes |
| `tweets_per_account` | `task.payload.tweets_per_account` | no (default 8) |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `account_handle` | `string` | yes | |
| `tweets_analyzed` | `number` | yes | |
| `viral_found` | `number` | yes | |
| `brain_updates` | `object` | yes | `{ algorithm_rules, style_patterns, media_patterns }` |
| `_analyzed_data` | `array` | yes | critical for merge step |
| `_media` | `array` | yes | |
| `_debug_log` | `array` | yes | |
| `empty_reason` | `string` | no | set when scan returned no viral content (not a failure) |
| `tweets_fetched` | `number` | no | Phase 2E.1 |
| `tweets_after_prefilter` | `number` | no | Phase 2E.1 |
| `tweets_selected_for_analysis` | `number` | no | Phase 2E.1 |
| `skipped_retweets` | `number` | no | Phase 2E.1 |
| `skipped_replies` | `number` | no | Phase 2E.1 |
| `skipped_low_engagement` | `number` | no | Phase 2E.1 |
| `skipped_off_niche` | `number` | no | Phase 2E.1 |
| `top_candidate_scores` | `array` | no | Phase 2E.1 |

### Safe Failure
- Missing handle → `{ ok: false, error: 'No account_handle...' }`
- API/network failure → `{ ok: false, error: err.message, result: { account_handle, is_transient } }`
- Legitimate empty (no viral content) → `{ ok: true, result: { ..., empty_reason: '...' } }`

---

## 3. `merge_scan_results`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_analyzed_data` | all `scan_account` results | yes |
| `_media` | all `scan_account` results | yes |
| `brain_updates` | all `scan_account` results | yes |
| `empty_reason` | all `scan_account` results | no |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `accounts_scanned` | `any` | yes | |
| `tweets_analyzed` | `number` | yes | |
| `viral_found` | `number` | yes | |
| `raw_opportunities` | `number` | yes | count |
| `brain_updates` | `object` | yes | |
| `media_downloaded` | `number` | yes | |
| **`_opportunities`** | **`array`** | **yes** | **Full ContentOpportunity[] — the primary data artifact** |
| `_debug_log` | `array` | yes | |
| `accounts_scanned_count` | `number` | no | Phase 2E.1 |
| `tweets_fetched_total` | `number` | no | Phase 2E.1 |
| `tweets_after_prefilter_total` | `number` | no | Phase 2E.1 |
| `tweets_selected_for_analysis_total` | `number` | no | Phase 2E.1 |
| `top_source_accounts` | `array` | no | Phase 2E.1 |
| `top_discovery_reasons` | `array` | no | Phase 2E.1 |
| `skipped_counts` | `object` | no | Phase 2E.1 |
| `empty_accounts` | `array` | no | handles + reasons |

### Safe Failure
- No completed scan_account tasks → `{ ok: false, error: 'No completed scan_account tasks found' }`
- DB error → `{ ok: false, error: ... }`

---

## 4. `opportunity_intelligence`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_opportunities` | `merge_scan_results` result | yes |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `raw_opportunity_count` | `number` | yes | |
| `intelligence_evaluated_count` | `number` | yes | |
| `intelligence_rejected_count` | `number` | yes | |
| `intelligence_selected_count` | `number` | yes | |
| `top_rejection_reasons` | `Record<string, number>` | yes | |
| `avg_publishability_score` | `number` | yes | |
| `avg_originality_potential_score` | `number` | yes | |
| `selected_briefs_count` | `number` | yes | |
| `selected_opportunities_count` | `number` | yes | |
| **`_opportunities`** | **`array`** | **yes** | **Selected opportunities enriched with `_brief`** |
| `_intelligence_summary` | `object` | no | |
| `duplicate_source_count` | `number` | no | Phase 2F.1 |
| `duplicate_source_opportunities_removed` | `number` | no | Phase 2F.1 |
| `rescue_attempted_count` | `number` | no | Phase 2D.4 |

### Opportunity `_brief` fields added
- `recommended_angle` (string)
- `audience_relevance` (string)
- `why_it_matters` (string)
- `do_not_claim` (string[])
- `content_format` (string: reply|quote|standalone)
- `source_summary` (string)
- `required_context` (string[])
- `niche_fit_score` (number 1-10)
- `originality_potential_score` (number 1-10)
- `publishability_score` (number 1-10)

### Safe Failure
- No opportunities → `{ ok: true, result: { raw_opportunity_count: 0, ..., _opportunities: [] } }`
- Exception → `{ ok: false, error: 'opportunity_intelligence failed: ...' }`

---

## 5. `enrich_opportunities`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_opportunities` | `opportunity_intelligence` result (primary) | yes |
| `_opportunities` | `merge_scan_results` result (fallback, only if intelligence task doesn't exist) | no |

**Fallback rule**: If intelligence task EXISTS and returned empty, that's intentional. Only fallback if it doesn't exist at all.

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enriched_opportunities` | `number` | yes | |
| `avg_weight` | `number` | yes | |
| `boosted_count` | `number` | yes | |
| `penalized_count` | `number` | yes | |
| `brief_recraft_count` | `number` | yes | Phase 2D.2 |
| `brief_recraft_failed` | `number` | yes | Phase 2D.2 |
| **`_opportunities`** | **`array`** | **yes** | **Enriched + recrafted opportunities** |
| `_rule_performance` | `object` | no | |
| `originality_context_used_count` | `number` | no | Phase 2G |
| `signature_voice_used_count` | `number` | no | Phase 2G.1 |
| `multi_candidate_generation_count` | `number` | no | Phase 2G.3 |
| `multi_candidate_variants_generated` | `string[]` | no | Phase 2G.3 |
| `multi_candidate_best_variant_counts` | `Record<string, number>` | no | Phase 2G.3 |

### Opportunity fields added
- `crafted_text` (updated by brief-faithful recrafting)
- `_brief_used_for_crafting` (boolean)
- `_brief_alignment_score` (number)
- `_brief_alignment_notes` (string[])
- `_invented_personal_experience_flag` (boolean)
- `_ignored_recommended_angle_flag` (boolean)
- `_originality_*` fields (Phase 2G)
- `_signature_voice_*` fields (Phase 2G.1)
- `_candidate_*` fields (Phase 2G.3)
- `_all_candidates` (CraftedCandidate[])
- `_selected_candidates` (CraftedCandidate[])

### Safe Failure
- No opportunities → `{ ok: true, result: { enriched_opportunities: 0, ..., _opportunities: [] } }`
- Exception → `{ ok: false, error: err.message }`

---

## 6. `quality_enhance`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_opportunities` | `enrich_opportunities` result (primary) | yes |
| `_opportunities` | `opportunity_intelligence` or `merge_scan_results` (fallback) | no |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `enhanced_count` | `number` | yes | |
| `rewrites_applied` | `number` | yes | |
| `numeric_rejected` | `number` | yes | |
| **`_opportunities`** | **`array`** | **yes** | **After clean → niche → brief gate → originality → numeric → validation** |
| `_quality_summary` | `object` | no | |
| `_numeric_guard_summary` | `object` | no | |
| `json_wrappers_cleaned` | `number` | no | Phase 2C |
| `off_niche_count` | `number` | no | Phase 2C |
| `validation_passed` | `number` | no | Phase 2C |
| `validation_failed` | `number` | no | Phase 2C |

### Opportunity fields modified
- `crafted_text` (possibly cleaned/rewritten)
- `shield_passed` (possibly set to false)
- `shield_issues` (possibly appended)
- `_brief_alignment_score`, `_brief_alignment_failed`, `pre_gate_rejection_reason`

### Safe Failure
- No opportunities → `{ ok: true, result: { enhanced_count: 0, ..., _opportunities: [] } }`
- Exception → `{ ok: false, error: err.message }`

---

## 7. `opportunity_judge`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_opportunities` | `quality_enhance` result (primary) | yes |
| `_opportunities` | `enrich_opportunities` / `opportunity_intelligence` / `merge_scan_results` (fallback chain) | no |
| `_brief` | each opportunity's `_brief` field | no |
| `_selected_candidates` | each opportunity's selected candidates | no |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `judge_passed_count` | `number` | yes | |
| `judge_failed_count` | `number` | yes | |
| `judge_failure_reasons` | `Record<string, number>` | yes | |
| `avg_final_candidate_score` | `number` | yes | |
| `avg_originality_score` | `number` | yes | |
| **`_opportunities`** | **`array`** | **yes** | **With judge results applied** |
| `_judge_summary` | `object` | no | |
| `near_pass_polish_attempted_count` | `number` | no | Phase 2F |
| `near_pass_polish_passed_count` | `number` | no | Phase 2F |
| `brief_locked_polish_attempted_count` | `number` | no | Phase 2G.2 |
| `brief_locked_polish_passed_count` | `number` | no | Phase 2G.2 |
| `multi_candidate_variants_judged` | `number` | no | Phase 2G.3 |
| `candidate_validation_failed_count` | `number` | no | Hotfix |
| `candidate_missing_text_count` | `number` | no | Hotfix |
| `judge_result_missing_count` | `number` | no | Hotfix |
| `multi_candidate_invalid_count` | `number` | no | Hotfix |
| `multi_candidate_empty_selected_count` | `number` | no | Hotfix |

### Opportunity fields added/modified
- `_judge_result` (object: passed, scores, failure_reasons)
- `shield_passed` (possibly set to false by judge)
- `shield_issues` (possibly appended with `judge_failed:*`)
- `_candidate_variant_type` (string, from best deduped candidate)
- `_candidate_local_score` (number)
- `_candidate_selection_reason` (string)
- `_selected_candidate_text_applied` (boolean, when best text was applied)
- `_candidate_generation_error` (string, when no valid candidate text)
- `_near_pass_polish_applied` (boolean)
- `_near_pass_polish_before_judge` / `_after_judge` (objects)
- `_brief_locked_polish_applied` (boolean)
- `_brief_locked_polish_before_judge` / `_after_judge` (objects)

### Official Text Rule
- Before judge: official text = selected candidate's `crafted_text` if present, else `opportunity.crafted_text`
- After judge: `opportunity.crafted_text` must match the judged best candidate
- After polish: `opportunity.crafted_text` must match `polished_text` if applied
- publish_gate must only use `opportunity.crafted_text`

### Safe Failure
- No opportunities → `{ ok: true, result: { judge_passed_count: 0, ..., _opportunities: [] } }`
- No valid candidates → `{ ok: true, result: { ..., _opportunities: [safely rejected...] } }`
- Exception → `{ ok: false, error: 'opportunity_judge failed: ...' }`

---

## 8. `publish_gate`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_opportunities` | `opportunity_judge` result (primary) | yes |
| `_opportunities` | `quality_enhance` / `enrich_opportunities` (fallback) | no |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `accepted` | `number` | yes | |
| `rejected` | `number` | yes | |
| `reasons` | `string[]` | yes | first 5 rejection reasons |
| **`_accepted`** | **`array`** | **yes** | **Opportunities that passed the gate** |
| `_rejected` | `array` | yes | Rejected opportunities |

### Safe Failure
- No opportunities → `{ ok: true, result: { accepted: 0, rejected: 0, reasons: [], _accepted: [], _rejected: [] } }`
- Exception → `{ ok: false, error: err.message }`

---

## 9. `decision`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_accepted` | `publish_gate` result | yes |
| `followers` | `load_account_state` result | no |
| `_rule_performance` | `enrich_opportunities` result | no |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `selected` | `number` | yes | |
| `held` | `number` | yes | |
| `min_final_score` | `number` | yes | |
| `stage` | `string` | yes | account stage |
| `followers` | `number` | yes | |
| **`_decision`** | **`object`** | **yes** | **`{ selected: [...], held: [...], budget, stage }`** |

### Safe Failure
- No accepted opportunities → selected=0, held=0
- Exception → `{ ok: false, error: err.message }`

---

## 10. `persist_decision`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_decision` | `decision` result | yes |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `decision_run_id` | `string` | no | DB row ID |
| `selected_count` | `number` | yes | |
| `held_count` | `number` | yes | |
| `_decision` | `object` | yes | carried through |

### Safe Failure
- No decision → `{ ok: false, error: 'No decision result found' }`
- DB insert failure → `{ ok: true, result: { decision_run_id: null, ... } }`

---

## 11. `telegram_delivery`

### Input
| Field | Source | Required |
|-------|--------|----------|
| `_decision` | `persist_decision` result | yes |
| Various stats | `merge_scan_results`, `opportunity_intelligence`, `opportunity_judge` | no |

### Output
| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `delivered` | `boolean` | yes | |
| `selected_count` | `number` | yes | |
| `chat_id` | `string` | no | |
| `reason` | `string` | no | if not delivered |

### Safe Failure
- notify_telegram=false → `{ ok: true, result: { delivered: false, reason: '...' } }`
- No decision → `{ ok: false, error: 'No decision result found...' }`

---

## Cross-Stage Rules

### Official Text Rule
The canonical text field is always `opportunity.crafted_text`:

1. **Before judge**: If `_selected_candidates` is present, the best candidate's `crafted_text` becomes `opportunity.crafted_text`. Otherwise, `opportunity.crafted_text` is used as-is.
2. **After judge**: `opportunity.crafted_text` must match the judged best candidate's text.
3. **After polish**: If polish was applied, `opportunity.crafted_text` must match `polished_text`.
4. **publish_gate**: Must only use `opportunity.crafted_text` — never raw candidate text directly.

### Safe Rejection Pattern
When a stage cannot process an opportunity (missing text, invalid data), it must:
1. Set `shield_passed = false`
2. Add a descriptive issue to `shield_issues` (e.g., `candidate_missing_crafted_text`)
3. Add a diagnostic field (e.g., `_candidate_generation_error`)
4. Never throw — return the safely rejected opportunity in the output array

### Downstream Tolerance
Every stage must handle:
- Missing optional fields → use defaults
- `null` or `undefined` in arrays → skip/filter
- Empty `crafted_text` → safely reject, don't crash
- Missing `_selected_candidates` → fall back to `opportunity.crafted_text`
- Missing `_brief` → use empty object `{}`
