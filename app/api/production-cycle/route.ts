import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { evaluateContentQuality } from '../../../lib/quality';

const VERSION = 'production-cycle-v1';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function safeType(value: any) {
  const allowed = new Set(['single_tweet', 'reply', 'quote', 'thread', 'article', 'github_repo', 'video', 'carousel', 'tool']);
  const type = String(value || '').trim();
  return allowed.has(type) ? type : 'single_tweet';
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 5), 1), 12);

    const { data: decisions } = await supabase
      .from('content_format_decisions')
      .select('*, content_opportunities(*)')
      .eq('status', 'selected')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (!decisions?.length) {
      return Response.json({ ok: true, version: VERSION, cards: [], note: 'No selected format decisions. Run format-decision first.' });
    }

    const [hypotheses, rawResearch, viralTweets, viralPatterns, recentContent] = await Promise.all([
      supabase.from('original_content_hypotheses').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('raw_research_items').select('*').order('source_quality_score', { ascending: false }).limit(50),
      supabase.from('viral_tweet_analyses').select('*').order('engagement_per_1k_followers', { ascending: false }).limit(20),
      supabase.from('viral_account_patterns').select('*').order('confidence_score', { ascending: false }).limit(20),
      supabase.from('content_log').select('final_text,publish_status,created_at').order('created_at', { ascending: false }).limit(30)
    ]);

    const prompt = `You are the Production Engine for @${optionalEnv('X_USERNAME', '30piq')}.
Niche: AI x Productivity x Career Growth. English only. Human, casual expert voice.

Create production cards from selected format decisions.
Rules:
- Facts may only come from content_opportunities.source_urls and rawResearch.
- Viral data is for mechanics only, never for factual claims.
- Do not copy creator wording.
- Avoid corporate/slop language.
- Early account: avoid spammy external links unless format is article/github_repo/tool.
- For single_tweet: max 240 chars.
- For thread: 5-9 varied tweets, no standalone "Thread" opener.
- For article: provide outline, not full article yet.
- For github_repo: provide repo plan, not files yet.
- For video: provide script with first 3 seconds keyword-rich and captions plan.
- For carousel: provide slide-by-slide plan.
Return strict JSON:
{"cards":[{"format_decision_id":"...","content_opportunity_id":"...","production_type":"...","final_text":"...","thread_items":["..."],"article_outline":{},"repo_plan":{},"video_script":{},"carousel_plan":{},"source_urls":["..."],"viral_mechanic":"...","original_angle":"...","audience_pain":"...","why_ready_or_not":"..."}]}
decisions=${JSON.stringify(decisions)}
hypotheses=${JSON.stringify(hypotheses.data || [])}
rawResearch=${JSON.stringify(rawResearch.data || [])}
viralTweets=${JSON.stringify(viralTweets.data || [])}
viralPatterns=${JSON.stringify(viralPatterns.data || [])}
recentContent=${JSON.stringify(recentContent.data || [])}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.12,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Produce structured content cards from decisions. Facts need source URLs. Return JSON only.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const cards = asArray(raw.cards).slice(0, limit);
    const inserted: any[] = [];

    for (const card of cards) {
      const productionType = safeType(card.production_type);
      const textForQuality = productionType === 'single_tweet' || productionType === 'reply' || productionType === 'quote'
        ? card.final_text
        : [card.final_text, ...asArray(card.thread_items)].join('\n');
      const quality = evaluateContentQuality({ ...card, text: textForQuality });
      const sourceUrls = asArray(card.source_urls);
      const finalQualityStatus = sourceUrls.length || !/research|study|data|report|recent/i.test(String(textForQuality || '')) ? quality.status : 'needs_review';
      const qualityReasons = finalQualityStatus === quality.status ? quality.reasons : [...quality.reasons, 'missing_source_urls_for_claim'];

      const { data, error } = await supabase.from('content_production_cards').insert({
        format_decision_id: card.format_decision_id || null,
        content_opportunity_id: card.content_opportunity_id || null,
        production_type: productionType,
        final_text: card.final_text || null,
        thread_items: asArray(card.thread_items),
        article_outline: card.article_outline || {},
        repo_plan: card.repo_plan || {},
        video_script: card.video_script || {},
        carousel_plan: card.carousel_plan || {},
        source_urls: sourceUrls,
        viral_mechanic: card.viral_mechanic || null,
        original_angle: card.original_angle || null,
        audience_pain: card.audience_pain || null,
        quality_status: finalQualityStatus,
        quality_reasons: qualityReasons,
        publish_status: finalQualityStatus,
        status: finalQualityStatus === 'ready' ? 'ready' : 'needs_review'
      }).select('*').single();

      if (!error && data) {
        inserted.push(data);
        await supabase.from('content_format_decisions').update({ status: 'produced', updated_at: new Date().toISOString() }).eq('id', data.format_decision_id);
        if (data.production_type === 'single_tweet' && data.final_text) {
          await supabase.from('content_log').insert({
            content_type: 'single_tweet',
            topic: card.original_angle || 'AI productivity career growth',
            hook_text: String(data.final_text).slice(0, 240),
            final_text: data.final_text,
            source_used: VERSION,
            source_urls: sourceUrls,
            publish_status: finalQualityStatus,
            quality_reasons: qualityReasons,
            content_opportunity_id: data.content_opportunity_id,
            notes: JSON.stringify({ production_card_id: data.id, viral_mechanic: data.viral_mechanic, original_angle: data.original_angle })
          });
        }
      }
    }

    const log = await insertSessionLog({
      actions_completed: ['production_cycle', VERSION, `cards:${inserted.length}`],
      content_created: inserted,
      db_updates: [{ table: 'content_production_cards', rows: inserted.length }],
      pending_tasks: inserted.filter((x) => x.quality_status !== 'ready').map((x) => `Review ${x.production_type}: ${x.quality_reasons?.join(', ') || 'needs_review'}`),
      next_recommendation: inserted.some((x) => x.quality_status === 'ready') ? 'Review ready production cards in Telegram.' : 'Improve sources or rewrite cards that failed quality gate.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { cards: inserted.length, ready: inserted.filter((x) => x.quality_status === 'ready').length }, cards: inserted, raw, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
