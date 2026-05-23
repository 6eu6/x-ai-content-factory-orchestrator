import { assertAuthorized } from '../../../lib/env';
import { generateMediaPipeline, generateImage, contentNeedsMedia } from '../../../lib/media-pipeline';

/**
 * POST /api/generate-media
 *
 * يولّد وصف الوسائط أو صورة للمحتوى
 *
 * Body: {
 *   content_type: 'carousel' | 'video_script' | 'single_tweet_with_image',
 *   topic: string,
 *   text_content: any,
 *   style_hint?: string,
 *   generate_image?: boolean,    // لو true، يحاول يولّد صورة فعلية
 *   image_size?: string          // 1024x1024 | 1344x768 | etc.
 * }
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();

    const contentType = body.content_type;
    if (!contentNeedsMedia(contentType)) {
      return Response.json({
        ok: false,
        error: `Content type '${contentType}' does not need media. Use: carousel, video_script, single_tweet_with_image`
      }, { status: 400 });
    }

    const result = await generateMediaPipeline({
      content_type: contentType,
      topic: body.topic || 'AI productivity',
      text_content: body.text_content || {},
      style_hint: body.style_hint,
      target_platform: body.target_platform || 'x'
    });

    // لو المستخدم طلب توليد صورة فعلية
    if (body.generate_image && result.media_items.length > 0) {
      const imageResults = [];
      for (const item of result.media_items.slice(0, 4)) { // حد أقصى 4 صور
        if (item.type === 'image_prompt' || item.type === 'carousel_slide') {
          const imageResult = await generateImage(item.prompt, body.image_size || '1024x1024');
          imageResults.push({
            slide: item.slide_number,
            prompt: item.prompt,
            ...imageResult
          });
        }
      }
      return Response.json({
        ...result,
        generated_images: imageResults
      });
    }

    return Response.json(result);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
