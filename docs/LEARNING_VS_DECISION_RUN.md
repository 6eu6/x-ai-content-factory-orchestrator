# Learning Run vs Decision Run Design

## learning_run
- Scan wider (more accounts, more tweets)
- Collect patterns and update learning rules
- No Opus — use Sonnet/Haiku only
- No selected_candidate_crafting
- No publish_gate
- No Telegram spam
- Update source_quality_scores
- Cost: ~$0.01-0.05 per run (Sonnet-only)

## decision_run
- Current heavy pipeline run
- Opportunity intelligence (Opus)
- Crafting (Sonnet/Opus)
- Judge (Opus)
- Publish gate
- Telegram recommendation
- Cost: ~$0.10-0.30 per run

## Suggested schedule (Phase 2E.2+)
- learning_run: every 6 hours (4x/day)
- decision_run: manual trigger or 1x/day

## What should remain manual for now
- decision_run — should be manual until we have confidence in quality
- Any account additions/removals
- publish overrides

## Estimated cost controls
- learning_run: ~$0.05 * 4 = $0.20/day
- decision_run: ~$0.30 * 1 = $0.30/day
- Total: ~$0.50/day
