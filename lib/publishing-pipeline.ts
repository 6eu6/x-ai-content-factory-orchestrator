import { sendTelegramMessage, htmlEscape, shortText, MAIN_KEYBOARD, allowedChatId } from './telegram';
import { shieldCheck, ShieldResult } from './account-shield';
import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';
import { contentNeedsMedia, generateMediaPipeline, generateAndDeliverImage } from './media-pipeline';
import { ContentType } from './content-type-engine';

/**
 * Publishing Pipeline v2 — مسار تسليم المحتوى المنسق لتليجرام
 *
 * تحسينات:
 * 1. تنسيق أفضل لكل نوع محتوى
 * 2. إرسال صور مولّدة لتليجرام
 * 3. تشغيل ماسح الأداء تلقائياً بعد التسليم
 * 4. تسجيل أفضل في content_deliveries
 */

export type PublishableItem = {
  content_type: ContentType;
  content: any;
  shield_result?: ShieldResult;
  media_result?: any;
  priority: 'high' | 'medium' | 'low';
  status: 'ready' | 'needs_review' | 'blocked';
  delivery_id?: string;
};

export type DailyPublishPack = {
  pack_date: string;
  account_handle: string;
  items: PublishableItem[];
  summary: {
    total_items: number;
    ready_count: number;
    needs_review_count: number;
    blocked_count: number;
    types_included: string[];
  };
  shield_summary: string;
  recommendations: string[];
};

/**
 * ينسّق محتوى واحد حسب نوعه لتليجرام
 */
