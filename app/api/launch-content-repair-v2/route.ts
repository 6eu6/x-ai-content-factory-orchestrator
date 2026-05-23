import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'launch-content-repair-v2-json-safe';
const REPO = 'https://github.com/6eu6/activepieces-piece-builder-v1';

function oa() { return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: optionalEnv('OPENAI_BASE_URL') || undefined }); }
function a(v: any) { return Array.isArray(v) ? v : !v ? [] : typeof v === 'object' ? Object.values(v) : [v]; }
function s(v: any) { return String(v || '').replace(/\s+/g, ' ').trim(); }
function safe(v: any) { return JSON.parse(JSON.stringify(v ?? null)); }
function cut(v: any, n = 250) { const x = s(v); return x.length <= n ? x : x.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; }
function noBait(x: string) { return !/what do you think|share your thoughts|let's discuss|how do you handle/i.test(x); }
function thread(items: any[]) {
  const cleaned = items.map((x) => cut(x, 250)).filter(Boolean).filter(noBait);
  const link = cleaned.find((x) => x.includes('github.com/'));
  const rest = cleaned.filter((x) => !x.includes('github.com/')).slice(0, link ? 5 : 6);
  if (link) rest.push(link);
  return rest.slice(0, 6);
}
function quality(type: string, text: string | null, items: string[]) {
  const r: string[] = [];
  if (type === 'single_tweet') {
    if (!text || text.length < 60) r.push('too_short');
    if ((text || '').length > 260) r.push('over_260_chars');
    if (!(text || '').includes('github.com/')) r.push('missing_repo_link');
    if (text && !noBait(text)) r.push('generic_engagement_bait');
  } else {
    if (items.length < 5 || items.length > 8) r.push('thread_should_be_5_to_8_items');
    if (items.some((x) => x.length > 280)) r.push('thread_item_over_280_chars');
    if (!items.some((x) => x.includes('github.com/'))) r.push('missing_repo_link');
    if (items.some((x) => !noBait(x))) r.push('generic_engagement_bait');
  }
  return { status: r.length ? 'needs_review' : 'ready', reasons: r };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const repo = url.searchParams.get('repo_url') || REPO;
    const cardId = url.searchParams.get('card_id');

    let q = supabase.from('content_production_cards').select('*').eq('status', 'needs_review').in('production_type', ['single_tweet', 'thread']).order('created_at', { ascending: false }).limit(20);
    if (cardId) q = q.eq('id', cardId);
    const got = await q;
    if (got.error) throw got.error;
    const cards = (got.data || []).filter((c: any) => cardId || a(c.source_urls).map(String).includes(repo) || String(c.source_basis || '').includes(repo)).slice(0, 4);
    if (!cards.length) return Response.json({ ok: true, version: VERSION, repaired: 0, note: 'No matching repo launch cards.' });

    const repaired: any[] = [];
    for (const card of cards) {
      const prompt = `Rewrite for X. English. No hype. No closing question. Link once. If single: <=245 chars. If thread: exactly 6 tweets <=250 chars. JSON only with production_type, final_text, thread_items, viral_mechanic, original_angle, audience_pain, quality_basis. Repo: ${repo}. Card: ${JSON.stringify(card)}`;
      const res = await oa().chat.completions.create({
        model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
        temperature: 0.02,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: 'Return JSON only.' }, { role: 'user', content: prompt }]
      });
      const raw = parseModelJson(res.choices[0]?.message?.content || '');
      const type = raw.production_type === 'thread' ? 'thread' : card.production_type;
      const finalText = type === 'single_tweet' ? cut(raw.final_text, 260) : null;
      const items = type === 'thread' ? thread(a(raw.thread_items)) : [];
      const qr = quality(type, finalText, items);
      const upd = await supabase.from('content_production_cards').update({
        production_type: type,
        final_text: finalText,
        thread_items: safe(items),
        viral_mechanic: raw.viral_mechanic || card.viral_mechanic,
        original_angle: raw.original_angle || card.original_angle,
        audience_pain: raw.audience_pain || card.audience_pain,
        quality_basis: raw.quality_basis || card.quality_basis,
        quality_status: qr.status,
        quality_reasons: safe(qr.reasons),
        publish_status: qr.status,
        status: qr.status === 'ready' ? 'ready' : 'needs_review',
        reflection_notes: safe({ repaired_by: VERSION, repo_url: repo, previous_reasons: a(card.quality_reasons).map(String) }),
        updated_at: new Date().toISOString()
      }).eq('id', card.id).select('*').single();
      if (upd.error) throw upd.error;
      repaired.push(upd.data);
    }
    const log = await insertSessionLog({ actions_completed: ['launch_content_repair_v2', VERSION, `ready:${repaired.filter((x) => x.quality_status === 'ready').length}`], content_created: repaired, next_recommendation: 'Trial mode only; review manually before any real posting.' });
    return Response.json({ ok: true, version: VERSION, repaired: repaired.length, ready: repaired.filter((x) => x.quality_status === 'ready').length, cards: repaired, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
