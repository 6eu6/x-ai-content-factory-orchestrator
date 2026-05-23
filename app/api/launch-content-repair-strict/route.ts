import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'launch-content-repair-strict-v1';

function client() {
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: optionalEnv('OPENAI_BASE_URL') || undefined });
}
function arr(v: any) { return Array.isArray(v) ? v : !v ? [] : typeof v === 'object' ? Object.values(v) : [v]; }
function clean(v: any) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function trim(v: string, max: number) {
  const s = clean(v);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const i = cut.lastIndexOf(' ');
  return `${cut.slice(0, i > 80 ? i : max - 1).trim()}…`;
}
function noBait(items: string[]) {
  return items.filter((x) => !/what do you think|share your thoughts|rt if|let's discuss|how do you handle/i.test(x));
}
function compress(items: string[]) {
  const c = noBait(items).map((x) => trim(x, 260)).filter(Boolean);
  const link = c.find((x) => /github\.com\//i.test(x));
  const rest = c.filter((x) => !/github\.com\//i.test(x));
  const out = rest.slice(0, link ? 6 : 7);
  if (link) out.push(link);
  return out.slice(0, 7);
}
function qSingle(text: string) {
  const r: string[] = [];
  if (text.length < 60) r.push('too_short');
  if (text.length > 260) r.push('over_260_chars');
  if (!/github\.com\//i.test(text)) r.push('missing_repo_link');
  if (/what do you think|share your thoughts|rt if|let's discuss/i.test(text)) r.push('generic_engagement_bait');
  if (/revolutionize|cutting-edge|game-changing|unlock|seamless/i.test(text)) r.push('generic_ai_voice');
  return { status: r.length ? 'needs_review' : 'ready', reasons: r };
}
function qThread(items: string[]) {
  const r: string[] = [];
  if (items.length < 5 || items.length > 8) r.push('thread_should_be_5_to_8_items');
  if (items.some((x) => x.length > 280)) r.push('thread_item_over_280_chars');
  if (items.some((x) => /what do you think|share your thoughts|rt if|let's discuss|how do you handle/i.test(x))) r.push('generic_engagement_bait');
  if (!items.some((x) => /github\.com\//i.test(x))) r.push('missing_repo_link');
  return { status: r.length ? 'needs_review' : 'ready', reasons: r };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const repoUrl = url.searchParams.get('repo_url') || 'https://github.com/6eu6/activepieces-piece-builder-v1';
    const cardId = url.searchParams.get('card_id');

    let query = supabase.from('content_production_cards').select('*').eq('status', 'needs_review').in('production_type', ['single_tweet', 'thread']).limit(4);
    if (cardId) query = query.eq('id', cardId);
    else query = query.contains('source_urls', [repoUrl]);
    const { data: cards, error } = await query;
    if (error) throw error;
    if (!cards?.length) return Response.json({ ok: true, version: VERSION, repaired: 0, note: 'No matching launch cards.' });

    const [alg, styles, viral, mcp] = await Promise.all([
      supabase.from('x_algorithm_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(20),
      supabase.from('viral_style_patterns').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(20),
      supabase.from('viral_account_patterns').select('*').order('confidence_score', { ascending: false }).limit(15),
      supabase.from('mcp_opportunity_map').select('*').eq('status', 'active').order('priority_score', { ascending: false }).limit(10)
    ]);

    const repaired: any[] = [];
    for (const card of cards) {
      const prompt = `Rewrite this X launch card for @${optionalEnv('X_USERNAME', '30piq')}.
Return JSON only. No hype. No closing question. Link once.
If single_tweet: max 245 chars.
If thread: exactly 6 tweets, each max 250 chars.
Make it useful without clicking.
Card=${JSON.stringify(card)}
XRules=${JSON.stringify(alg.data || [])}
StylePatterns=${JSON.stringify(styles.data || [])}
ViralPatterns=${JSON.stringify(viral.data || [])}
Mcp=${JSON.stringify(mcp.data || [])}`;
      const completion = await client().chat.completions.create({
        model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
        temperature: 0.03,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: 'Return JSON: {production_type, final_text, thread_items, viral_mechanic, original_angle, audience_pain, quality_basis}' }, { role: 'user', content: prompt }]
      });
      const raw = parseModelJson(completion.choices[0]?.message?.content || '');
      const type = raw.production_type === 'thread' ? 'thread' : card.production_type;
      const finalText = type === 'single_tweet' ? trim(raw.final_text, 260) : null;
      const threadItems = type === 'thread' ? compress(arr(raw.thread_items).map(clean)) : [];
      const q = type === 'thread' ? qThread(threadItems) : qSingle(finalText || '');
      const { data, error: upErr } = await supabase.from('content_production_cards').update({
        production_type: type,
        final_text: finalText,
        thread_items: threadItems,
        viral_mechanic: raw.viral_mechanic || card.viral_mechanic,
        original_angle: raw.original_angle || card.original_angle,
        audience_pain: raw.audience_pain || card.audience_pain,
        quality_basis: raw.quality_basis || card.quality_basis,
        quality_status: q.status,
        quality_reasons: q.reasons,
        publish_status: q.status,
        status: q.status === 'ready' ? 'ready' : 'needs_review',
        reflection_notes: { ...(card.reflection_notes || {}), repaired_by: VERSION, repaired_at: new Date().toISOString(), previous_reasons: card.quality_reasons || [] },
        updated_at: new Date().toISOString()
      }).eq('id', card.id).select('*').single();
      if (upErr) throw upErr;
      repaired.push(data);
    }

    const log = await insertSessionLog({
      actions_completed: ['launch_content_repair_strict', VERSION, `cards:${repaired.length}`, `ready:${repaired.filter((x) => x.quality_status === 'ready').length}`],
      content_created: repaired,
      pending_tasks: repaired.filter((x) => x.quality_status === 'ready').map((x) => `Review ${x.production_type} manually.`),
      next_recommendation: 'Keep this in trial mode; do not post until production mode is ready.'
    });
    return Response.json({ ok: true, version: VERSION, repaired: repaired.length, ready: repaired.filter((x) => x.quality_status === 'ready').length, cards: repaired, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
