import { callModel, parseModelJson, TaskType } from './model-router';
import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';
import {
  getXUserByUsername,
  getXUserTimeline,
  searchXTweets,
  scoreXTweet,
  analyzeXTweet,
  fetchTwitterApiJson,
  twitterApiBase,
  extractTweets
} from './x';
import { learnFromCrawlerItems } from './learning-memory';
import { shieldCheck, quickShieldCheck } from './account-shield';
import { insertIfMissing } from './db-helpers';

/**
 * Content Engine v3 — محرك محتوى مبني على الزحف لا على التوليد
 *
 * المبدأ: لا توليد AI للمحتوى (AI slop). بدل كذا:
 * 1. يزحف X ويحلل حسابات وتغريدات حقيقية
 * 2. يخزن الأنماط في العقل (قواعد صارمة)
 * 3. يكتشف فرص تفاعل حقيقية (رد، اقتباس، ثريد مبني على مصادر)
 * 4. يصيغ المحتوى بناءً على العقل فقط
 * 5. يحمل وسائط حقيقية من التغريدات (صور، فيديو، GIF)
 */

// ═══ أنواع المخرجات ═══

export type ContentOpportunity = {
  type: 'quote' | 'reply' | 'thread' | 'article' | 'repo_tweet';
  source_tweet_url: string;
  source_text: string;
  source_author: string;
  source_metrics: Record<string, number>;
  media_urls: MediaFromTweet[];
  crafted_text: string;
  why: string;           // ليش هذي الفرصة مهمة
  brain_rules_used: string[];  // قواعد العقل المستخدمة
  shield_passed: boolean;
  shield_issues: string[];
};

export type MediaFromTweet = {
  type: 'photo' | 'video' | 'animated_gif';
  url: string;
  alt_text: string;
};

export type ScanResult = {
  accounts_scanned: number;
  tweets_analyzed: number;
  viral_tweets_found: number;
  opportunities: ContentOpportunity[];
  brain_updates: {
    algorithm_rules: number;
    style_patterns: number;
    media_patterns: number;
  };
  media_downloaded: number;
};

// ═══ الزحف والتحليل ═══

/**
 * يزحف حسابات X المحفوظة ويحلل تغريداتها
 */
