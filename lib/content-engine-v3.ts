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
import { queryBrainForContent } from './brain-query';

/**
 * Content Engine v3 — محرك محتوى مبني على الزحف لا على التوليد
 *
 * المبدأ: لا توليد AI للمحتوى (AI slop). بدل كذا:
 * 1. يزحف X ويحلل حسابات وتغريدات حقيقية
 * 2. يخزن الأنماط في العقل (قواعد صارمة)
 * 3. يكتشف فرص تفاعل حقيقية (رد، اقتباس، ثريد مبني على مصادر)
 * 4. يصيغ المحتوى بناءً على العقل فقط
 * 5. يحمل وسائط حقيقية من التغريدات (صور، فيديو، GIF) — للتحليل فقط، لا يرسلها
 *
 * v3.1: التحليل العميق يستخدم AI حقيقي (ليس hardcoded)
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
  debug_log: string[];  // سجل تشخيصي للـ server logs فقط
};

export type DeepAnalysis = {
  viralReason: string;
  stylePattern: string;
  adaptation: string;
  mediaImpact: string;
  timingInsight: string;
  tweetTypeInsight: string;
  engagementQuality: string;
  // v3.2: حقول التحليل متعدد الزوايا
  psychologicalTrigger: string;      // الآلية النفسية اللي فعّلت الانتشار
  audienceProfile: string;            // من تفاعل وليش
  conversationContext: string;        // سياق المحادثة/الردود
  preciseConcept: string;             // المفهوم الدقيق القابل للنقل
  conceptEvidence: string;            // الدليل الملموس من البيانات
  confidenceLevel: 'high' | 'medium' | 'low'; // مستوى الثقة بناءً على كمية الأدلة
};

// ═══ الزحف والتحليل ═══

/**
 * يزحف حسابات X المحفوظة ويحلل تغريداتها
 * + يحلل التغريدات المضافة يدوياً
 */
