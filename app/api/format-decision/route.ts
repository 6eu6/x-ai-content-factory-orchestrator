import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { callModel } from '../../../lib/model-router';

const VERSION = 'format-decision-v2-model-router';

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function clampScore(value: any, fallback = 5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.round(n), 1), 10);
}

function safeFormat(value: any) {
  const allowed = new Set(['single_tweet', 'reply', 'quote', 'thread', 'article', 'github_repo', 'video', 'carousel', 'tool']);
  const format = String(value || '').trim();
  return allowed.has(format) ? format : 'single_tweet';
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 8), 1), 20);

    const [opportunities, viralPatterns, recentContent, recentDecisions] = await Promise.all([
      supabase.from('content_opportunities').select('*').in('status', ['candidate', 'selected']).order('priority_score', { ascending: false }).order('confidence_score', { ascending: false }).limit(limit),
      supabase.from('viral_account_patterns').select('*').order('confidence_score', { ascending: false }).limit(20),
      supabase.from('content_log').select('content_type,topic,final_text,publish_status,created_at').order('created_at', { ascending: false }).limit(30),
      supabase.from('content_format_decisions').select('selected_format,created_at').order('created_at', { ascending: false }).limit(20)
    ]);

    const opps = opportunities.data || [];
    if (!opps.length) {
      return Response.json({ ok: true, version: VERSION, decisions: [], note: 'No candidate content opportunities available. Run learning-cycle first.' });
    }

    const prompt = `You are the Content Format Decision Engine for @${optionalEnv('X_USERNAME', '30piq')}.
Niche: AI x Productivity x Career Growth. Account is early-stage, so avoid spammy links and risky overposting.

For each opportunity, choose the best production format from: single_tweet, reply, quote, thread, article, github_repo, video, carousel, tool.
Use this scoring logic:
- depth_score: how much substance exists
- freshness_score: how time-sensitive it is
- visual_score: how well it can be shown visually
- technical_score: code/repo/workflow depth
- uniqueness_score: how under-covered the angle is
- source_quality_score: credibility of sources
- viral_fit_score: fit with stored X mechanics
Rules:
- High depth + technical => thread, article, github_repo, or tool.
- High visual => video or carousel.
- High freshness but shallow => single_tweet or quote.
- Controversial or uncertain claims => quote/reply, not standalone post.
- Early account: minimize external links unless article/repo/tool is the actual asset.
- Do not copy creator patterns, only use mechanics.
Return strict JSON: {"decisions":[{"content_opportunity_id":"...","selected_format":"...","format_reason":"...","depth_score":1,"freshness_score":1,"visual_score":1,"technical_score":1,"uniqueness_score":1,"source_quality_score":1,"viral_fit_score":1,"low_follower_risk":"low|medium|high","expected_primary_signal":"reply|bookmark|dwell|profile_click|share|quote","expected_secondary_signal":"...","production_requirements":{"needs_sources":true,"needs_visual":false,"needs_repo":false,"needs_video_script":false,"notes":"..."}}]}
opportunities=${JSON.stringify(opps)}
viralPatterns=${JSON.stringify(viralPatterns.data || [])}
recentContent=${JSON.stringify(recentContent.data || [])}
recentDecisions=${JSON.stringify(recentDecisions.data || [])}`;

    const modelResponse = await callModel('format_decision', [
      { role: 'system', content: 'Choose content formats with strict reasoning. Return JSON only.' },
      { role: 'user', content: prompt }
    ]);

    const raw = JSON.parse(modelResponse || '{}');
    const decisions = asArray(raw.decisions).slice(0, limit);
    const inserted: any[] = [];

    for (const d of decisions) {
      const opportunityId = String(d.content_opportunity_id || '').trim();
      const opp = opps.find((o: any) => String(o.id) === opportunityId);
      if (!opp) continue;
      const row = {
        learning_cycle_id: opp.learning_cycle_id || null,
        content_opportunity_id: opportunityId,
        selected_format: safeFormat(d.selected_format),
        format_reason: d.format_reason || null,
        depth_score: clampScore(d.depth_score),
        freshness_score: clampScore(d.freshness_score),
        visual_score: clampScore(d.visual_score),
        technical_score: clampScore(d.technical_score),
        uniqueness_score: clampScore(d.uniqueness_score),
        source_quality_score: clampScore(d.source_quality_score),
        viral_fit_score: clampScore(d.viral_fit_score),
        low_follower_risk: ['low', 'medium', 'high'].includes(String(d.low_follower_risk)) ? d.low_follower_risk : 'medium',
        expected_primary_signal: d.expected_primary_signal || null,
        expected_secondary_signal: d.expected_secondary_signal || null,
        production_requirements: d.production_requirements || {},
        decision_payload: d,
        status: 'selected'
      };
      const { data, error } = await supabase.from('content_format_decisions').insert(row).select('*').single();
      if (!error && data) {
        inserted.push(data);
        await supabase.from('content_opportunities').update({
          selected_format: data.selected_format,
          format_decision_reason: data.format_reason,
          depth_score: data.depth_score,
          freshness_score: data.freshness_score,
          visual_score: data.visual_score,
          technical_score: data.technical_score,
          uniqueness_score: data.uniqueness_score,
          status: 'selected',
          updated_at: new Date().toISOString()
        }).eq('id', opportunityId);
      }
    }

    const log = await insertSessionLog({
      actions_completed: ['format_decision', VERSION, `decisions:${inserted.length}`],
      decisions_made: inserted,
      pending_tasks: inserted.map((x) => `Produce ${x.selected_format} for opportunity ${x.content_opportunity_id}`),
      next_recommendation: 'Run production-cycle or daily-run after format decisions exist.'
    });

    return Response.json({ ok: true, version: VERSION, inserted, raw, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