export async function scanXAccounts(maxAccounts = 5, tweetsPerAccount = 10): Promise<ScanResult> {
  const supabase = supabaseAdmin();
  const username = optionalEnv('X_USERNAME', '30piq');

  // 1. جلب الحسابات المحفوظة
  const { data: accounts } = await supabase
    .from('accounts')
    .select('handle, username')
    .eq('active', true)
    .order('updated_at', { ascending: false })
    .limit(maxAccounts);

  if (!accounts?.length) {
    return emptyResult('لا توجد حسابات تعلم. أضف حسابات عبر زر "➕ إضافة حساب".');
  }

  let totalAnalyzed = 0;
  let viralFound = 0;
  const allAnalyzed: any[] = [];
  const allMedia: MediaFromTweet[] = [];

  // 2. زحف كل حساب
  for (const account of accounts.slice(0, maxAccounts)) {
    try {
      const handle = account.handle || account.username;
      const tweets = await getXUserTimeline(handle, tweetsPerAccount, true);

      for (const tweet of tweets) {
        totalAnalyzed++;
        const user = { username: handle, followers_count: 0, public_metrics: { followers_count: 0 } };
        const analysis = analyzeXTweet(tweet, user);
        const score = scoreXTweet(tweet);
        const media = extractMediaFromTweet(tweet);

        // خزّن في viral_tweet_analyses
        if (score > 20 || analysis.engagement_per_1k_followers > 5) {
          viralFound++;
          try {
            await supabase.from('viral_tweet_analyses').upsert({
              tweet_id: analysis.tweet_id,
              tweet_url: analysis.tweet_url,
              username: handle,
              text: analysis.text,
              engagement_score: score,
              engagement_per_1k_followers: analysis.engagement_per_1k_followers,
              tweet_type: media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original'),
              metrics: analysis.metrics,
              has_media: media.length > 0,
              media_type: media.map(m => m.type).join(','),
              analyzed_at: new Date().toISOString()
            }, { onConflict: 'tweet_id' });
          } catch {}

          allAnalyzed.push({
            ...analysis,
            score,
            media,
            handle
          });

          allMedia.push(...media);
        }

        // خزّن كمان تغريدات بدون فيروسية عشان تحليل الأنماط
        try {
          await supabase.from('viral_tweet_analyses').upsert({
            tweet_id: analysis.tweet_id,
            tweet_url: analysis.tweet_url,
            username: handle,
            text: analysis.text.slice(0, 500),
            engagement_score: score,
            engagement_per_1k_followers: analysis.engagement_per_1k_followers,
            tweet_type: media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original'),
            metrics: analysis.metrics,
            has_media: media.length > 0,
            media_type: media.map(m => m.type).join(','),
            analyzed_at: new Date().toISOString()
          }, { onConflict: 'tweet_id' });
        } catch {}
      }

      // حدّث حالة الحساب
      try {
        const snapshot = await getXUserByUsername(handle);
        await supabase.from('accounts').update({
          notes: `Followers: ${snapshot.followers_count}, Scanned: ${new Date().toISOString()}`,
          updated_at: new Date().toISOString()
        }).eq('handle', handle);
      } catch {}

    } catch (e: any) {
      console.error(`Failed to scan @${account.handle}:`, e.message);
    }
  }

  // 3. علّم العقل من البيانات المزحوفة
  let brainUpdates = { algorithmRules: 0, stylePatterns: 0, mcpOpportunities: 0 };
  try {
    const crawlerItems = allAnalyzed.map(a => ({
      title: a.text?.slice(0, 200) || 'X tweet analysis',
      url: a.tweet_url,
      summary: `Engagement: ${a.score}, Per1K: ${a.engagement_per_1k_followers}, Type: ${a.media?.length > 0 ? 'media' : 'text'}, Media: ${a.media?.map((m: MediaFromTweet) => m.type).join(',') || 'none'}, Has question: ${a.has_question}`,
      confidence_score: Math.min(10, Math.max(1, Math.round(a.score / 10))),
    }));

    if (crawlerItems.length > 0) {
      const learned = await learnFromCrawlerItems(supabase, {
        runType: 'x_account_scan_v3',
        source: 'twitter_scan',
        items: crawlerItems,
        mode: 'production'
      });
      brainUpdates = {
        algorithmRules: learned.algorithmRules,
        stylePatterns: learned.stylePatterns,
        mcpOpportunities: learned.mcpOpportunities
      };
    }
  } catch (e: any) {
    console.error('Brain learning failed:', e.message);
  }

  // 3.5. علّم العقل أنماط الوسائط — أي حسابات تستخدم صور/فيديو/GIF
  try {
    // احسب نسبة التغريدات اللي فيها وسائط لكل حساب
    const accountMediaStats: Record<string, { total: number; withMedia: number; types: Set<string> }> = {};
    for (const a of allAnalyzed) {
      const handle = a.handle || a.username || 'unknown';
      if (!accountMediaStats[handle]) accountMediaStats[handle] = { total: 0, withMedia: 0, types: new Set() };
      accountMediaStats[handle].total++;
      if (a.media?.length > 0) {
        accountMediaStats[handle].withMedia++;
        for (const m of a.media) accountMediaStats[handle].types.add(m.type);
      }
    }

    for (const [handle, stats] of Object.entries(accountMediaStats)) {
      if (stats.withMedia > 0) {
        const mediaRatio = Math.round((stats.withMedia / stats.total) * 100);
        const mediaTypes = [...stats.types].join(', ');
        const rule = `@${handle} uses media in ${mediaRatio}% of tweets (${mediaTypes}). Accounts with high media usage get better engagement. Consider media when crafting engagement with their tweets.`;
        await insertIfMissing(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'media_pattern', rule },
          {
            rule_type: 'media_pattern',
            rule,
            evidence: `Scanned ${stats.total} tweets from @${handle}: ${stats.withMedia} had media (${mediaTypes})`,
            source_type: 'x_account_scan_v3',
            source_url: `https://x.com/${handle}`,
            applies_to: 'crawl_strategy,content_score,engagement_crafting',
            confidence_score: Math.min(10, 5 + Math.floor(mediaRatio / 20)),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          }
        );
        brainUpdates.algorithmRules++;
      }
    }
  } catch (e: any) {
    console.error('Media pattern learning failed:', e.message);
  }

  // 4. اكتشف فرص المحتوى
  const opportunities = await discoverOpportunities(allAnalyzed, allMedia);

  return {
    accounts_scanned: accounts.length,
    tweets_analyzed: totalAnalyzed,
    viral_tweets_found: viralFound,
    opportunities,
    brain_updates: {
      algorithm_rules: brainUpdates.algorithmRules,
      style_patterns: brainUpdates.stylePatterns,
      media_patterns: allMedia.length
    },
    media_downloaded: allMedia.length
  };
}