export async function scanXAccounts(maxAccounts = 5, tweetsPerAccount = 10): Promise<ScanResult> {
  const supabase = supabaseAdmin();
  const debugLog: string[] = [];

  // 1. جلب الحسابات المحفوظة — جرب عدة طرق مع تسجيل الأخطاء
  let accounts: any[] = [];

  // محاولة 1: بدون فلترات — أوسع استعلام ممكن
  try {
    const { data, error } = await supabase
      .from('accounts')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(maxAccounts);

    if (error) {
      debugLog.push(`[accounts] query error: ${error.message}`);
      console.error(`[scanXAccounts] accounts query error:`, error.message);
    } else if (data?.length) {
      accounts = data;
      debugLog.push(`[accounts] found ${data.length} accounts`);
    } else {
      debugLog.push(`[accounts] no data returned`);
    }
  } catch (e: any) {
    debugLog.push(`[accounts] exception: ${e.message}`);
    console.error(`[scanXAccounts] accounts exception:`, e.message);
  }

  // محاولة 2: select فقط الأعمدة الأساسية
  if (!accounts.length) {
    try {
      const { data, error } = await supabase
        .from('accounts')
        .select('handle, username')
        .limit(maxAccounts);

      if (error) {
        debugLog.push(`[accounts-fallback] error: ${error.message}`);
      } else if (data?.length) {
        accounts = data;
        debugLog.push(`[accounts-fallback] found ${data.length} accounts`);
      }
    } catch (e: any) {
      debugLog.push(`[accounts-fallback] exception: ${e.message}`);
    }
  }

  console.log(`[scanXAccounts] Found ${accounts.length} accounts to scan`);

  // 1.5. جلب التغريدات المضافة يدوياً (من viral_tweet_analyses)
  let manualTweetsCount = 0;
  let allAnalyzed: any[] = [];
  let allMedia: MediaFromTweet[] = [];
  let viralFound = 0;
  let totalAnalyzed = 0;

  try {
    const { data: manualTweets, error: mtError } = await supabase
      .from('viral_tweet_analyses')
      .select('*')
      .order('analyzed_at', { ascending: false })
      .limit(50);

    if (mtError) {
      debugLog.push(`[manual-tweets] error: ${mtError.message}`);
      console.error(`[scanXAccounts] manual tweets error:`, mtError.message);
    } else if (manualTweets?.length) {
      manualTweetsCount = manualTweets.length;
      for (const t of manualTweets) {
        totalAnalyzed++;
        const mediaTypes = (t.media_type || '').split(',').filter(Boolean);
        const tweetMedia: MediaFromTweet[] = mediaTypes.map((mt: string) => ({
          type: mt as 'photo' | 'video' | 'animated_gif',
          url: '',
          alt_text: ''
        }));

        if (t.engagement_score > 20 || t.engagement_per_1k_followers > 5) {
          viralFound++;
        }

        allAnalyzed.push({
          tweet_id: t.tweet_id,
          tweet_url: t.tweet_url,
          username: t.username,
          text: t.text,
          score: t.engagement_score,
          engagement_per_1k_followers: t.engagement_per_1k_followers,
          metrics: t.metrics || {},
          has_media: t.has_media,
          media: tweetMedia,
          has_question: (t.text || '').includes('?'),
          is_reply: t.tweet_type === 'reply',
          handle: t.username
        });

        allMedia.push(...tweetMedia);
      }
      debugLog.push(`[manual-tweets] loaded ${manualTweetsCount} tweets`);
      console.log(`[scanXAccounts] Loaded ${manualTweetsCount} manually analyzed tweets`);
    } else {
      debugLog.push(`[manual-tweets] no data found`);
    }
  } catch (e: any) {
    debugLog.push(`[manual-tweets] exception: ${e.message}`);
    console.error(`[scanXAccounts] Failed to load manual tweets: ${e.message}`);
  }

  // 2. زحف كل حساب
  for (const account of accounts.slice(0, maxAccounts)) {
    try {
      const handle = account.handle || account.username;
      if (!handle) {
        debugLog.push(`[scan] skipping account with no handle: ${JSON.stringify(account).slice(0, 100)}`);
        continue;
      }
      console.log(`[scanXAccounts] Scanning @${handle}...`);
      const tweets = await getXUserTimeline(handle, tweetsPerAccount, true);
      debugLog.push(`[scan] @${handle}: got ${tweets.length} tweets`);

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
              text: analysis.text.slice(0, 500),
              engagement_score: score,
              engagement_per_1k_followers: analysis.engagement_per_1k_followers,
              tweet_type: media.length > 0 ? 'media' : (analysis.is_reply ? 'reply' : 'original'),
              metrics: analysis.metrics,
              has_media: media.length > 0,
              media_type: media.map(m => m.type).join(','),
              analyzed_at: new Date().toISOString()
            }, { onConflict: 'tweet_id' });
          } catch (dbErr: any) {
            debugLog.push(`[scan] upsert viral error: ${dbErr.message}`);
          }

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
        } catch (dbErr: any) {
          debugLog.push(`[scan] upsert non-viral error: ${dbErr.message}`);
        }
      }

      // حدّث حالة الحساب
      try {
        const snapshot = await getXUserByUsername(handle);
        await supabase.from('accounts').update({
          notes: `Followers: ${snapshot.followers_count}, Scanned: ${new Date().toISOString()}`,
          updated_at: new Date().toISOString()
        }).eq('handle', handle);
      } catch (updErr: any) {
        debugLog.push(`[scan] update account error: ${updErr.message}`);
      }

    } catch (e: any) {
      const handle = account.handle || account.username || '?';
      debugLog.push(`[scan] FAILED @${handle}: ${e.message}`);
      console.error(`Failed to scan @${handle}:`, e.message);
    }
  }

  // 3. علّم العقل من البيانات المزحوفة — باستخدام التحليل العميق المخزّن
  let brainUpdates = { algorithmRules: 0, stylePatterns: 0, mcpOpportunities: 0 };
  try {
    // جلب قواعد الانتشار المخزّنة من التحليلات السابقة (من التغريدات اللي أُضيفت يدوياً)
    const { data: existingViralRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule_type, rule, evidence')
      .in('rule_type', ['viral_pattern', 'spread_pattern', 'media_impact'])
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(30);

    // جلب أنماط الأسلوب المخزّنة
    const { data: existingStylePatterns } = await supabase
      .from('viral_style_patterns')
      .select('pattern_name, pattern_description, adaptation_for_30piq')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(30);

    // بناء عناصر تعليمية غنية — تشمل التحليل العميق + المقاييس
    const crawlerItems = allAnalyzed.map(a => {
      // ابحث عن قاعدة الانتشار المرتبطة بهذي التغريدة
      const relatedRule = (existingViralRules || []).find((r: any) =>
        r.evidence?.includes(a.username) || r.evidence?.includes(a.tweet_id)
      );
      const relatedStyle = (existingStylePatterns || []).find((p: any) =>
        p.pattern_name?.includes(a.username) || p.evidence?.includes(a.username)
      );

      // بناء ملخص غني يشمل التحليل العميق
      const mediaDesc = a.media?.length > 0
        ? `Contains ${a.media.map((m: MediaFromTweet) => m.type).join('+')}`
        : 'Text only';
      const deepInsight = relatedRule?.rule || '';
      const styleInsight = relatedStyle?.pattern_description || '';

      let summary = `Engagement: ${a.score}, per 1K followers: ${a.engagement_per_1k_followers}, ${mediaDesc}`;
      if (deepInsight) summary += ` | Viral reason: ${deepInsight.slice(0, 150)}`;
      if (styleInsight) summary += ` | Style: ${styleInsight.slice(0, 100)}`;

      return {
        title: a.text?.slice(0, 200) || 'Tweet analysis',
        url: a.tweet_url,
        summary,
        confidence_score: Math.min(10, Math.max(1, Math.round(a.score / 10))),
      };
    });

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
    debugLog.push(`[brain] learning failed: ${e.message}`);
    console.error('Brain learning failed:', e.message);
  }

  // 3.5. تعليم مفاهيمي: اجمع أنماط مشتركة بين التغريدات واكتشف مفاهيم عامة
  try {
    if (allAnalyzed.length >= 2) {
      // اجمع كل نصوص التغريدات والتحليلات مع بعض عشان AI يكتشف مفاهيم مشتركة
      const tweetsForConcept = allAnalyzed
        .filter(a => (a.score || 0) > 20)
        .slice(0, 15)
        .map(a => ({
          text: a.text?.slice(0, 150),
          score: a.score,
          handle: a.handle || a.username,
          media: a.media?.map((m: MediaFromTweet) => m.type).join(',') || 'none',
          per1k: a.engagement_per_1k_followers
        }));

      if (tweetsForConcept.length >= 2) {
        const conceptResponse = await callModel('learning_extraction' as TaskType, [
          {
            role: 'system',
            content: `You are an expert viral pattern analyst. You are given a set of successful tweets and must discover the shared concepts between them.

Your task: Discover 1-3 general concepts/patterns shared across these tweets. Each concept must be:
1. Specific and actionable (not generic like "good content")
2. Connecting multiple tweets together
3. Providing a transferable recommendation — how can this MECHANIC (not topic) be applied to any account

Respond in JSON only:
{
  "concepts": [
    {
      "name": "Concept name",
      "description": "Explanation of the concept and its connection to the tweets",
      "adaptation": "How to apply this mechanic to any account"
    }
  ]
}`
          },
          {
            role: 'user',
            content: `Analyze these tweets and discover shared concepts:

${tweetsForConcept.map((t, i) => `${i + 1}. @${t.handle} (engagement: ${t.score}, media: ${t.media}): "${t.text}"`).join('\n\n')}`
          }
        ], { temperature: 0.15, max_tokens: 2000, response_format: { type: 'json_object' } });

        const parsed = parseModelJson(conceptResponse);
        const concepts = parsed.concepts || [];

        for (const concept of concepts.slice(0, 3)) {
          if (concept.name && concept.description) {
            await insertIfMissing(supabase, 'x_algorithm_learning_rules',
              { rule_type: 'viral_concept', rule: `${concept.name}: ${concept.description}` },
              {
                rule_type: 'viral_concept',
                rule: `${concept.name}: ${concept.description}`,
                evidence: `Shared concept extracted from ${tweetsForConcept.length} viral tweets`,
                source_type: 'batch_concept_extraction',
                source_url: '',
                applies_to: 'content_strategy,engagement_crafting',
                confidence_score: Math.min(10, 5 + Math.floor(tweetsForConcept.length / 3)),
                status: 'active',
                test_run: false,
                updated_at: new Date().toISOString()
              }
            );
            brainUpdates.algorithmRules++;

            // خزّن كمان كنمط أسلوبي
            if (concept.adaptation) {
              await insertIfMissing(supabase, 'viral_style_patterns',
                { pattern_name: concept.name.slice(0, 100) },
                {
                  pattern_name: concept.name.slice(0, 100),
                  pattern_description: concept.description,
                  adaptation_for_30piq: concept.adaptation,
                  evidence: `Shared concept from ${tweetsForConcept.length} viral tweets`,
                  source_type: 'batch_concept_extraction',
                  confidence_score: Math.min(10, 5 + Math.floor(tweetsForConcept.length / 3)),
                  status: 'active',
                  updated_at: new Date().toISOString()
                }
              );
              brainUpdates.stylePatterns++;
            }
          }
        }
        debugLog.push(`[brain-concepts] extracted ${concepts.length} concepts from ${tweetsForConcept.length} tweets`);
      }
    }
  } catch (e: any) {
    debugLog.push(`[brain-concepts] concept extraction failed: ${e.message}`);
    console.error('Concept extraction failed:', e.message);
  }

  // 3.5. علّم العقل أنماط الوسائط
  try {
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
    debugLog.push(`[brain-media] pattern failed: ${e.message}`);
    console.error('Media pattern learning failed:', e.message);
  }

  // 4. اكتشف فرص المحتوى
  const opportunities = await discoverOpportunities(allAnalyzed, allMedia);

  return {
    accounts_scanned: accounts.length + manualTweetsCount,
    tweets_analyzed: totalAnalyzed,
    viral_tweets_found: viralFound,
    opportunities,
    brain_updates: {
      algorithm_rules: brainUpdates.algorithmRules,
      style_patterns: brainUpdates.stylePatterns,
      media_patterns: allMedia.length
    },
    media_downloaded: allMedia.length,
    debug_log: debugLog
  };
}

