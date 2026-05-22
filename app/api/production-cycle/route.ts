import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { evaluateContentQuality } from '../../../lib/quality';

const VERSION = 'production-cycle-v1.2-thread-quality';

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

function compactText(value: any) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function formatQuality(card: any, productionType: string) {
  const sourceUrls = asArray(card.source_urls).map((x) => String(x || '').trim()).filter(Boolean);
  const reasons: string[] = [];
  const viralMechanic = card.viral_mechanic || card.mechanic_used || card.viral_pattern_basis;
  const originalAngle = card.original_angle || card.why_original || card.why_this_is_not_generic;
  const audiencePain = card.audience_pain;

  if (!sourceUrls.length) reasons.push('missing_source_urls');
  if (!viralMechanic) reasons.push('missing_viral_mechanic');
  if (!originalAngle) reasons.push('missing_original_angle');
  if (!audiencePain) reasons.push('missing_audience_pain');

  if (productionType === 'single_tweet' || productionType === 'reply' || productionType === 'quote') {
    const quality = evaluateContentQuality({
      ...card,
      text: card.final_text,
      mechanic_used: viralMechanic,
      viral_pattern_basis: viralMechanic,
      why_this_is_not_generic: originalAngle,
      reply_trigger: card.why_replyable || card.reply_trigger || viralMechanic,
      bookmark_trigger: card.why_bookmarkable || card.bookmark_trigger || viralMechanic
    });
    return { status: quality.reasons.length || reasons.length ? 'needs_review' : 'ready', reasons: [...quality.reasons, ...reasons] };
  }

  if (productionType === 'thread') {
    const items = asArray(card.thread_items).map(compactText).filter(Boolean);
    if (items.length < 5 || items.length > 9) reasons.push('thread_items_must_be_5_to_9');
    const longItems = items.filter((x) => x.length > 280).length;
    if (longItems) reasons.push('thread_item_over_280_chars');
    if (items.some((x) => /^thread\b|^🧵/i.test(x))) reasons.push('thread_opener_too_generic');
    if (items.some((x) => /share your thoughts|what do you think/i.test(x))) reasons.push('generic_engagement_bait');
    const explanatoryItems = items.filter((x) => /because|means|instead|problem|risk|example|pattern|uses|allows|enables|helps|shows|turns|reduces|prevents|build|design|architecture|pipeline|workflow|system|signal|score|rank|why|how/i.test(x)).length;
    if (items.length && explanatoryItems < Math.min(3, Math.ceil(items.length / 3))) reasons.push('missing_explanatory_value');
    return { status: reasons.length ? 'needs_review' : 'ready', reasons };
  }

  if (productionType === 'article') {
    const outline = card.article_outline || {};
    if (!Object.keys(outline).length && !card.final_text) reasons.push('missing_article_outline');
    if (!card.final_text && !outline.title) reasons.push('missing_article_title_or_summary');
    return { status: reasons.length ? 'needs_review' : 'ready', reasons };
  }

  if (productionType === 'github_repo' || productionType === 'tool') {
    const plan = card.repo_plan || {};
    if (!Object.keys(plan).length) reasons.push('missing_repo_plan');
    if (!JSON.stringify(plan).toLowerCase().includes('test')) reasons.push('missing_test_plan');
    return { status: reasons.length ? 'needs_review' : 'ready', reasons };
  }

  if (productionType === 'video') {
    if (!Object.keys(card.video_script || {}).length) reasons.push('missing_video_script');
    return { status: reasons.length ? 'needs_review' : 'ready', reasons };
  }

  if (productionType === 'carousel') {
    if (!Object.keys(card.carousel_plan || {}).length) reasons.push('missing_carousel_plan');
    return { status: reasons.length ? 'needs_review' : 'ready', reasons };
  }

  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
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

    if (!decisions?.length) return Response.json({ ok: true, version: VERSION, cards: [], note: 'No selected format decisions. Run format-decision first.' });

    const [hypotheses, rawResearch, viralTweets, viralPatterns, recentContent, repoRules] = await Promise.all([
      supabase.from('original_content_hypotheses').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('raw_research_items').select('*').order('source_quality_score', { ascending: false }).limit(50),
      supabase.from('viral_tweet_analyses').select('*').order('engagement_per_1k_followers', { ascending: false }).limit(20),
      supabase.from('viral_account_patterns').select('*').order('confidence_score', { ascending: false }).limit(20),
      supabase.from('content_log').select('final_text,publish_status,created_at').order('created_at', { ascending: false }).limit(30),
      supabase.from('repo_extracted_rules').select('*').order('confidence_score', { ascending: false }).limit(30)
    ]);

    const prompt = `You are the Production Engine for @${optionalEnv('X_USERNAME', '30piq')}.
Niche: AI x Productivity x Career Growth. English only. Human, casual expert voice.

Create production cards from selected format decisions.
Rules:
- Facts may only come from content_opportunities.source_urls, rawResearch, or repoRules.
- Viral data is for mechanics only, never for factual claims.
- Do not copy creator wording.
- Avoid corporate/slop language and generic engagement bait.
- Early account: avoid spammy external links unless format is article/github_repo/tool.
- For single_tweet: max 240 chars.
- For thread: 5-9 varied tweets, each <= 280 chars, no standalone "Thread" opener, no "share your thoughts" ending.
- For article: provide outline, not full article yet.
- For github_repo/tool: provide repo_plan with files, tests, README sections, examples, and maintenance notes.
Return strict JSON:
{"cards":[{"format_decision_id":"...","content_opportunity_id":"...","production_type":"...","final_text":"...","thread_items":["..."],"article_outline":{},"repo_plan":{},"video_script":{},"carousel_plan":{},"source_urls":["..."],"viral_mechanic":"...","original_angle":"...","audience_pain":"...","algorithm_basis":"...","source_basis":"...","format_basis":"...","quality_basis":"...","why_ready_or_not":"..."}]}
decisions=${JSON.stringify(decisions)}
hypotheses=${JSON.stringify(hypotheses.data || [])}
rawResearch=${JSON.stringify(rawResearch.data || [])}
repoRules=${JSON.stringify(repoRules.data || [])}
viralTweets=${JSON.stringify(viralTweets.data || [])}
viralPatterns=${JSON.stringify(viralPatterns.data || [])}
recentContent=${JSON.stringify(recentContent.data || [])}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.1,
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
      const sourceUrls = asArray(card.source_urls).map((x) => String(x || '').trim()).filter(Boolean);
      const quality = formatQuality(card, productionType);
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
        algorithm_basis: card.algorithm_basis || null,
        source_basis: card.source_basis || null,
        format_basis: card.format_basis || null,
        quality_basis: card.quality_basis || null,
        quality_status: quality.status,
        quality_reasons: quality.reasons,
        publish_status: quality.status,
        status: quality.status === 'ready' ? 'ready' : 'needs_review'
      }).select('*').single();

      if (error) throw error;
      if (data) {
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
            publish_status: quality.status,
            quality_reasons: quality.reasons,
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