/**
 * يستخرج الوسائط من تغريدة X (صور، فيديو، GIF)
 * يدعم صيغ TwitterAPI.io المختلفة:
 * - raw.media (مصفوفة مباشرة)
 * - raw.photos / raw.videos (صيغة TwitterAPI.io)
 * - raw.entities.media (صيغة Twitter القياسية)
 * - raw.extended_entities.media
 * - raw.mediaDetails (صيغة TwitterAPI.io أحياناً)
 */
function extractMediaFromTweet(tweet: any): MediaFromTweet[] {
  const media: MediaFromTweet[] = [];
  const raw = tweet.raw || tweet;

  // نجمع الوسائط من كل المصادر المحتملة
  const sources: any[] = [];

  // 1. raw.media (مصفوفة مباشرة — TwitterAPI.io غالباً يرجع هنا)
  if (Array.isArray(raw.media)) sources.push(...raw.media);

  // 2. raw.mediaDetails (صيغة أخرى من TwitterAPI.io)
  if (Array.isArray(raw.mediaDetails)) sources.push(...raw.mediaDetails);

  // 3. raw.entities.media
  if (Array.isArray(raw.entities?.media)) sources.push(...raw.entities.media);

  // 4. raw.extended_entities.media
  if (Array.isArray(raw.extended_entities?.media)) sources.push(...raw.extended_entities.media);

  // 5. raw.photos (صيغة TwitterAPI.io — مصفوفة روابط أو كائنات)
  if (Array.isArray(raw.photos)) {
    for (const p of raw.photos) {
      media.push({
        type: 'photo',
        url: typeof p === 'string' ? p : (p.media_url_https || p.url || p.media_url || p.imageUrl || ''),
        alt_text: typeof p === 'object' ? (p.alt_text || '') : ''
      });
    }
  }

  // 6. raw.videos (صيغة TwitterAPI.io)
  if (Array.isArray(raw.videos)) {
    for (const v of raw.videos) {
      const vidUrl = typeof v === 'string' ? v : (v.video_url || v.url || v.preview_url || '');
      if (vidUrl) {
        media.push({
          type: v.type === 'animated_gif' ? 'animated_gif' : 'video',
          url: vidUrl,
          alt_text: typeof v === 'object' ? (v.alt_text || '') : ''
        });
      }
    }
  }

  // 7. raw.video (كائن واحد)
  if (raw.video && typeof raw.video === 'object' && !Array.isArray(raw.video)) {
    const vidUrl = raw.video.video_url || raw.video.url || raw.video.preview_url || '';
    if (vidUrl) {
      media.push({
        type: raw.video.type === 'animated_gif' ? 'animated_gif' : 'video',
        url: vidUrl,
        alt_text: raw.video.alt_text || ''
      });
    }
  }

  // 8. raw.imageUrl / raw.image (صيغة مبسطة)
  if (raw.imageUrl) media.push({ type: 'photo', url: raw.imageUrl, alt_text: '' });
  if (raw.image && typeof raw.image === 'string') media.push({ type: 'photo', url: raw.image, alt_text: '' });

  // معالجة المصادر الموحدة (من sources array)
  for (const m of sources) {
    if (!m || typeof m !== 'object') continue;

    // صور
    if (m.type === 'photo' || m.media_url_https || m.media_url || m.display_url) {
      media.push({
        type: 'photo',
        url: m.media_url_https || m.media_url || m.url || m.display_url || m.imageUrl || '',
        alt_text: m.alt_text || m.ext_alt_text || ''
      });
    }
    // فيديو
    else if (m.type === 'video') {
      const variant = m.video_info?.variants?.find((v: any) => v.content_type === 'video/mp4')
        || m.video_info?.variants?.[0];
      const vidUrl = variant?.url || m.video_url || m.url || '';
      if (vidUrl) {
        media.push({
          type: 'video',
          url: vidUrl,
          alt_text: m.alt_text || m.ext_alt_text || ''
        });
      }
    }
    // GIF متحرك
    else if (m.type === 'animated_gif') {
      const variant = m.video_info?.variants?.find((v: any) => v.content_type === 'video/mp4')
        || m.video_info?.variants?.[0];
      const gifUrl = variant?.url || m.video_url || m.url || '';
      if (gifUrl) {
        media.push({
          type: 'animated_gif',
          url: gifUrl,
          alt_text: m.alt_text || m.ext_alt_text || ''
        });
      }
    }
  }

  // إزالة التكرارات بناءً على URL
  const seen = new Set<string>();
  const unique = media.filter(m => {
    if (!m.url || seen.has(m.url)) return false;
    seen.add(m.url);
    return true;
  });

  // تشخيص: سجّل نتيجة الاستخراج
  if (unique.length === 0 && (raw.photos?.length || raw.videos?.length || raw.media?.length || raw.mediaDetails?.length)) {
    console.warn(`[extractMedia] WARNING: Raw has media fields but extraction returned empty! Raw keys: ${Object.keys(raw).filter(k => /media|photo|video|image|gif/i.test(k)).join(', ')}`);
  }

  return unique;
}