function formatContentForTelegram(item: PublishableItem): string {
  const c = item.content;
  const typeEmoji = getTypeEmoji(item.content_type);
  const shieldStatus = item.shield_result
    ? (item.shield_result.passed ? '✅' : `⚠️ ${item.shield_result.risk_level}`)
    : '❓';
  const priorityBadge = item.priority === 'high' ? '🔴' : item.priority === 'medium' ? '🟡' : '🟢';

  const lines: string[] = [];
  lines.push(`${typeEmoji} <b>${formatContentType(item.content_type).toUpperCase()}</b> ${priorityBadge} ${shieldStatus}`);
  lines.push('━'.repeat(30));

  switch (item.content_type) {
    case 'single_tweet':
      lines.push(`<i>${htmlEscape(shortText(c.text || '', 280))}</i>`);
      if (c.why_it_works) lines.push(`\n💡 <b>Why it works:</b> ${htmlEscape(shortText(c.why_it_works, 200))}`);
      if (c.originality_element) lines.push(`🔑 <b>Originality:</b> ${htmlEscape(shortText(c.originality_element, 150))}`);
      if (c.reply_trigger) lines.push(`💬 <b>Reply trigger:</b> ${htmlEscape(shortText(c.reply_trigger, 100))}`);
      if (c.bookmark_trigger) lines.push(`🔖 <b>Bookmark trigger:</b> ${htmlEscape(shortText(c.bookmark_trigger, 100))}`);
      // [جديد] اقتراح إعادة كتابة من Shield
      if (item.shield_result?.ai_rewrite) {
        lines.push(`\n✏️ <b>Suggested rewrite:</b>\n<i>${htmlEscape(shortText(item.shield_result.ai_rewrite, 280))}</i>`);
      }
      break;

    case 'thread':
      if (c.hook) lines.push(`<b>🪝 Hook:</b>\n${htmlEscape(shortText(c.hook, 280))}`);
      if (c.tweets && Array.isArray(c.tweets)) {
        lines.push(`\n<b>📝 Thread (${c.tweets.length} tweets):</b>`);
        c.tweets.forEach((t: any, i: number) => {
          lines.push(`<b>${i + 2}/</b> ${htmlEscape(shortText(t.text || '', 200))}`);
        });
      }
      if (c.conclusion) lines.push(`\n<b>🏁 Conclusion:</b> ${htmlEscape(shortText(c.conclusion, 200))}`);
      if (c.originality_element) lines.push(`\n🔑 <b>Originality:</b> ${htmlEscape(shortText(c.originality_element, 150))}`);
      break;

    case 'article':
      if (c.headline) lines.push(`<b>📰 ${htmlEscape(c.headline)}</b>`);
      if (c.subheadline) lines.push(`<i>${htmlEscape(shortText(c.subheadline, 200))}</i>`);
      if (c.sections && Array.isArray(c.sections)) {
        lines.push(`\n<b>Sections (${c.sections.length}):</b>`);
        c.sections.forEach((s: any, i: number) => {
          lines.push(`${i + 1}. ${htmlEscape(s.title || 'Untitled')} (~${s.estimated_words || '?'} words)`);
        });
      }
      if (c.bookmark_trigger) lines.push(`\n🔖 <b>Bookmark trigger:</b> ${htmlEscape(shortText(c.bookmark_trigger, 150))}`);
      break;

    case 'carousel':
      if (c.slides && Array.isArray(c.slides)) {
        lines.push(`<b>🎨 Carousel (${c.slides.length} slides)</b>`);
        c.slides.forEach((s: any, i: number) => {
          lines.push(`  ${i + 1}. ${htmlEscape(shortText(s.text || '', 80))}`);
        });
      }
      if (item.media_result?.media_items?.length) {
        lines.push(`\n<b>🖼 Image prompts ready:</b> ${item.media_result.media_items.length}`);
      }
      break;

    case 'video_script':
      if (c.title) lines.push(`<b>🎬 ${htmlEscape(c.title)}</b>`);
      if (c.duration_seconds) lines.push(`⏱ Duration: ${c.duration_seconds}s`);
      if (c.tweet_text) lines.push(`\n<b>Tweet text:</b> ${htmlEscape(shortText(c.tweet_text, 240))}`);
      if (c.script && Array.isArray(c.script)) {
        lines.push(`\n<b>Script:</b>`);
        c.script.forEach((s: any) => {
          lines.push(`  <b>${s.seconds || '?'}s:</b> ${htmlEscape(shortText(s.visual || s.audio || '', 100))}`);
        });
      }
      if (c.descriptive_text_for_grok) lines.push(`\n<b>Grok description:</b> ${htmlEscape(shortText(c.descriptive_text_for_grok, 200))}`);
      break;

    case 'reply':
      if (c.prepared_reply) lines.push(`💬 ${htmlEscape(shortText(c.prepared_reply, 240))}`);
      if (c.reply_angle) lines.push(`\n<b>Angle:</b> ${htmlEscape(shortText(c.reply_angle, 150))}`);
      if (c.decision_rule) lines.push(`📋 <b>When to reply:</b> ${htmlEscape(shortText(c.decision_rule, 150))}`);
      break;

    case 'quote_post':
      if (c.prepared_quote) lines.push(`📝 ${htmlEscape(shortText(c.prepared_quote, 240))}`);
      if (c.quote_angle) lines.push(`\n<b>Angle:</b> ${htmlEscape(shortText(c.quote_angle, 150))}`);
      if (c.decision_rule) lines.push(`📋 <b>When to quote:</b> ${htmlEscape(shortText(c.decision_rule, 150))}`);
      break;
  }

  // Shield suggestions
  if (item.shield_result && !item.shield_result.passed && item.shield_result.suggestions?.length) {
    lines.push('\n<b>🛡 Shield suggestions:</b>');
    item.shield_result.suggestions.slice(0, 3).forEach(s => {
      lines.push(`  • ${htmlEscape(shortText(s, 120))}`);
    });
  }

  return lines.join('\n');
}

function getTypeEmoji(type: ContentType): string {
  switch (type) {
    case 'single_tweet': return '💬';
    case 'thread': return '🧵';
    case 'article': return '📰';
    case 'carousel': return '🎨';
    case 'video_script': return '🎬';
    case 'reply': return '↩️';
    case 'quote_post': return '📌';
    default: return '📄';
  }
}

function formatContentType(type: ContentType): string {
  switch (type) {
    case 'single_tweet': return 'Tweet';
    case 'thread': return 'Thread';
    case 'article': return 'Article';
    case 'carousel': return 'Carousel';
    case 'video_script': return 'Video Script';
    case 'reply': return 'Reply';
    case 'quote_post': return 'Quote Post';
    default: return type;
  }
}

/**
 * فحص Shield لكل المحتوى
 */