// ═══ استخراج الوسائط ═══

/**
 * يستخرج الوسائط من تغريدة X (صور، فيديو، GIF)
 * إصدار 2 — استكشاف عميق 7 طبقات
 */
function extractMediaFromTweet(tweet: any, fullApiResponse?: any): MediaFromTweet[] {
  const media: MediaFromTweet[] = [];
  const raw = tweet.raw || tweet;
  const seen = new Set<string>();

  function addMedia(type: 'photo' | 'video' | 'animated_gif', url: string, alt_text = '') {
    if (!url || seen.has(url)) return;
    seen.add(url);
    media.push({ type, url, alt_text });
  }

  // ═══ 1. المسارات المباشرة ═══
  if (Array.isArray(raw.photos)) {
    for (const p of raw.photos) {
      const url = typeof p === 'string' ? p : (p.media_url_https || p.url || p.media_url || p.imageUrl || '');
      if (url) addMedia('photo', url, typeof p === 'object' ? (p.alt_text || '') : '');
    }
  }
  if (Array.isArray(raw.videos)) {
    for (const v of raw.videos) {
      const vidUrl = typeof v === 'string' ? v : (v.video_url || v.url || v.preview_url || '');
      if (vidUrl) addMedia(v.type === 'animated_gif' ? 'animated_gif' : 'video', vidUrl, typeof v === 'object' ? (v.alt_text || '') : '');
    }
  }
  if (raw.video && typeof raw.video === 'object' && !Array.isArray(raw.video)) {
    const vidUrl = raw.video.video_url || raw.video.url || raw.video.preview_url || '';
    if (vidUrl) addMedia(raw.video.type === 'animated_gif' ? 'animated_gif' : 'video', vidUrl, raw.video.alt_text || '');
  }
  if (raw.imageUrl) addMedia('photo', raw.imageUrl);
  if (raw.image && typeof raw.image === 'string') addMedia('photo', raw.image);

  // ═══ 2. مصفوفات الوسائط الموحدة ═══
  const sources: any[] = [];
  if (Array.isArray(raw.media)) sources.push(...raw.media);
  if (Array.isArray(raw.mediaDetails)) sources.push(...raw.mediaDetails);
  if (Array.isArray(raw.entities?.media)) sources.push(...raw.entities.media);
  if (Array.isArray(raw.extended_entities?.media)) sources.push(...raw.extended_entities.media);
  if (Array.isArray(raw.extendedEntities?.media)) sources.push(...raw.extendedEntities.media);
  if (Array.isArray(raw.entities?.medias)) sources.push(...raw.entities.medias);
  if (Array.isArray(raw.extendedEntities?.medias)) sources.push(...raw.extendedEntities.medias);

  for (const m of sources) {
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'photo' || m.media_url_https || m.media_url || m.display_url) {
      addMedia('photo', m.media_url_https || m.media_url || m.url || m.display_url || m.imageUrl || '', m.alt_text || m.ext_alt_text || '');
    } else if (m.type === 'video') {
      const variant = m.video_info?.variants?.find((v: any) => v.content_type === 'video/mp4') || m.video_info?.variants?.[0];
      addMedia('video', variant?.url || m.video_url || m.url || '', m.alt_text || m.ext_alt_text || '');
    } else if (m.type === 'animated_gif') {
      const variant = m.video_info?.variants?.find((v: any) => v.content_type === 'video/mp4') || m.video_info?.variants?.[0];
      addMedia('animated_gif', variant?.url || m.video_url || m.url || '', m.alt_text || m.ext_alt_text || '');
    }
  }

  // ═══ 3. فحص includes.media (صيغة Twitter API v2) ═══
  if (fullApiResponse) {
    const includesMedia = fullApiResponse?.includes?.media || fullApiResponse?.data?.includes?.media;
    if (Array.isArray(includesMedia)) {
      for (const m of includesMedia) {
        if (!m || typeof m !== 'object') continue;
        if (m.type === 'photo') {
          addMedia('photo', m.url || m.media_url || m.media_url_https || '');
        } else if (m.type === 'video') {
          const variant = m.variants?.find((v: any) => v.content_type === 'video/mp4') || m.variants?.[0];
          addMedia('video', variant?.url || m.url || '');
        } else if (m.type === 'animated_gif') {
          const variant = m.variants?.find((v: any) => v.content_type === 'video/mp4') || m.variants?.[0];
          addMedia('animated_gif', variant?.url || m.url || '');
        }
      }
    }
  }

  // ═══ 4. فحص entities.urls ═══
  const urlSources: any[] = [];
  if (Array.isArray(raw.entities?.urls)) urlSources.push(...raw.entities.urls);
  if (Array.isArray(raw.extended_entities?.urls)) urlSources.push(...raw.extended_entities.urls);
  if (Array.isArray(raw.extendedEntities?.urls)) urlSources.push(...raw.extendedEntities.urls);
  for (const u of urlSources) {
    if (!u || typeof u !== 'object') continue;
    const expandedUrl = u.expanded_url || u.expandedUrl || u.url || '';
    if (/twimg\.com\/media/i.test(expandedUrl)) addMedia('photo', expandedUrl);
  }

  // ═══ 5. فحص روابط t.co ═══
  const tweetText = raw.text || raw.full_text || raw.content || '';
  const tcoMatches = tweetText.match(/https?:\/\/t\.co\/\S+/g) || [];
  for (const tcoUrl of tcoMatches) {
    const match = urlSources.find((u: any) => u.url === tcoUrl);
    const expanded = match?.expanded_url || match?.expandedUrl;
    if (expanded && /twimg\.com/i.test(expanded)) addMedia('photo', expanded);
  }

  // ═══ 6. فحص صيغ TwitterAPI.io إضافية ═══
  if (Array.isArray(raw.mallizedUrls)) {
    for (const u of raw.mallizedUrls) {
      if (u?.media_url_https) addMedia('photo', u.media_url_https);
      if (u?.video_url) addMedia('video', u.video_url);
    }
  }
  if (Array.isArray(raw.photoUrls)) {
    for (const p of raw.photoUrls) { if (typeof p === 'string' && p) addMedia('photo', p); }
  }
  if (Array.isArray(raw.videoUrls)) {
    for (const v of raw.videoUrls) { if (typeof v === 'string' && v) addMedia('video', v); }
  }

  // ═══ 7. استكشاف عميق ═══
  if (media.length === 0) {
    deepScanForMedia(raw, addMedia, '', 0);
  }

  return media;
}

/**
 * فحص عميق متكرر — يبحث عن أي كائن وسائط في أي مكان في الشجرة
 */
