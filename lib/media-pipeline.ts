import { callModel, getModelForTask, TaskType } from './model-router';
import { supabaseAdmin } from './supabase';
import { optionalEnv } from './env';

/**
 * Media Pipeline — مسار توليد الوسائط
 *
 * الخطوات:
 * 1. يستقبل نوع المحتوى اللي يحتاج وسائط (carousel, video_script)
 * 2. يولّد وصف دقيق للوسائط باستخدام نموذج وصف الوسائط
 * 3. يختار نموذج OpenRouter المناسب للصورة/الفيديو
 * 4. يولّد الوسائط
 * 5. يرجع النتائج مع النص المرافق للتغريدة
 *
 * مسار البيانات:
 * content_type_engine → media_pipeline → model_router (media_description) → OpenRouter image model → result
 */

export type MediaRequest = {
  content_type: 'carousel' | 'video_script' | 'single_tweet_with_image';
  topic: string;
  text_content: any;           // المحتوى النصي المرافق
  style_hint?: string;         // تلميح الأسلوب (minimal, dark, bright, etc.)
  brand_colors?: string[];     // ألوان العلامة التجارية
  target_platform?: 'x' | 'telegram';
};

export type MediaResult = {
  ok: boolean;
  content_type: string;
  media_items: MediaItem[];
  tweet_text: string;           // نص التغريدة المرافق
  delivery_format: 'telegram_images' | 'telegram_video_note' | 'telegram_document';
  error?: string;
};

export type MediaItem = {
  type: 'image_prompt' | 'video_script' | 'carousel_slide';
  prompt: string;               // الوصف الدقيق للتوليد
  alt_text: string;             // وصف بديل للإمكانية
  slide_number?: number;        // رقم الشريحة (carousel فقط)
  layout_hint?: string;         // تلميح التخطيط
  duration_seconds?: number;    // مدة الفيديو (video_script فقط)
};

/**
 * يولّد وصف دقيق لوسائط الكاروسيل (4-8 شرائح)
 */
async function generateCarouselPrompts(request: MediaRequest): Promise<MediaItem[]> {
  const content = request.text_content;
  const slides = content?.slides || [];
  const imagePrompts = content?.image_generation_prompts || [];

  // لو في prompts جاهزة من content-type-engine، نستخدمها
  if (imagePrompts.length > 0) {
    return imagePrompts.map((prompt: string, i: number) => ({
      type: 'carousel_slide' as const,
      prompt: refineImagePrompt(prompt, request.style_hint),
      alt_text: slides[i]?.text || `Slide ${i + 1}`,
      slide_number: i + 1,
      layout_hint: slides[i]?.layout_hint || 'centered'
    }));
  }

  // لو ما في prompts جاهزة، نولّدها
  try {
    const response = await callModel('media_description', [
      {
        role: 'system',
        content: `You are a visual content designer for an X/Twitter account about AI x Productivity x Career Growth (@${optionalEnv('X_USERNAME', '30piq')}).

Design carousel slides. For each slide, provide:
1. A precise image generation prompt (for AI image generation — DALL-E, Midjourney, or Flux style)
2. Alt text describing what the image shows
3. Layout hint (left-aligned text, centered, split-screen, etc.)

CAROUSEL RULES:
- Slide 1 = HOOK (bold statement, question, or surprising fact — NOT the conclusion)
- Each slide = ONE key point
- Use minimal text on images (2-5 words max per slide)
- Color scheme: dark backgrounds preferred, accent colors for highlights
- Style: clean, modern, tech-oriented — NOT corporate stock photos
- Include visual metaphors, icons, diagrams where possible
- Last slide = CTA or takeaway with account handle

Output valid JSON array.`
      },
      {
        role: 'user',
        content: `Create ${slides.length || 5} carousel slide prompts for this topic:

Topic: "${request.topic}"
Slide texts: ${JSON.stringify(slides.map((s: any) => s?.text || s))}
Style: ${request.style_hint || 'dark minimal tech'}

Return JSON array:
[{
  "slide_number": 1,
  "image_prompt": "precise prompt for AI image generation, include style, colors, layout, text overlay",
  "alt_text": "what the image shows",
  "layout_hint": "centered|left_text|split_screen|diagram"
}]`
      }
    ]);

    const parsed = JSON.parse(response);
    if (Array.isArray(parsed)) {
      return parsed.map((item: any, i: number) => ({
        type: 'carousel_slide' as const,
        prompt: refineImagePrompt(item.image_prompt || '', request.style_hint),
        alt_text: item.alt_text || `Slide ${i + 1}`,
        slide_number: i + 1,
        layout_hint: item.layout_hint || 'centered'
      }));
    }
  } catch {}

  // Fallback: توليد prompts بسيطة
  const count = slides.length || 4;
  return Array.from({ length: count }, (_, i) => ({
    type: 'carousel_slide' as const,
    prompt: refineImagePrompt(
      `Minimal tech infographic slide about ${request.topic}, slide ${i + 1}, dark background, clean typography, accent colors`,
      request.style_hint
    ),
    alt_text: `Slide ${i + 1}: ${request.topic}`,
    slide_number: i + 1,
    layout_hint: 'centered'
  }));
}