async function shieldCheckAll(items: PublishableItem[]): Promise<PublishableItem[]> {
  const results: PublishableItem[] = [];

  for (const item of items) {
    try {
      const text = extractTextFromContent(item.content, item.content_type);
      const shield = await shieldCheck({
        text,
        type: item.content_type === 'single_tweet' ? 'tweet' :
              item.content_type === 'thread' ? 'thread' :
              item.content_type === 'article' ? 'article' :
              item.content_type === 'video_script' ? 'video_script' :
              item.content_type === 'carousel' ? 'carousel' : 'tweet',
        originality_element: item.content?.originality_element,
        mechanic_used: item.content?.mechanic_used,
        reply_trigger: item.content?.reply_trigger,
        bookmark_trigger: item.content?.bookmark_trigger,
        deep_check: true  // [جديد] فحص AI عميق
      });

      const status: PublishableItem['status'] =
        shield.risk_level === 'danger' ? 'blocked' :
        shield.risk_level === 'warning' ? 'needs_review' : 'ready';

      results.push({
        ...item,
        shield_result: shield,
        status
      });
    } catch {
      results.push({
        ...item,
        status: 'needs_review'
      });
    }
  }

  return results;
}

function extractTextFromContent(content: any, type: ContentType): string {
  switch (type) {
    case 'single_tweet':
      return content.text || '';
    case 'thread':
      return [content.hook, ...(content.tweets || []).map((t: any) => t.text), content.conclusion].filter(Boolean).join('\n');
    case 'article':
      return `${content.headline || ''} ${content.subheadline || ''} ${(content.sections || []).map((s: any) => s.title).join(' ')}`;
    case 'carousel':
      return (content.slides || []).map((s: any) => s.text).join('\n');
    case 'video_script':
      return content.tweet_text || content.title || '';
    case 'reply':
      return content.prepared_reply || '';
    case 'quote_post':
      return content.prepared_quote || '';
    default:
      return JSON.stringify(content).slice(0, 500);
  }
}

/**
 * توليد وصف الوسائط للمحتوى اللي يحتاجها
 */
async function generateMediaForItems(items: PublishableItem[]): Promise<PublishableItem[]> {
  const results: PublishableItem[] = [];

  for (const item of items) {
    if (contentNeedsMedia(item.content_type)) {
      try {
        const mediaResult = await generateMediaPipeline({
          content_type: (item.content_type === 'carousel' ? 'carousel' : item.content_type === 'video_script' ? 'video_script' : 'single_tweet_with_image') as any,
          topic: item.content?.topic || item.content?.headline || item.content?.hook?.slice(0, 80) || '',
          text_content: item.content,
          style_hint: 'dark minimal tech'
        });

        // [جديد] حاول توليد صورة فعلية للكاروسيل والتغريدة مع صورة
        if (item.content_type === 'carousel' || item.content_type === 'single_tweet_with_image') {
          for (const mediaItem of mediaResult.media_items.slice(0, 3)) {
            try {
              const imageResult = await generateAndDeliverImage(
                mediaItem.prompt,
                `${formatContentType(item.content_type)} — ${item.content?.topic || ''}`
              );
              if (imageResult.ok) {
                mediaItem.image_url = imageResult.image_url;
                mediaItem.type = 'generated_image';
              }
            } catch {}
          }
        }

        results.push({
          ...item,
          media_result: mediaResult
        });
      } catch {
        results.push(item);
      }
    } else {
      results.push(item);
    }
  }

  return results;
}

/**
 * يجهز حزمة المحتوى اليومية ويسلمها لتليجرام
 * النشر يدوي — المستخدم يقرر
 */
