import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'launch-content-repair-v1';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function clean(value: any) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function qualitySingle(text: string) {
  const reasons: string[] = [];
  if (!text || text.length < 60) reasons.push('too_short');
  if (text.length > 260) reasons.push('over_260_chars');
  if (!/github\.com\//i.test(text)) reasons.push('missing_repo_link');
  if (/what do you think|share your thoughts|rt if|let's discuss/i.test(text)) reasons.push('generic_engagement_bait');
  if (/revolutionize|cutting-edge|game-changing|unlock|seamless/i.test(text)) reasons.push('generic_ai_voice');
  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
}

function qualityThread(items: string[]) {
  const reasons: string[] = [];
  if (items.length < 5 || items.length > 8) reasons.push('thread_should_be_5_to_8_items');
  if (items.some((x) => x.length > 280)) reasons.push('thread_item_over_280_chars');
  if (items.some((x) => /^thread\b|^🧵/i.test(x))) reasons.push('generic_thread_opener');
  if (items.some((x) => /what do you think|share your thoughts|rt if|let's discuss/i.test(x))) reasons.push('generic_engagement_bait');
  if (!items.some((x) => /github\.com\//i.test(x))) reasons.push('missing_repo_link');
  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const cardId = url.searchParams.get('card_id');
    const repoUrl = url.searchParams.get('repo_url');

    let query = supabase
      .from('content_production_cards')
      .select('*')
      .eq('status', 'needs_review')
      .in('production_type', ['single_tweet', 'thread'])
      .order('created_at', { ascending: false })
      .limit(6);
    if (cardId) query = query.eq('id', cardId);
    if (repoUrl) query = query.contains('source_urls', [repoUrl]);
    const { data: cards, error: cardsError } = await query;
    if (cardsError) throw cardsError;
    if (!cards?.length) return Response.json({ ok: true, version: VERSION, repaired: 0, note: 'No launch cards need repair.' });

    const [growthRules, stylePatterns, mcp, algRules, viralPatterns] = await Promise.all([
      supabase.from('system_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(30),
      supabase.from('viral_style_patterns').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(30),
      supabase.from('mcp_opportunity_map').select('*').eq('status', 'active').order('priority_score', { ascending: false }).limit(20),
      supabase.from('x_algorithm_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(40),
      supabase.from('viral_account_patterns').select('*').order('confidence_score', { ascending: false }).limit(20)
    ]);

    const repaired: any[] = [];

    for (const card of cards) {
      const prompt = `Repair this X launch content for @${optionalEnv('X_USERNAME', '30piq')}.
Niche: AI x Productivity x Career Growth.
The goal is not promotion. The goal is useful, original, technical credibility that can earn real interaction.
Rules:
- English only.
- Single tweet <= 260 chars including repo link.
- Thread must be 5-8 tweets, each <= 280 chars.
- No generic engagement bait.
- No hype words.
- Link once.
- Make it useful even without clicking.
- If mentioning a repo, frame it as a small practical artifact, not a big claim.
Return strict JSON:
{"production_type":"single_tweet|thread","final_text":"...","thread_items":["..."],"viral_mechanic":"...","original_angle":"...","audience_pain":"...","quality_basis":"..."}
Card=${JSON.stringify(card)}
SystemLearningRules=${JSON.stringify(growthRules.data || [])}
XAlgorithmRules=${JSON.stringify(algRules.data || [])}
ViralStylePatterns=${JSON.stringify(stylePatterns.data || [])}
ViralAccountPatterns=${JSON.stringify(viralPatterns.data || [])}
McpOpportunities=${JSON.stringify(mcp.data || [])}`;

      const completion = await client().chat.completions.create({
        model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
        temperature: 0.08,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Repair launch content to pass strict X quality gates. JSON only.' },
          { role: 'user', content: prompt }
        ]
      });
      const raw = parseModelJson(completion.choices[0]?.message?.content || '');
      const type = raw.production_type === 'thread' ? 'thread' : card.production_type;
      const finalText = type === 'single_tweet' ? clean(raw.final_text) : null;
      const threadItems = type === 'thread' ? asArray(raw.thread_items).map(clean).filter(Boolean) : [];
      const quality = type === 'thread' ? qualityThread(threadItems) : qualitySingle(finalText || '');

      const { data, error } = await supabase.from('content_production_cards').update({
        production_type: type,
        final_text: finalText,
        thread_items: threadItems,
        viral_mechanic: raw.viral_mechanic || card.viral_mechanic,
        original_angle: raw.original_angle || card.original_angle,
        audience_pain: raw.audience_pain || card.audience_pain,
        quality_basis: raw.quality_basis || card.quality_basis,
        quality_status: quality.status,
        quality_reasons: quality.reasons,
        publish_status: quality.status,
        status: quality.status === 'ready' ? 'ready' : 'needs_review',
        reflection_notes: { ...(card.reflection_notes || {}), repaired_by: VERSION, repaired_at: new Date().toISOString(), previous_reasons: card.quality_reasons || [] },
        updated_at: new Date().toISOString()
      }).eq('id', card.id).select('*').single();
      if (error) throw error;
      repaired.push(data);
    }

    const log = await insertSessionLog({
      actions_completed: ['launch_content_repair', VERSION, `cards:${repaired.length}`, `ready:${repaired.filter((c) => c.quality_status === 'ready').length}`],
      content_created: repaired,
      pending_tasks: repaired.filter((c) => c.quality_status === 'ready').map((c) => `Review ${c.production_type} manually before any real posting.`),
      next_recommendation: 'Keep content in trial mode until production strategy and cleanup are complete.'
    });

    return Response.json({ ok: true, version: VERSION, repaired: repaired.length, ready: repaired.filter((c) => c.quality_status === 'ready').length, cards: repaired, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