function deepScanForMedia(obj: any, addMedia: (type: 'photo' | 'video' | 'animated_gif', url: string, alt?: string) => void, path: string, depth: number) {
  if (!obj || typeof obj !== 'object' || depth > 8) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      deepScanForMedia(obj[i], addMedia, `${path}[${i}]`, depth + 1);
    }
    return;
  }

  const type = obj.type;
  const mediaUrl = obj.media_url_https || obj.media_url || obj.imageUrl || obj.display_url;
  const videoUrl = obj.video_url || obj.video_info?.variants?.[0]?.url;
  const thumbUrl = obj.thumbnail_url || obj.thumbnail_image_url || obj.preview_url;

  if (type === 'photo' && mediaUrl) {
    addMedia('photo', mediaUrl, obj.alt_text || obj.ext_alt_text || '');
  } else if (type === 'video' && (videoUrl || thumbUrl)) {
    addMedia('video', videoUrl || thumbUrl || '', obj.alt_text || '');
  } else if (type === 'animated_gif' && (videoUrl || thumbUrl)) {
    addMedia('animated_gif', videoUrl || thumbUrl || '', obj.alt_text || '');
  } else if (mediaUrl && /twimg\.com|pbs\.twimg/i.test(mediaUrl)) {
    addMedia('photo', mediaUrl, obj.alt_text || '');
  } else if (videoUrl && /twimg\.com|video\.twimg/i.test(videoUrl)) {
    addMedia('video', videoUrl, obj.alt_text || '');
  }

  try {
    for (const key of Object.keys(obj)) {
      if (['raw', 'author', 'user', '__proto__', 'constructor'].includes(key)) continue;
      deepScanForMedia(obj[key], addMedia, `${path}.${key}`, depth + 1);
    }
  } catch {}
}

// ═══ جلب سياق المحادثة ═══

/**
 * يجلب ردود وتفاعلات التغريدة من TwitterAPI.io
 * هذا يعطي العقل فهم أعمق: شنو قال الناس، كيف تفاعلوا، أيش السبب الحقيقي
 */
async function fetchConversationContext(
  tweetId: string,
  username: string
): Promise<{ replies: string[]; topReplierInsight: string }> {
  try {
    const url = new URL(`${twitterApiBase()}/twitter/tweet/replies`);
    url.searchParams.set('tweetId', tweetId);
    const json = await fetchTwitterApiJson(url.toString());
    const replies = extractTweets(json).slice(0, 10);

    if (!replies.length) return { replies: [], topReplierInsight: '' };

    const replyTexts = replies
      .map(r => r.text || '')
      .filter(t => t.length > 5)
      .slice(0, 8);

    // خلاصة سريعة: شنو الأغلبية تقول
    const themes = replyTexts.slice(0, 5).map(t => t.slice(0, 100)).join(' | ');
    const topReplierInsight = `Top reply themes: ${themes}`;

    return { replies: replyTexts, topReplierInsight };
  } catch (e: any) {
    console.log('[fetchConversationContext] Could not fetch replies:', e.message);
    return { replies: [], topReplierInsight: '' };
  }
}

// ═══ التحليل العميق متعدد الزوايا ═══

/**
 * تحليل عميق متعدد الزوايا — v3.2
 *
 * الفرق عن v3.1:
 * - v3.1: باص واحد، 7 حقول عامة، بدون سياق محادثة
 * - v3.2: جلب سياق المحادثة + تحليل من 5 زوايا + استخراج مفهوم دقيق
 *         + تقييم ثقة بناءً على كمية الأدلة
 *         + كل النتائج بالإنجليزية (لغة المحتوى)
 */