/**
 * يولّد وصف دقيق لفيديو قصير (15-60 ثانية)
 */
async function generateVideoMedia(request: MediaRequest): Promise<MediaItem[]> {
  const content = request.text_content;

  try {
    const response = await callModel('media_description', [
      {
        role: 'system',
        content: `You are a video content director for an X/Twitter account about AI x Productivity x Career Growth.

Create a precise visual description for a short video (15-60 seconds) that will be posted on X.

VIDEO ALGORITHM RULES:
- Video MUST be 15+ seconds (shorter = ZERO VQV algorithm boost)
- Speech/voiceover is MANDATORY — ASR extracts audio for embedding
- Front-load KEYWORDS verbally in FIRST 3 seconds
- Hook in first 2 seconds
- Auto-captions ALWAYS enabled
- Vary formats: screen recording, face-to-camera, picture-in-picture, text animated

Provide:
1. Thumbnail image prompt (for video cover)
2. Detailed visual description for each segment
3. Any on-screen text suggestions

Output valid JSON.`
      },
      {
        role: 'user',
        content: `Create video visual description for:

Topic: "${request.topic}"
Script: ${JSON.stringify(content?.script || [])}
Video type: ${content?.video_type || 'screen_recording'}
Duration: ${content?.duration_seconds || 30} seconds

Return JSON:
{
  "thumbnail_prompt": "precise image generation prompt for video thumbnail",
  "thumbnail_alt": "what thumbnail shows",
  "visual_segments": [{"seconds":"0-3","visual_description":"...","on_screen_text":"..."}]
}`
      }
    ]);

    const parsed = JSON.parse(response);
    const items: MediaItem[] = [];

    // Thumbnail prompt
    if (parsed.thumbnail_prompt) {
      items.push({
        type: 'image_prompt' as const,
        prompt: refineImagePrompt(parsed.thumbnail_prompt, request.style_hint),
        alt_text: parsed.thumbnail_alt || `Video thumbnail: ${request.topic}`,
        duration_seconds: content?.duration_seconds || 30
      });
    }

    // Visual segments as description
    if (parsed.visual_segments) {
      items.push({
        type: 'video_script' as const,
        prompt: JSON.stringify(parsed.visual_segments),
        alt_text: `Video visual plan: ${request.topic}`,
        duration_seconds: content?.duration_seconds || 30
      });
    }

    return items;
  } catch {
    return [{
      type: 'video_script' as const,
      prompt: `Screen recording showing ${request.topic}, 30 seconds, dark IDE theme`,
      alt_text: `Video: ${request.topic}`,
      duration_seconds: 30
    }];
  }
}

/**
 * يولّد وصف صورة مرافقة لتغريدة
 */