/**
 * يكتشف فرص تفاعل من التغريدات المحللة
 */
async function discoverOpportunities(
  analyzed: any[],
  media: MediaFromTweet[]
): Promise<ContentOpportunity[]> {
  if (!analyzed.length) return [];

  const supabase = supabaseAdmin();
  const opportunities: ContentOpportunity[] = [];

  // جلب قواعد العقل
  const { data: algoRules } = await supabase
    .from('x_algorithm_learning_rules')
    .select('rule_type, rule, applies_to')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  const { data: stylePatterns } = await supabase
    .from('viral_style_patterns')
    .select('pattern_name, pattern_description, adaptation_for_30piq')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  // رتّب التغريدات حسب الأهمية
  const sorted = [...analyzed].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);

  for (const tweet of sorted) {
    const tweetMedia = tweet.media || [];
    const rulesUsed: string[] = [];

    // أنواع الفرص حسب طبيعة التغريدة
    // 1. اقتباس: لو التغريدة فيها رأي/معلومة قوية
    if (tweet.has_question || tweet.score > 30) {
      const crafted = await craftEngagement('quote', tweet, algoRules || [], stylePatterns || [], rulesUsed);
      if (crafted) {
        const shieldResult = quickShieldCheck(crafted);
        opportunities.push({
          type: 'quote',
          source_tweet_url: tweet.tweet_url,
          source_text: tweet.text?.slice(0, 200) || '',
          source_author: tweet.handle || tweet.username || '',
          source_metrics: tweet.metrics || {},
          media_urls: tweetMedia,
          crafted_text: crafted,
          why: tweet.has_question ? 'سؤال يثير نقاش' : `تفاعل عالي (${tweet.score})`,
          brain_rules_used: rulesUsed,
          shield_passed: shieldResult.safe,
          shield_issues: shieldResult.reasons
        });
      }
    }

    // 2. رد: لو التغريدة تستحق إضافة قيمة
    if (tweet.score > 15 && !tweet.is_reply) {
      const crafted = await craftEngagement('reply', tweet, algoRules || [], stylePatterns || [], rulesUsed);
      if (crafted) {
        const shieldResult = quickShieldCheck(crafted);
        opportunities.push({
          type: 'reply',
          source_tweet_url: tweet.tweet_url,
          source_text: tweet.text?.slice(0, 200) || '',
          source_author: tweet.handle || tweet.username || '',
          source_metrics: tweet.metrics || {},
          media_urls: tweetMedia,
          crafted_text: crafted,
          why: 'تغريدة قيمة تستحق إضافة رد مفيد',
          brain_rules_used: rulesUsed,
          shield_passed: shieldResult.safe,
          shield_issues: shieldResult.reasons
        });
      }
    }
  }

  // 3. ثريد/مقال: لو العقل عنده أنماط كافية
  if ((stylePatterns || []).length >= 3) {
    const threadCrafted = await craftThreadFromBrain(algoRules || [], stylePatterns || []);
    if (threadCrafted) {
      const shieldResult = quickShieldCheck(threadCrafted.text);
      opportunities.push({
        type: threadCrafted.type,
        source_tweet_url: '',
        source_text: 'مبني على أنماط العقل',
        source_author: 'brain',
        source_metrics: {},
        media_urls: [],
        crafted_text: threadCrafted.text,
        why: threadCrafted.why,
        brain_rules_used: threadCrafted.rules,
        shield_passed: shieldResult.safe,
        shield_issues: shieldResult.reasons
      });
    }
  }

  // فلترة: فقط المحتوى اللي يجتاز Shield أو يحتاج تعديل بسيط
  return opportunities.filter(o => o.shield_passed || o.shield_issues.length <= 2);
}

