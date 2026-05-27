import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { extractTweetUrl } from '../../../lib/telegram';
import { resolveBrainRuleRefs } from '../../../lib/resolve-brain-rules';

const VERSION = 'log-published-decision-v2.2';

const VALID_CONTENT_TYPES = ['reply', 'quote', 'thread', 'single_tweet', 'article'];

function normalizeContentType(value: any): string | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw === 'tweet') return 'single_tweet';
  if (raw === 'repo_tweet') return 'single_tweet';
  return raw;
}

function numericScoreFromRecommendation(rec: any): number | null {
  const candidates = [
    rec?.decision_score?.final_score,
    rec?.decision_score,
    rec?.score,
    rec?.final_score
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const body = await req.json();
    const publishedUrl = String(body.published_url || '').trim();
    const decisionRunId = body.decision_run_id || null;
    let resolvedSourceTweetUrl: string | null = body.source_tweet_url || null;
    let resolvedContentType: string | null = normalizeContentType(body.content_type);
    let resolvedPublishedText: string | null = body.published_text || null;
    const recommendationIndex = body.recommendation_index ? Number(body.recommendation_index) : null;

    // ── Validate published_url ──
    if (!publishedUrl) {
      return Response.json({ ok: false, error: 'published_url is required' }, { status: 400 });
    }

    const extractedUrl = extractTweetUrl(publishedUrl);
    if (!extractedUrl) {
      return Response.json({ ok: false, error: 'published_url must be a valid X/Twitter tweet URL (https://x.com/.../status/...)' }, { status: 400 });
    }

    // ── Validate explicit content_type ──
    if (resolvedContentType && !VALID_CONTENT_TYPES.includes(resolvedContentType)) {
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
    let recommendationLinked = false;

    if (linkedDecisionRunId) {
      try {
        const { data: runData } = await supabase
          .from('decision_runs')
          .select('decision_score, brain_rules_used, selected_payload')
          .eq('id', linkedDecisionRunId)
          .maybeSingle();

        if (runData) {
          const runScore = Number(runData.decision_score);
          decisionScore = Number.isFinite(runScore) ? runScore : null;
          brainRulesUsed = Array.isArray(runData.brain_rules_used) ? runData.brain_rules_used : [];

          // ── If recommendation_index provided, extract that exact recommendation ──
          if (recommendationIndex && recommendationIndex >= 1) {
            const selectedPayload = Array.isArray(runData.selected_payload) ? runData.selected_payload : [];
            const rec = selectedPayload[recommendationIndex - 1];
            if (rec) {
              recommendationLinked = true;

              if (!resolvedContentType) {
                resolvedContentType = normalizeContentType(rec.content_type || rec.type);
              }

              if (!resolvedSourceTweetUrl && rec.source_tweet_url) {
                resolvedSourceTweetUrl = String(rec.source_tweet_url);
              }

              if (!resolvedPublishedText && rec.crafted_text) {
                resolvedPublishedText = String(rec.crafted_text);
              }

              const recScore = numericScoreFromRecommendation(rec);
              if (recScore !== null) decisionScore = recScore;

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

    // Validate inferred content_type after recommendation extraction
    if (resolvedContentType && !VALID_CONTENT_TYPES.includes(resolvedContentType)) {
      warnings.push(`Inferred content_type '${resolvedContentType}' is not valid; storing null instead`);
      resolvedContentType = null;
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
        published_text: resolvedPublishedText,
        source_tweet_url: resolvedSourceTweetUrl,
        content_type: resolvedContentType,
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
      recommendation_linked: recommendationLinked || undefined,
      published_decision_id: inserted?.id || null,
      recommendation_index: recommendationIndex || undefined,
      content_type: resolvedContentType || undefined,
      source_tweet_url: resolvedSourceTweetUrl || undefined,
      decision_score: decisionScore ?? undefined,
      brain_rules_count: brainRulesUsed.length,
      brain_rules_resolved: brainRulesResolved || undefined,
      warning: warnings.length > 0 ? warnings.join('; ') : undefined
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