async function generateTweetImagePrompt(request: MediaRequest): Promise<MediaItem[]> {
  try {
    const response = await callModel('media_description', [
      {
        role: 'system',
        content: `Create a precise image generation prompt for an X/Twitter post image.

Rules:
- The image should enhance the tweet, not repeat it
- Style: clean, modern, tech-oriented
- Avoid stock photo look
- Include visual metaphors or diagrams where possible
- Dark or neutral background preferred
- Minimal text on image (0-3 words)

Output valid JSON.`
      },
      {
        role: 'user',
        content: `Create an image prompt for this tweet:

Topic: "${request.topic}"
Tweet text: "${request.text_content?.text || ''}"

Return JSON:
{
  "image_prompt": "precise prompt for AI image generation",
  "alt_text": "description for accessibility"
}`
      }
    ]);

    const parsed = JSON.parse(response);
    return [{
      type: 'image_prompt' as const,
      prompt: refineImagePrompt(parsed.image_prompt || `Tech infographic about ${request.topic}, dark background, minimal`, request.style_hint),
      alt_text: parsed.alt_text || `Image: ${request.topic}`
    }];
  } catch {
    return [{
      type: 'image_prompt' as const,
      prompt: `Minimal tech illustration about ${request.topic}, dark background, accent colors`,
      alt_text: `Image: ${request.topic}`
    }];
  }
}

/**
 * يحسّن الـ prompt بإضافة تفاصيل الأسلوب
 */
function refineImagePrompt(prompt: string, styleHint?: string): string {
  const baseStyle = 'high quality, clean design, modern tech aesthetic, professional';
  const style = styleHint || 'dark minimal';
  return `${prompt}, ${style} style, ${baseStyle}`;
}

/**
 * المسار الرئيسي — يولّد وصف الوسائط حسب نوع المحتوى
 */
export async function generateMediaPipeline(request: MediaRequest): Promise<MediaResult> {
  let mediaItems: MediaItem[] = [];
  let deliveryFormat: MediaResult['delivery_format'] = 'telegram_images';
  let tweetText = '';

  switch (request.content_type) {
    case 'carousel':
      mediaItems = await generateCarouselPrompts(request);
      deliveryFormat = 'telegram_images';
      tweetText = request.text_content?.hook_slide || request.text_content?.hook || request.topic;
      break;

    case 'video_script':
      mediaItems = await generateVideoMedia(request);
      deliveryFormat = 'telegram_video_note';
      tweetText = request.text_content?.tweet_text || request.text_content?.descriptive_text_for_grok || request.topic;
      break;

    case 'single_tweet_with_image':
      mediaItems = await generateTweetImagePrompt(request);
      deliveryFormat = 'telegram_images';
      tweetText = request.text_content?.text || request.topic;
      break;

    default:
      return {
        ok: false,
        content_type: request.content_type,
        media_items: [],
        tweet_text: '',
        delivery_format: 'telegram_images',
        error: `Unsupported content type: ${request.content_type}`
      };
  }

  // سجّل في content_deliveries
  try {
    const supabase = supabaseAdmin();
    await supabase.from('content_deliveries').insert({
      content_type: request.content_type,
      delivery_type: 'telegram',
      delivery_status: 'media_generated',
      delivery_payload: {
        media_items: mediaItems,
        topic: request.topic,
        style_hint: request.style_hint,
        tweet_text: tweetText
      }
    });
  } catch {}

  return {
    ok: true,
    content_type: request.content_type,
    media_items: mediaItems,
    tweet_text: tweetText,
    delivery_format: deliveryFormat
  };
}

/**
 * يولّد صورة عبر OpenRouter image model
 * يرجع base64 أو URL حسب النموذج
 */
export async function generateImage(prompt: string, size: string = '1024x1024'): Promise<{ ok: boolean; image_data?: string; image_url?: string; error?: string }> {
  try {
    const config = await getModelForTask('media_description');
    const { getAIClientForTask } = await import('./model-router');
    const { client } = await getAIClientForTask('media_description');

    // حاول توليد صورة عبر OpenRouter
    // بعض النماذج تدعم images.generate
    const response = await client.images.generate({
      model: config.model,
      prompt,
      n: 1,
      size: size as any,
    });

    const imageData = response.data?.[0];
    if (imageData?.b64_json) {
      return { ok: true, image_data: imageData.b64_json };
    }
    if (imageData?.url) {
      return { ok: true, image_url: imageData.url };
    }

    return { ok: false, error: 'No image data returned from model' };
  } catch (e: any) {
    // لو النموذج ما يدعم توليد صور، نرجع الـ prompt بس
    return { ok: false, error: `Image generation not available: ${e.message}` };
  }
}

/**
 * يقرر هل المحتوى يحتاج وسائط
 */
export function contentNeedsMedia(contentType: string): boolean {
  return ['carousel', 'video_script', 'single_tweet_with_image'].includes(contentType);
}