/**
 * يصيغ تفاعل (رد/اقتباس) بناءً على العقل
 */
async function craftEngagement(
  type: 'reply' | 'quote',
  tweet: any,
  algoRules: any[],
  stylePatterns: any[],
  rulesUsed: string[]
): Promise<string | null> {
  try {
    const rulesContext = algoRules.slice(0, 5).map(r => `- ${r.rule}`).join('\n');
    const patternsContext = stylePatterns.slice(0, 5).map(p => `- ${p.pattern_name}: ${p.pattern_description}`).join('\n');

    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `أنت تكتب لتغريدات X لحساب @${optionalEnv('X_USERNAME', '30piq')} عن AI × الإنتاجية × النمو المهني.

قواعد صارمة:
1. لا تستخدم أي كلمات AI slop (delve, crucial, leverage, game-changer, unlock, etc.)
2. لا هاشتاقات
3. لا أرقام بدون مصدر
4. لا قوائم مرقمة أو نقط متطابقة
5. صوت طبيعي — كأنك صديق ذكي يتكلم، مو آلة محتوى
6. أقل من 240 حرف
7. لا تكرر نفس الفكرة بطريقة مختلفة
8. أضف عنصر شخصي أو مرجع محدد

قواعد العقل اللي تتبعها:
${rulesContext}

أنماط أسلوبية ناجحة:
${patternsContext}

اكتب نص واحد فقط. بدون شرح أو ملاحظات.`
      },
      {
        role: 'user',
        content: type === 'quote'
          ? `اكتب نص اقتباس لهذي التغريدة:\n\n"${tweet.text?.slice(0, 300)}"\n\nالاقتباس يضيف قيمة أو زاوية مختلفة.`
          : `اكتب رد مفيد لهذي التغريدة:\n\n"${tweet.text?.slice(0, 300)}"\n\nالرد يضيف معلومة أو تجربة أو سؤال متابع.`
      }
    ]);

    const text = String(response || '').trim();
    if (text.length < 10 || text.length > 280) return null;

    // سجّل القواعد المستخدمة
    for (const rule of algoRules.slice(0, 3)) {
      rulesUsed.push(rule.rule_type || 'unknown');
    }

    return text;
  } catch {
    return null;
  }
}

/**
 * يصيغ ثريد/مقال من أنماط العقل
 */
async function craftThreadFromBrain(
  algoRules: any[],
  stylePatterns: any[]
): Promise<{ type: 'thread' | 'article'; text: string; why: string; rules: string[] } | null> {
  try {
    const topPatterns = stylePatterns.slice(0, 5);
    const topRules = algoRules.slice(0, 5);

    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `أنت تكتب لحساب @${optionalEnv('X_USERNAME', '30piq')} عن AI × الإنتاجية × النمو المهني.

قواعد صارمة:
1. لا AI slop (delve, crucial, leverage, game-changer, unlock, etc.)
2. لا هاشتاقات
3. لا أرقام بدون مصدر
4. صوت طبيعي — صديق ذكي مو آلة محتوى
5. كل تغريدة في الثرد مستقلة وقوية لحالها
6. التغريدة الأولى = هوك قوي (سؤال أو حقيقة صادمة أو رأي مثير)
7. لا تكرار

أنماط ناجحة لتستلهم منها:
${topPatterns.map(p => `- ${p.pattern_name}: ${p.pattern_description}`).join('\n')}

قواعد الخوارزمية:
${topRules.map(r => `- ${r.rule}`).join('\n')}

اكتب ثريد من 3-5 تغريدات. افصل بين كل تغريدة بسطر فيه "---" فقط.`
      },
      {
        role: 'user',
        content: `اكتب ثريد عن واحد من هذي المواضيع بناءً على أنماط العقل:\n${topPatterns.map(p => p.pattern_name).join('، ')}`
      }
    ]);

    const text = String(response || '').trim();
    if (text.length < 50) return null;

    return {
      type: 'thread',
      text,
      why: `مبني على ${topPatterns.length} أنماط ناجحة و${topRules.length} قاعدة خوارزمية`,
      rules: topRules.map(r => r.rule_type || 'unknown')
    };
  } catch {
    return null;
  }
}

/**
 * يزحف تغريدة واحدة بالمعرف (للإضافة اليدوية)
 */