async function deepAnalyzeWithAI(
  tweetText: string,
  metrics: Record<string, number>,
  followers: number,
  media: MediaFromTweet[],
  username: string,
  tweetType: 'original' | 'quote' | 'reply' | 'thread_starter' = 'original',
  quotedTweetText: string = '',
  quotedTweetAuthor: string = '',
  createdAt: string | null = null,
  timeLabel: string | null = null,
  tweetId: string = '',
  existingBrainRules: any[] = []
): Promise<DeepAnalysis> {
  const score = (metrics.like_count || 0) + (metrics.reply_count || 0) * 2 +
    (metrics.retweet_count || 0) * 3 + (metrics.quote_count || 0) * 4 +
    (metrics.bookmark_count || 0) * 2 + Math.min(metrics.view_count || 0, 100000) / 1000;

  const likeToFollowerRatio = followers > 0 ? ((metrics.like_count || 0) / followers).toFixed(4) : 'N/A';
  const replyRatio = (metrics.like_count || 0) > 0 ? ((metrics.reply_count || 0) / metrics.like_count!).toFixed(3) : '0';
  const rtRatio = (metrics.like_count || 0) > 0 ? ((metrics.retweet_count || 0) / metrics.like_count!).toFixed(3) : '0';
  const quoteRatio = (metrics.like_count || 0) > 0 ? ((metrics.quote_count || 0) / metrics.like_count!).toFixed(3) : '0';
  const bookmarkRatio = (metrics.like_count || 0) > 0 ? ((metrics.bookmark_count || 0) / metrics.like_count!).toFixed(3) : '0';

  const mediaDesc = media.length > 0
    ? `Contains ${media.map(m => m.type).join(' + ')}`
    : 'Text only, no media';

  // ═══ جلب سياق المحادثة (ردود الناس) ═══
  let conversationData = { replies: [] as string[], topReplierInsight: '' };
  if (tweetId && (metrics.reply_count || 0) > 5) {
    conversationData = await fetchConversationContext(tweetId, username);
  }

  const quoteContext = tweetType === 'quote' && quotedTweetText
    ? `\nQuoted Tweet by @${quotedTweetAuthor}: "${quotedTweetText.slice(0, 300)}"\nThis is a QUOTE TWEET — the author is commenting on the above tweet. Analyze how the commentary adds value or creates contrast with the original.`
    : '';

  const replyContext = tweetType === 'reply'
    ? `\nThis is a REPLY tweet — it's part of a conversation. The virality likely comes from the reply adding significant value, humor, or a contrarian take to the original discussion.`
    : '';

  const timingContext = timeLabel
    ? `\nPosted at: ${timeLabel}. Consider if this timing aligns with peak engagement hours for the audience.`
    : '';

  const repliesContext = conversationData.replies.length > 0
    ? `\n\nSample of real replies people wrote:\n${conversationData.replies.slice(0, 5).map((r, i) => `  ${i + 1}. "${r.slice(0, 120)}"`).join('\n')}\n\nThese replies reveal WHY people engaged — study them for the actual trigger.`
    : '';

  // ═══ المفاهيم الموجودة في العقل — عشان ما يكررها ويضيف عليها ═══
  const existingConceptsSummary = existingBrainRules.length > 0
    ? `\n\nExisting concepts already in the brain (do NOT repeat these — find NEW insights):\n${existingBrainRules.slice(0, 8).map(r => `- [${r.rule_type}] ${String(r.rule).slice(0, 100)}`).join('\n')}`
    : '';

  try {
    const aiResponse = await callModel('deep_analysis' as TaskType, [
      {
        role: 'system',
        content: `You are an expert viral content analyst who thinks like a researcher, not a content marketer. You analyze X (Twitter) posts to understand exactly WHY they went viral — from multiple angles, with evidence-based reasoning.

CRITICAL RULES:
1. ALL output must be in ENGLISH (the account content is English, analysis must match)
2. Do NOT assume any specific niche for @30piq — the account covers diverse topics and can tweet about anything
3. Be specific and precise — NEVER use vague phrases like "engaging content", "high interaction", "resonated with audience". Name the exact psychological mechanism.
4. Every claim must reference SPECIFIC data from the tweet — text, metrics, replies, or context. No speculation without evidence.
5. Think in angles — analyze from multiple perspectives, then synthesize

ANALYSIS FRAMEWORK — Think through these 5 angles:

ANGLE 1: TEXT MECHANICS
- What specifically about the wording made it spread? Not "short tweet" but exact technique: "Opens with a contrarian claim that challenges conventional wisdom, then reveals the insight in a single line"
- Is it a question, a statement, a revelation, a hot take, humor, vulnerability, a challenge?
- What structural technique? (setup→punchline, before→after, claim→evidence, observation→implication)

ANGLE 2: PSYCHOLOGICAL TRIGGER
- What specific psychological mechanism activated? Choose one or more:
  Identity signaling (people RT to signal who they are), Validation (people see their experience reflected),
  Surprise/Novelty (unexpected insight), Status sharing (sharing makes you look smart/connected),
  Controversy/Debate (forces people to take sides), Humor/Social currency (sharing makes others laugh),
  FOMO (fear of missing out), Practical value (bookmark-worthy utility)
- Why did THIS specific trigger work for THIS specific audience?

ANGLE 3: ENGAGEMENT ARCHAEOLOGY
- Reply/Like ratio → Did it spark discussion? What were people discussing (see actual replies)?
- RT/Like ratio → Was it shareable as an opinion or information?
- Quote/Like ratio → Did people add their own takes? What angle did they take?
- Bookmark/Like ratio → Was it reference-worthy? Why save it?
- Like/Follower ratio → Did it break out of the author's audience? To whom?

ANGLE 4: CONTEXT & TYPE
- Is it original, quote, reply, thread starter? How does the TYPE create the viral condition?
- If quote tweet: what's the contrast/added value between original and commentary?
- If reply: what value did it add to the original conversation?
- Timing: does the posting time suggest alignment with a trend, event, or peak hours?
- Language/cultural context: any slang, references, or cultural signals?

ANGLE 5: TRANSFERABLE CONCEPT
- Extract the ONE transferable mechanic — not the topic, but the PATTERN
- This must be so specific that someone could apply it to any niche
- Example BAD: "Share valuable insights" → Example GOOD: "Make a bold counter-intuitive claim about a common tool, then reveal the hidden cost nobody considers"
- What evidence from THIS tweet supports this concept?

Respond in JSON only, no additional text:
{
  "viralReason": "The exact reason it went viral — specific mechanism connected to specific evidence",
  "stylePattern": "The writing technique — name the specific structural device, not just 'concise'",
  "adaptation": "How to apply this MECHANIC (not topic) — must be actionable and niche-independent",
  "mediaImpact": "How media contributed — specific reason, or 'Text-driven virality, media not primary driver'",
  "timingInsight": "Timing analysis with evidence — or 'Timing not a significant factor' with reason",
  "tweetTypeInsight": "How the tweet type contributed — specific mechanism, not just 'quote tweet'",
  "engagementQuality": "What ratios reveal about audience behavior — specific, not generic",
  "psychologicalTrigger": "The primary psychological mechanism — name it specifically with evidence",
  "audienceProfile": "Who engaged and why — based on reply analysis and ratio evidence",
  "conversationContext": "What the replies reveal about WHY people engaged — quote actual reply themes",
  "preciseConcept": "The ONE transferable concept — so specific it could be a formula",
  "conceptEvidence": "Specific data points from THIS tweet that prove the concept",
  "confidenceLevel": "high (3+ strong evidence points), medium (1-2 evidence points), or low (mostly inference)"
}`
      },
      {
        role: 'user',
        content: `Analyze this tweet from multiple angles:

Text: "${tweetText}"

Author: @${username}
Followers: ${followers}
Engagement Score: ${score}
Tweet Type: ${tweetType}${quoteContext}${replyContext}${timingContext}

Metrics:
- Likes: ${metrics.like_count || 0}
- Replies: ${metrics.reply_count || 0}
- Retweets: ${metrics.retweet_count || 0}
- Quotes: ${metrics.quote_count || 0}
- Bookmarks: ${metrics.bookmark_count || 0}
- Views: ${metrics.view_count || 0}

Ratios:
- Like/Follower: ${likeToFollowerRatio}
- Reply/Like: ${replyRatio}
- RT/Like: ${rtRatio}
- Quote/Like: ${quoteRatio}
- Bookmark/Like: ${bookmarkRatio}

Media: ${mediaDesc}${repliesContext}${existingConceptsSummary}

Give a deep, multi-angle analysis with evidence. Every claim must reference specific data above.`
      }
    ], { temperature: 0.12, max_tokens: 4000, response_format: { type: 'json_object' } });

    const parsed = parseModelJson(aiResponse);
    const confidence = parsed.confidenceLevel;
    const validConfidence = ['high', 'medium', 'low'].includes(confidence) ? confidence : 'medium';

    return {
      viralReason: parsed.viralReason || 'Analysis unavailable',
      stylePattern: parsed.stylePattern || 'Pattern unidentified',
      adaptation: parsed.adaptation || 'No adaptation suggestion',
      mediaImpact: parsed.mediaImpact || mediaDesc,
      timingInsight: parsed.timingInsight || 'No timing data available',
      tweetTypeInsight: parsed.tweetTypeInsight || `${tweetType} tweet`,
      engagementQuality: parsed.engagementQuality || 'Standard engagement pattern',
      psychologicalTrigger: parsed.psychologicalTrigger || 'Unidentified trigger',
      audienceProfile: parsed.audienceProfile || 'General audience',
      conversationContext: parsed.conversationContext || 'No reply data available',
      preciseConcept: parsed.preciseConcept || 'No concept extracted',
      conceptEvidence: parsed.conceptEvidence || 'No specific evidence cited',
      confidenceLevel: validConfidence as 'high' | 'medium' | 'low'
    };
  } catch (e: any) {
    console.error('[deepAnalyzeWithAI] AI analysis failed, using fallback:', e.message);

    const likeToFoll = followers > 0 ? (metrics.like_count || 0) / followers : 0;
    const reasons: string[] = [];
    if (likeToFoll > 0.1) reasons.push(`Very high like/follower ratio (${(likeToFoll * 100).toFixed(1)}%) — content reached far beyond the author's audience`);
    if (parseFloat(replyRatio) > 0.3) reasons.push(`High reply ratio (${replyRatio}) — sparked discussion`);
    if (parseFloat(rtRatio) > 0.3) reasons.push(`High RT ratio (${rtRatio}) — highly shareable content`);
    if (parseFloat(quoteRatio) > 0.2) reasons.push(`High quote ratio (${quoteRatio}) — triggered strong reactions`);
    if (media.length > 0) reasons.push(`Contains media (${media.map(m => m.type).join(', ')})`);
    if (!reasons.length) reasons.push(`High total engagement (${score})`);

    return {
      viralReason: reasons.slice(0, 3).join(' | '),
      stylePattern: `${tweetText.length < 100 ? 'Short and concise' : tweetText.length < 280 ? 'Medium length' : 'Long-form'} ${tweetType} tweet by @${username}`,
      adaptation: 'Apply this spread pattern mechanic to content strategy',
      mediaImpact: mediaDesc,
      timingInsight: timeLabel ? `Posted at ${timeLabel}` : 'No timing data',
      tweetTypeInsight: `${tweetType} tweet`,
      engagementQuality: `Reply/Like: ${replyRatio}, RT/Like: ${rtRatio}, Quote/Like: ${quoteRatio}, Bookmark/Like: ${bookmarkRatio}`,
      psychologicalTrigger: 'Could not determine — AI analysis failed',
      audienceProfile: 'Unknown — AI analysis failed',
      conversationContext: conversationData.topReplierInsight || 'No conversation data',
      preciseConcept: 'No concept extracted — AI analysis failed',
      conceptEvidence: reasons.slice(0, 2).join('; '),
      confidenceLevel: 'low'
    };
  }
}

