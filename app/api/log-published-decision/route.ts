import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin } from '../../../lib/supabase';
import { extractTweetUrl } from '../../../lib/telegram';

const VERSION = 'log-published-decision-v1';

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

    if (linkedDecisionRunId) {
      try {
        const { data: runData } = await supabase
          .from('decision_runs')
          .select('decision_score, brain_rules_used')
          .eq('id', linkedDecisionRunId)
          .maybeSingle();

        if (runData) {
          decisionScore = runData.decision_score || null;
          brainRulesUsed = Array.isArray(runData.brain_rules_used) ? runData.brain_rules_used : [];
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
        performance_payload: {}
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
      warning: warnings.length > 0 ? warnings.join('; ') : undefined
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
