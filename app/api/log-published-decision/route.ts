import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { extractTweetUrl } from '../../../lib/telegram';
import { resolveBrainRuleRefs } from '../../../lib/resolve-brain-rules';

const VERSION = 'log-published-decision-v2.1';

const VALID_CONTENT_TYPES = ['reply', 'quote', 'thread', 'single_tweet', 'article'];

export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const body = await req.json();
    const publishedUrl = String(body.published_url || '').trim();
    const decisionRunId = body.decision_run_id || null;
    const sourceTweetUrl = body.source_tweet_url || null;
    const contentType = body.content_type || null;
    const publishedText = body.published_text || null;
    const recommendationIndex = body.recommendation_index ? Number(body.recommendation_index) : null;

    // ── Validate published_url ──
    if (!publishedUrl) {
      return Response.json({ ok: false, error: 'published_url is required' }, { status: 400 });
    }

    const extractedUrl = extractTweetUrl(publishedUrl);
    if (!extractedUrl) {
      return Response.json({ ok: false, error: 'published_url must be a valid X/Twitter tweet URL (https://x.com/.../status/...)' }, { status: 400 });
    }

    // ── Validate content_type ──
    if (contentType && !VALID_CONTENT_TYPES.includes(contentType)) {
      return Response.json({ ok: false, error: `content_type must be one of: ${VALID_CONTENT_TYPES.join(', ')}` }, { status: 400 });
    }

    // ── Extract account_handle from URL ──
    const handleMatch = extractedUrl.match(/(?:x|twitter)\.com\/([^\s/]+)/i);
    const accountHandle = handleMatch ? handleMatch[1] : 'unknown';

    // ── Find decision_run if not provided ──
    let linkedDecisionRunId: string | null = decisionRunId || null;
    let linked = false;
    const warnings: string[] = [];

    if (!linkedDecisionRunId) {
      // Try to find the latest decision_run with selected_count > 0 within last 72h
      const username = optionalEnv('X_USERNAME', '30piq');
      const seventyTwoHoursAgo = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

      try {
        const { data: recentRuns } = await supabase
          .from('decision_runs')
          .select('id, selected_count, created_at')
          .gt('selected_count', 0)
          .gte('created_at', seventyTwoHoursAgo)
          .order('created_at', { ascending: false })
          .limit(5);

        if (recentRuns && recentRuns.length > 0) {
          linkedDecisionRunId = recentRuns[0].id;
          linked = true;
        } else {
          warnings.push('No recent decision_run with selected_count > 0 found in last 72 hours');
        }
      } catch (e: any) {
        warnings.push(`decision_runs query failed: ${e.message}`);
      }
    } else {
      linked = true;
    }

    // ── Get decision_score and brain_rules_used from linked run ──
    let decisionScore: number | null = null;
    let brainRulesUsed: any[] = [];
    let brainRulesResolved = false;

    if (linkedDecisionRunId) {
      try {
        const { data: runData } = await supabase
          .from('decision_runs')
          .select('decision_score, brain_rules_used, selected_payload')
          .eq('id', linkedDecisionRunId)
          .maybeSingle();

        if (runData) {
          decisionScore = runData.decision_score || null;
          brainRulesUsed = Array.isArray(runData.brain_rules_used) ? runData.brain_rules_used : [];

          // ── If recommendation_index provided, extract specific recommendation ──
          if (recommendationIndex && recommendationIndex >= 1) {
            const selectedPayload = Array.isArray(runData.selected_payload) ? runData.selected_payload : [];
            const rec = selectedPayload[recommendationIndex - 1];
            if (rec) {
              // Override content_type, source_tweet_url from recommendation if not already provided
              if (!contentType && rec.content_type) {
                // Use recommendation content_type
              }
              if (!sourceTweetUrl && rec.source_tweet_url) {
                // Will use rec.source_tweet_url
              }
              if (rec.decision_score) decisionScore = rec.decision_score;
              if (rec.score) decisionScore = rec.score;  // also check 'score' field in payload
              if (Array.isArray(rec.brain_rules_used) && rec.brain_rules_used.length > 0) {
                brainRulesUsed = rec.brain_rules_used;
              }
            } else {
              warnings.push(`recommendation_index ${recommendationIndex} out of range (selected_payload has ${selectedPayload.length} items)`);
            }
          }
        }
      } catch {}
    }

    // ── Resolve text-based brain_rules_used to IDs ──
    if (brainRulesUsed.length > 0) {
      try {
        const resolved = await resolveBrainRuleRefs(brainRulesUsed);
        if (resolved.length > 0) {
          brainRulesUsed = resolved.map(r => ({
            id: r.id,
            table: r.table,
            rule_preview: r.rule_preview
          }));
          brainRulesResolved = true;
        }
      } catch {}
    }

    // ── Insert into published_decisions ──
    const { data: inserted, error: insertError } = await supabase
      .from('published_decisions')
      .insert({
        decision_run_id: linkedDecisionRunId,
        account_handle: accountHandle,
        published_url: extractedUrl,
        published_text: publishedText,
        source_tweet_url: sourceTweetUrl,
        content_type: contentType,
        decision_score: decisionScore,
        brain_rules_used: brainRulesUsed,
        status: 'published',
        performance_checked_at: null,
        performance_payload: {},
        feedback_payload: {}
      })
      .select('id')
      .single();

    if (insertError) {
      // Handle duplicate URL
      if (insertError.message?.includes('unique') || insertError.message?.includes('duplicate')) {
        return Response.json({ ok: false, error: 'This published_url has already been registered', version: VERSION }, { status: 409 });
      }
      return Response.json({ ok: false, error: insertError.message, version: VERSION }, { status: 500 });
    }

    return Response.json({
      ok: true,
      version: VERSION,
      linked,
      published_decision_id: inserted?.id || null,
      recommendation_index: recommendationIndex || undefined,
      brain_rules_count: brainRulesUsed.length,
      brain_rules_resolved: brainRulesResolved || undefined,
      warning: warnings.length > 0 ? warnings.join('; ') : undefined
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