// ═══ نظام التعلم الحقيقي — دمج وتطوير المفاهيم ═══

/**
 * upsertBrainConcept — العقل يتعلم فعليًا
 *
 * الفرق عن insertIfMissing:
 * - insertIfMissing: يتخطى لو المفهوم موجود → تخزين فقط
 * - upsertBrainConcept: يدمج الأدلة + يزيد الثقة + يحدّث القاعدة → تعلم حقيقي
 *
 * آلية التعلم:
 * 1. لو المفهوم جديد → يضيفه بالثقة الأولية
 * 2. لو المفهوم موجود ومتطابق → يزيد الثقة + يضيف دليل جديد
 * 3. لو المفهوم موجود لكن مختلف شوي → يوسّع القاعدة
 */
async function upsertBrainConcept(
  supabase: any,
  table: 'x_algorithm_learning_rules' | 'viral_style_patterns',
  matchKey: Record<string, any>,
  payload: Record<string, any>,
  newEvidence: string
): Promise<'inserted' | 'reinforced' | 'failed'> {
  try {
    // ابحث عن مفهوم مشابه
    let query = supabase.from(table).select('*').limit(1);
    for (const [key, val] of Object.entries(matchKey)) {
      query = val == null ? query.is(key, null) : query.eq(key, val);
    }
    const existing = await query.maybeSingle();

    if (!existing.data?.id) {
      // مفهوم جديد — أضفه
      const inserted = await supabase.from(table).insert(payload).select('id').single();
      if (inserted.error) throw inserted.error;
      console.log(`[brain-learn] NEW concept: ${String(matchKey[Object.keys(matchKey)[0]]).slice(0, 60)}`);
      return 'inserted';
    }

    // ═══ مفهوم موجود — علّم عليه (دمج + تطوير) ═══
    const existingData = existing.data;
    const currentConfidence = Number(existingData.confidence_score) || 5;

    // زِد الثقة (لكن مو أكثر من 10)
    const newConfidence = Math.min(10, currentConfidence + 0.5);

    // أضف الدليل الجديد للأدلة الموجودة
    const existingEvidence = existingData.evidence || '';
    const updatedEvidence = existingEvidence.length > 800
      ? `${existingEvidence.slice(0, 400)} | +${newEvidence.slice(0, 300)}`
      : `${existingEvidence} | +${newEvidence}`;

    // حدّث الثقة والأدلة
    const updateResult = await supabase
      .from(table)
      .update({
        confidence_score: newConfidence,
        evidence: updatedEvidence.slice(0, 1000),
        updated_at: new Date().toISOString(),
        test_run: false
      })
      .eq('id', existingData.id);

    if (updateResult.error) throw updateResult.error;
    console.log(`[brain-learn] REINFORCED concept (${currentConfidence.toFixed(1)}→${newConfidence.toFixed(1)}): ${String(matchKey[Object.keys(matchKey)[0]]).slice(0, 60)}`);
    return 'reinforced';
  } catch (e: any) {
    console.error('[upsertBrainConcept] failed:', e.message);
    return 'failed';
  }
}

// ═══ فرص التفاعل ═══

async function discoverOpportunities(
  analyzed: any[],
  media: MediaFromTweet[]
): Promise<ContentOpportunity[]> {
  if (!analyzed.length) return [];

  const supabase = supabaseAdmin();
  const opportunities: ContentOpportunity[] = [];

  const { data: algoRules } = await supabase
    .from('x_algorithm_learning_rules')
    .select('rule_type, rule, applies_to, evidence')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  const { data: stylePatterns } = await supabase
    .from('viral_style_patterns')
    .select('pattern_name, pattern_description, adaptation_for_30piq')
    .eq('status', 'active')
    .order('confidence_score', { ascending: false })
    .limit(10);

  const sorted = [...analyzed].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);

  for (const tweet of sorted) {
    const tweetMedia = tweet.media || [];
    const rulesUsed: string[] = [];

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

  return opportunities.filter(o => o.shield_passed || o.shield_issues.length <= 2);
}