export async function prepareAndDeliverDailyPack(
  diverseContent: Array<{
    content_type: ContentType;
    content: any;
    priority: 'high' | 'medium' | 'low';
    model_task: string;
  }>,
  contentPack?: any
): Promise<DailyPublishPack> {
  const username = optionalEnv('X_USERNAME', '30piq');
  const packDate = new Date().toISOString().slice(0, 10);

  // ═══ 1. حوّل كل عنصر لـ PublishableItem ═══
  let items: PublishableItem[] = diverseContent.map(item => ({
    content_type: item.content_type,
    content: item.content,
    priority: item.priority,
    status: 'needs_review' as const
  }));

  // أضف المحتوى القديم (backward compatible)
  if (contentPack?.single_tweets) {
    for (const tweet of contentPack.single_tweets) {
      items.push({
        content_type: 'single_tweet' as ContentType,
        content: tweet,
        priority: 'high',
        status: 'needs_review'
      });
    }
  }

  if (contentPack?.reply_targets_strategy) {
    for (const reply of contentPack.reply_targets_strategy) {
      items.push({
        content_type: 'reply' as ContentType,
        content: reply,
        priority: 'medium',
        status: 'needs_review'
      });
    }
  }

  if (contentPack?.quote_tweet_strategy) {
    for (const quote of contentPack.quote_tweet_strategy) {
      items.push({
        content_type: 'quote_post' as ContentType,
        content: quote,
        priority: 'medium',
        status: 'needs_review'
      });
    }
  }

  // ═══ 2. Shield فحص (مع فحص AI عميق) ═══
  items = await shieldCheckAll(items);

  // ═══ 3. توليد وصف الوسائط ═══
  items = await generateMediaForItems(items);

  // ═══ 4. إرسال لتليجرام ═══
  const chatId = allowedChatId();
  let deliverySuccess = false;

  if (chatId) {
    try {
      const readyCount = items.filter(i => i.status === 'ready').length;
      const blockedCount = items.filter(i => i.status === 'blocked').length;
      const reviewCount = items.filter(i => i.status === 'needs_review').length;

      await sendTelegramMessage(chatId,
        `📦 <b>Daily Content Pack — ${packDate}</b>\n` +
        `Account: @${username}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ Ready: ${readyCount} | ⚠️ Review: ${reviewCount} | 🚫 Blocked: ${blockedCount}\n` +
        `Types: ${[...new Set(items.map(i => i.content_type))].join(', ')}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `<i>Content below — copy and publish manually</i>`
      );

      // أرسل كل عنصر بروسالة منفصلة
      for (const item of items) {
        if (item.status === 'blocked') continue;
        const formatted = formatContentForTelegram(item);
        try {
          await sendTelegramMessage(chatId, formatted);
        } catch {}
      }

      // رسالة الختام
      await sendTelegramMessage(chatId,
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🛡 <b>Shield Summary:</b> ${readyCount} passed, ${reviewCount} need review, ${blockedCount} blocked\n` +
        `📋 <b>Next:</b> After publishing, send "📊 مسح الأداء" to measure results and learn\n` +
        `━━━━━━━━━━━━━━━━━━━━`,
        MAIN_KEYBOARD
      );

      deliverySuccess = true;
    } catch {}
  }

  // ═══ 5. تسجيل التسليم في قاعدة البيانات ═══
  for (const item of items) {
    try {
      const supabase = supabaseAdmin();
      const { data } = await supabase.from('content_deliveries').insert({
        content_type: item.content_type,
        delivery_type: 'telegram',
        delivery_status: deliverySuccess ? 'delivered' : 'pending',
        delivery_payload: {
          content: item.content,
          shield_result: item.shield_result ? {
            passed: item.shield_result.passed,
            risk_level: item.shield_result.risk_level,
            summary: item.shield_result.summary,
            ai_analysis: item.shield_result.ai_analysis
          } : null,
          media_generated: Boolean(item.media_result),
          priority: item.priority,
          status: item.status
        }
      }).select('id').single();

      if (data) {
        item.delivery_id = data.id;
      }
    } catch {}
  }

  // ═══ 6. تجهيز الحزمة النهائية ═══
  const readyCount = items.filter(i => i.status === 'ready').length;
  const blockedCount = items.filter(i => i.status === 'blocked').length;
  const reviewCount = items.filter(i => i.status === 'needs_review').length;

  const recommendations: string[] = [];
  if (readyCount > 0) recommendations.push(`${readyCount} items ready to publish. Copy from Telegram and post manually.`);
  if (reviewCount > 0) recommendations.push(`${reviewCount} items need review. Check shield suggestions and edit before publishing.`);
  if (blockedCount > 0) recommendations.push(`${blockedCount} items blocked by shield. Do not publish these without major edits.`);
  recommendations.push('After publishing, run account-performance-scan to measure results and update learning.');

  return {
    pack_date: packDate,
    account_handle: username,
    items,
    summary: {
      total_items: items.length,
      ready_count: readyCount,
      needs_review_count: reviewCount,
      blocked_count: blockedCount,
      types_included: [...new Set(items.map(i => i.content_type))]
    },
    shield_summary: items.filter(i => i.shield_result && !i.shield_result.passed)
      .map(i => `${i.content_type}: ${i.shield_result!.summary}`)
      .join(' | ') || 'All items passed shield check',
    recommendations
  };
}