export async function scanSingleTweet(tweetUrl: string): Promise<{
  ok: boolean;
  analysis?: any;
  media?: MediaFromTweet[];
  opportunity?: ContentOpportunity;
  error?: string;
}> {
  try {
    const match = tweetUrl.match(/\/status\/(\d+)/);
    if (!match) return { ok: false, error: 'رابط التغريدة غير صحيح' };

    const tweetId = match[1];
    const base = twitterApiBase();
    const json = await fetchTwitterApiJson(`${base}/twitter/tweets?tweet_ids=${tweetId}`);
    const tweets = extractTweets(json);

    if (!tweets.length) return { ok: false, error: 'لم يتم العثور على التغريدة' };

    const raw = tweets[0];

    // ═══ تشخيص: سجّل مفاتيح الرد الخام لاكتشاف صيغة الوسائط ═══
    const rawKeys = Object.keys(raw || {});
    const mediaRelatedKeys = rawKeys.filter(k => /media|photo|video|image|gif|attach|entity/i.test(k));
    console.log(`[scanSingleTweet] Raw keys: ${rawKeys.join(', ')}`);
    console.log(`[scanSingleTweet] Media-related keys: ${mediaRelatedKeys.join(', ') || 'NONE'}`);
    for (const key of mediaRelatedKeys) {
      const val = raw[key];
      console.log(`[scanSingleTweet] raw.${key}: type=${typeof val}, isArray=${Array.isArray(val)}, preview=${JSON.stringify(val)?.slice(0, 300)}`);
    }
    // Also log entities if present
    if (raw.entities) {
      console.log(`[scanSingleTweet] raw.entities keys: ${Object.keys(raw.entities).join(', ')}`);
      if (raw.entities.media) console.log(`[scanSingleTweet] raw.entities.media: ${JSON.stringify(raw.entities.media)?.slice(0, 300)}`);
    }

    const author = raw.author || raw.user || {};
    const username = author.userName || author.username || 'unknown';
    const user = { username, followers_count: Number(author.followers || 0) };

    const normalized = {
      id: String(raw.id || raw.tweetId || raw.rest_id || tweetId),
      text: raw.text || raw.full_text || raw.content || '',
      created_at: raw.createdAt || raw.created_at,
      public_metrics: {
        like_count: Number(raw.likeCount || raw.likes || 0),
        reply_count: Number(raw.replyCount || raw.replies || 0),
        retweet_count: Number(raw.retweetCount || raw.retweets || 0),
        quote_count: Number(raw.quoteCount || raw.quotes || 0),
        bookmark_count: Number(raw.bookmarkCount || raw.bookmarks || 0),
        view_count: Number(raw.viewCount || raw.views || 0)
      },
      entities: raw.entities || {},
      is_reply: Boolean(raw.isReply || raw.in_reply_to_status_id),
      author,
      raw
    };

    const analysis = analyzeXTweet(normalized, user);
    const score = scoreXTweet(normalized);
    const media = extractMediaFromTweet(normalized);

    // خزّن التحليل
    const supabase = supabaseAdmin();
    try {
      await supabase.from('viral_tweet_analyses').upsert({
        tweet_id: analysis.tweet_id,
        tweet_url: analysis.tweet_url,
        username,
        text: analysis.text.slice(0, 500),
        engagement_score: score,
        engagement_per_1k_followers: analysis.engagement_per_1k_followers,
        tweet_type: media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original'),
        metrics: analysis.metrics,
        has_media: media.length > 0,
        media_type: media.map(m => m.type).join(','),
        analyzed_at: new Date().toISOString()
      }, { onConflict: 'tweet_id' });
    } catch {}

    return {
      ok: true,
      analysis: { ...analysis, score },
      media,
      opportunity: score > 10 ? {
        type: 'quote',
        source_tweet_url: tweetUrl,
        source_text: analysis.text.slice(0, 200),
        source_author: username,
        source_metrics: analysis.metrics,
        media_urls: media,
        crafted_text: '',  // سيتم صياغته لاحقاً
        why: `تفاعل ${score} — ${analysis.has_question ? 'سؤال يثير نقاش' : 'محتوى قوي'}`,
        brain_rules_used: [],
        shield_passed: true,
        shield_issues: []
      } : undefined
    };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

function emptyResult(reason: string): ScanResult {
  return {
    accounts_scanned: 0,
    tweets_analyzed: 0,
    viral_tweets_found: 0,
    opportunities: [],
    brain_updates: { algorithm_rules: 0, style_patterns: 0, media_patterns: 0 },
    media_downloaded: 0
  };
}