async function craftEngagement(
  type: 'reply' | 'quote',
  tweet: any,
  algoRules: any[],
  stylePatterns: any[],
  rulesUsed: string[]
): Promise<string | null> {
  try {
    // ═══ استرجاع ذكي من العقل مع تعليمات تطبيق دقيقة ═══
    const brainQuery = await queryBrainForContent(type === 'reply' ? 'reply' : 'quote', 6, 3);
    const brainContext = brainQuery.compiled_prompt_context;

    // لو العقل فيه مفاهيم، استخدمها؛ لو فارغ، استخدم القواعد القديمة
    const hasBrainLearning = brainQuery.concepts.length > 0 || brainQuery.patterns.length > 0;
    const fallbackRules = algoRules.slice(0, 5).map(r => `- ${r.rule} (evidence: ${(r.evidence || '').slice(0, 80)})`).join('\n');
    const fallbackPatterns = stylePatterns.slice(0, 5).map(p => `- ${p.pattern_name}: ${p.pattern_description}`).join('\n');

    const learningContext = hasBrainLearning
      ? brainContext
      : `Algorithm rules:\n${fallbackRules}\n\nStyle patterns:\n${fallbackPatterns}`;

    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `أنت تكتب لتغريدات X لحساب @${optionalEnv('X_USERNAME', '30piq')}.

قواعد صارمة:
1. لا تستخدم أي كلمات AI slop (delve, crucial, leverage, game-changer, unlock, etc.)
2. لا هاشتاقات
3. لا أرقام بدون مصدر
4. لا قوائم مرقمة أو نقط متطابقة
5. صوت طبيعي — كأنك صديق ذكي يتكلم، مو آلة محتوى
6. أقل من 240 حرف
7. لا تكرر نفس الفكرة بطريقة مختلفة
8. أضف عنصر شخصي أو مرجع محدد

${learningContext}

IMPORTANT: When you write, you MUST follow the APPLICATION INSTRUCTION for each concept. Each concept tells you HOW to apply it — read the "HOW TO APPLY" instruction and follow it precisely. Do not just reference the concept — embody it in your writing technique.

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

    // سجّل إيش استخدم من المفاهيم
    if (hasBrainLearning) {
      for (const c of brainQuery.concepts.slice(0, 3)) {
        rulesUsed.push(c.concept_type || 'unknown');
      }
    } else {
      for (const rule of algoRules.slice(0, 3)) {
        rulesUsed.push(rule.rule_type || 'unknown');
      }
    }

    return text;
  } catch {
    return null;
  }
}

async function craftThreadFromBrain(
  algoRules: any[],
  stylePatterns: any[]
): Promise<{ type: 'thread' | 'article'; text: string; why: string; rules: string[] } | null> {
  try {
    // ═══ استرجاع ذكي من العقل ═══
    const brainQuery = await queryBrainForContent('thread', 6, 5);
    const hasBrainLearning = brainQuery.concepts.length > 0 || brainQuery.patterns.length > 0;

    // fallback لو العقل فارغ
    const fallbackPatterns = stylePatterns.slice(0, 5);
    const fallbackRules = algoRules.slice(0, 5);

    let learningContext: string;
    let topPatterns: any[];
    let topRules: any[];

    if (hasBrainLearning) {
      learningContext = brainQuery.compiled_prompt_context;
      topPatterns = brainQuery.patterns;
      topRules = brainQuery.concepts;
    } else {
      topPatterns = fallbackPatterns;
      topRules = fallbackRules;
      learningContext = `أنماط ناجحة لتستلهم منها:\n${topPatterns.map(p => `- ${p.pattern_name}: ${p.pattern_description}`).join('\n')}\n\nقواعد الخوارزمية:\n${topRules.map(r => `- ${r.rule}`).join('\n')}`;
    }

    const response = await callModel('content_crafting' as TaskType, [
      {
        role: 'system',
        content: `أنت تكتب لحساب @${optionalEnv('X_USERNAME', '30piq')}.

قواعد صارمة:
1. لا AI slop (delve, crucial, leverage, game-changer, unlock, etc.)
2. لا هاشتاقات
3. لا أرقام بدون مصدر
4. صوت طبيعي — صديق ذكي مو آلة محتوى
5. كل تغريدة في الثرد مستقلة وقوية لحالها
6. التغريدة الأولى = هوك قوي (سؤال أو حقيقة صادمة أو رأي مثير)
7. لا تكرار

${learningContext}

CRITICAL: You MUST follow the APPLICATION INSTRUCTION for each concept. Each concept tells you exactly HOW to apply it — follow the "HOW TO APPLY" instruction precisely. Do not just reference the concept — embody it in your writing technique and thread structure.

اكتب ثريد من 3-5 تغريدات. افصل بين كل تغريدة بسطر فيه "---" فقط.`
      },
      {
        role: 'user',
        content: hasBrainLearning
          ? `اكتب ثريد مبني على مفاهيم العقل المتعلمة. كل مفهوم فيه تعليمة تطبيق — اتبعها بدقة.`
          : `اكتب ثريد عن واحد من هذي المواضيع بناءً على أنماط العقل:\n${topPatterns.map(p => p.pattern_name).join('، ')}`
      }
    ]);

    const text = String(response || '').trim();
    if (text.length < 50) return null;

    const usedRules = hasBrainLearning
      ? brainQuery.concepts.slice(0, 5).map(c => c.concept_type || 'unknown')
      : topRules.map(r => r.rule_type || 'unknown');

    return {
      type: 'thread',
      text,
      why: `مبني على ${brainQuery.concepts.length || topRules.length} مفاهيم و${brainQuery.patterns.length || topPatterns.length} أنماط من العقل`,
      rules: usedRules
    };
  } catch {
    return null;
  }
}

// ═══ تحليل تغريدة واحدة ═══

/**
 * يزحف تغريدة واحدة بالمعرف (للإضافة اليدوية)
 * يستخدم AI للتحليل العميق — ليس قوالب hardcoded
 */
export async function scanSingleTweet(tweetUrl: string): Promise<{
  ok: boolean;
  analysis?: any;
  media?: MediaFromTweet[];
  opportunity?: ContentOpportunity;
  error?: string;
  deepAnalysis?: DeepAnalysis;
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

    // تشخيص في server logs فقط
    const rawKeys = Object.keys(raw || {});
    const mediaRelatedKeys = rawKeys.filter(k => /media|photo|video|image|gif|attach|entity/i.test(k));
    console.log(`[scanSingleTweet] Raw keys: ${rawKeys.join(', ')}`);
    console.log(`[scanSingleTweet] Media-related keys: ${mediaRelatedKeys.join(', ') || 'NONE'}`);
    console.log(`[scanSingleTweet] Full API response top keys: ${Object.keys(json || {}).join(', ')}`);
    for (const key of mediaRelatedKeys) {
      const val = raw[key];
      console.log(`[scanSingleTweet] raw.${key}: type=${typeof val}, isArray=${Array.isArray(val)}, preview=${JSON.stringify(val)?.slice(0, 500)}`);
    }
    if (raw.entities) {
      console.log(`[scanSingleTweet] raw.entities keys: ${Object.keys(raw.entities).join(', ')}`);
    }
    if (raw.extendedEntities) {
      console.log(`[scanSingleTweet] raw.extendedEntities keys: ${Object.keys(raw.extendedEntities).join(', ')}`);
    }
    console.log(`[scanSingleTweet] FULL RAW: ${JSON.stringify(raw)?.slice(0, 3000)}`);

    const author = raw.author || raw.user || {};
    const username = author.userName || author.username || 'unknown';
    const user = { username, followers_count: Number(author.followers || 0) };

    // ═══ Detect tweet type and extract metadata ═══
    const isQuoteTweet = Boolean(raw.isQuote || raw.quotedStatusId || raw.quoted_status_id);
    const isReply = Boolean(raw.isReply || raw.in_reply_to_status_id);
    const conversationId = raw.conversationId || raw.conversation_id || null;
    const isThreadStarter = Boolean(conversationId && String(conversationId) === String(raw.id || raw.tweetId || raw.rest_id));

    let tweetType: 'original' | 'quote' | 'reply' | 'thread_starter' = 'original';
    if (isQuoteTweet) tweetType = 'quote';
    else if (isReply) tweetType = 'reply';
    else if (isThreadStarter) tweetType = 'thread_starter';

    // Extract quoted tweet data
    let quotedTweetText = raw.quotedStatus?.text || raw.quoted_status?.text || raw.quotedTweet?.text || '';
    let quotedTweetAuthor = raw.quotedStatus?.author?.userName || raw.quoted_status?.author?.userName || raw.quotedTweet?.author?.userName || '';
    const quotedTweetId = raw.quotedStatusId || raw.quoted_status_id || raw.quotedTweet?.id || null;

    // If it's a quote tweet but we don't have the quoted text, try fetching it
    if (isQuoteTweet && !quotedTweetText && quotedTweetId) {
      try {
        const quotedJson = await fetchTwitterApiJson(`${base}/twitter/tweets?tweet_ids=${quotedTweetId}`);
        const quotedTweets = extractTweets(quotedJson);
        if (quotedTweets.length) {
          const qt = quotedTweets[0];
          quotedTweetText = qt.text || qt.full_text || qt.content || '';
          quotedTweetAuthor = qt.author?.userName || qt.user?.userName || '';
        }
      } catch (e: any) {
        console.log(`[scanSingleTweet] Failed to fetch quoted tweet ${quotedTweetId}: ${e.message}`);
      }
    }

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
      entities: raw.entities || raw.extendedEntities || {},
      extended_entities: raw.extendedEntities || raw.extended_entities || raw.entities || {},
      is_reply: isReply,
      is_quote_tweet: isQuoteTweet,
      quoted_tweet_id: quotedTweetId,
      quoted_tweet_text: quotedTweetText,
      quoted_tweet_author: quotedTweetAuthor,
      conversation_id: conversationId,
      is_thread_starter: isThreadStarter,
      language: raw.lang || raw.language || null,
      author,
      raw
    };

    const analysis = analyzeXTweet(normalized, user);
    const score = scoreXTweet(normalized);
    const media = extractMediaFromTweet(normalized, json);

    // خزّن التحليل
    const supabase = supabaseAdmin();

    // ═══ Deep analysis with AI — English, no hardcoded niche, full metadata ═══
    // جلب المفاهيم الموجودة في العقل عشان التحليل ما يكررها
    const { data: existingRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('rule_type, rule, evidence')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(15);

    const deepAnalysis = await deepAnalyzeWithAI(
      analysis.text,
      analysis.metrics,
      user.followers_count,
      media,
      username,
      tweetType,
      quotedTweetText,
      quotedTweetAuthor,
      analysis.created_at,
      analysis.time_label,
      analysis.tweet_id,
      existingRules || []
    );

    try {
      await supabase.from('viral_tweet_analyses').upsert({
        tweet_id: analysis.tweet_id,
        tweet_url: analysis.tweet_url,
        username,
        text: analysis.text.slice(0, 500),
        engagement_score: score,
        engagement_per_1k_followers: analysis.engagement_per_1k_followers,
        tweet_type: tweetType,
        metrics: analysis.metrics,
        has_media: media.length > 0,
        media_type: media.map(m => m.type).join(','),
        analyzed_at: new Date().toISOString()
      }, { onConflict: 'tweet_id' });
    } catch (dbErr: any) {
      console.error('[scanSingleTweet] upsert error:', dbErr.message);
    }

    // ═══ خزّن التحليل العميق في العقل — v3.2: تعلم حقيقي ═══
    try {
      const confidenceBase = deepAnalysis.confidenceLevel === 'high' ? 7 : deepAnalysis.confidenceLevel === 'medium' ? 5 : 3;
      const scoreBoost = Math.min(3, Math.round(score / 100));
      const baseConfidence = Math.min(10, confidenceBase + scoreBoost);

      // 1. المفهوم الدقيق — أهم شيء يتعلمه العقل
      if (deepAnalysis.preciseConcept && deepAnalysis.preciseConcept !== 'No concept extracted') {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'precise_concept', rule: deepAnalysis.preciseConcept },
          {
            rule_type: 'precise_concept',
            rule: deepAnalysis.preciseConcept,
            evidence: `@${username}: ${deepAnalysis.conceptEvidence} | ${deepAnalysis.viralReason.slice(0, 150)}`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'content_strategy,engagement_crafting,viral_mechanics',
            confidence_score: baseConfidence,
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} (${score} engagement): ${deepAnalysis.conceptEvidence}`
        );
      }

      // 2. الآلية النفسية — كيف فعّل الناس
      if (deepAnalysis.psychologicalTrigger && deepAnalysis.psychologicalTrigger !== 'Unidentified trigger') {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'psychological_trigger', rule: deepAnalysis.psychologicalTrigger },
          {
            rule_type: 'psychological_trigger',
            rule: deepAnalysis.psychologicalTrigger,
            evidence: `@${username} (${score} eng): ${deepAnalysis.audienceProfile.slice(0, 200)}`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'content_psychology,engagement_prediction',
            confidence_score: Math.max(3, baseConfidence - 1),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} tweet: ${deepAnalysis.conversationContext.slice(0, 150)}`
        );
      }

      // 3. نمط الانتشار
      if (deepAnalysis.viralReason) {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'viral_pattern', rule: deepAnalysis.viralReason },
          {
            rule_type: 'viral_pattern',
            rule: deepAnalysis.viralReason,
            evidence: `@${username} (${score} eng, ${analysis.engagement_per_1k_followers}/1K): "${analysis.text.slice(0, 80)}"`,
            source_type: 'manual_tweet_analysis',
            source_url: tweetUrl,
            applies_to: 'content_scoring,engagement_prediction',
            confidence_score: Math.max(3, baseConfidence - 1),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} (${score} eng): ${deepAnalysis.viralReason.slice(0, 100)}`
        );
      }

      // 4. نمط أسلوبي — كيف كُتبت
      if (deepAnalysis.stylePattern) {
        await upsertBrainConcept(supabase, 'viral_style_patterns',
          { pattern_name: deepAnalysis.stylePattern.slice(0, 100) },
          {
            pattern_name: deepAnalysis.stylePattern.slice(0, 100),
            pattern_description: `${deepAnalysis.stylePattern}. Trigger: ${deepAnalysis.psychologicalTrigger}`,
            adaptation_for_30piq: deepAnalysis.adaptation || '',
            evidence: `@${username}: "${analysis.text.slice(0, 60)}" → ${score} eng. ${deepAnalysis.conceptEvidence}`,
            source_type: 'multi_angle_analysis',
            confidence_score: baseConfidence,
            status: 'active',
            updated_at: new Date().toISOString()
          },
          `@${username} (${score} eng): ${deepAnalysis.stylePattern.slice(0, 80)}`
        );
      }

      // 5. قاعدة وسائط
      if (media.length > 0 && deepAnalysis.mediaImpact) {
        const mediaRule = `${media.map(m => m.type).join('+')}: ${deepAnalysis.mediaImpact}`;
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'media_impact', rule: mediaRule },
          {
            rule_type: 'media_impact',
            rule: mediaRule,
            evidence: `@${username} with ${media.map(m => m.type).join(',')} → ${score} eng`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'media_strategy,content_scoring',
            confidence_score: Math.max(3, baseConfidence - 1),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username}: ${media.map(m => m.type).join('+')} → ${score} eng`
        );
      }

      // 6. سياق المحادثة (إن وُجد)
      if (deepAnalysis.conversationContext && deepAnalysis.conversationContext !== 'No reply data available') {
        await upsertBrainConcept(supabase, 'x_algorithm_learning_rules',
          { rule_type: 'conversation_context', rule: deepAnalysis.conversationContext.slice(0, 200) },
          {
            rule_type: 'conversation_context',
            rule: deepAnalysis.conversationContext.slice(0, 200),
            evidence: `@${username} (${analysis.metrics.reply_count || 0} replies): ${deepAnalysis.audienceProfile.slice(0, 150)}`,
            source_type: 'multi_angle_analysis',
            source_url: tweetUrl,
            applies_to: 'reply_strategy,engagement_crafting',
            confidence_score: Math.max(3, baseConfidence - 2),
            status: 'active',
            test_run: false,
            updated_at: new Date().toISOString()
          },
          `@${username} replies: ${deepAnalysis.conversationContext.slice(0, 100)}`
        );
      }
    } catch (brainErr: any) {
      console.error('[scanSingleTweet] brain storage error:', brainErr.message);
    }

    return {
      ok: true,
      analysis,
      media,
      deepAnalysis
    };
  } catch (e: any) {
    return { ok: false, error: e.message || 'خطأ غير معروف' };
  }
}
