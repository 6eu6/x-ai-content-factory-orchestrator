import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { prepareAndDeliverDailyPack } from '../../../lib/publishing-pipeline';
import { supabaseAdmin } from '../../../lib/supabase';
import { ContentType } from '../../../lib/content-type-engine';
import { parseModelJson } from '../../../lib/model-router';

/**
 * POST /api/publish-pack
 *
 * Prepares the daily content pack and delivers it to Telegram.
 * Publishing is manual — the user publishes themselves.
 *
 * Body (optional — if empty, pulls the latest daily-run):
 * {
 *   items?: [{ content_type, content, priority, model_task }],
 *   content_pack?: any,
 *   auto_scan?: boolean   // After delivery, runs performance scan automatically
 * }
 *
 * Query params:
 *   ?scan=1   — Run performance scan after delivery
 */
export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json() || {};
    const url = new URL(req.url);
    const shouldScan = body.auto_scan || url.searchParams.get('scan') === '1';

    let diverseContent = body.items || [];
    let contentPack = body.content_pack || null;

    // If no items, pull the latest daily-run from content_log
    if (!diverseContent.length) {
      const supabase = supabaseAdmin();
      const { data: recentContent } = await supabase
        .from('content_log')
        .select('*')
        .neq('publish_status', 'rejected')
        .order('published_at', { ascending: false })
        .limit(15);

      if (recentContent && recentContent.length > 0) {
        diverseContent = recentContent.map((item: any) => {
          let content = {};
          try {
            if (item.final_text) content = parseModelJson(item.final_text);
          } catch {
            content = { text: item.hook_text || item.final_text || '' };
          }

          return {
            content_type: parseContentType(item.content_type),
            content,
            priority: item.notes?.priority || 'medium',
            model_task: 'content_generation'
          };
        });
      }
    }

    // Prepare and deliver the pack
    const result = await prepareAndDeliverDailyPack(diverseContent, contentPack);

    // If performance scan was requested after delivery
    let scanResult = null;
    if (shouldScan) {
      try {
        const { scanAccountPerformance } = await import('../../../lib/performance-feedback');
        scanResult = await scanAccountPerformance(10, optionalEnv('X_USERNAME', '30piq'));
      } catch (e: any) {
        scanResult = { ok: false, error: e.message };
      }
    }

    return Response.json({
      ok: true,
      pack: result,
      performance_scan: scanResult
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

function parseContentType(raw: string): ContentType {
  const t = String(raw || '').toLowerCase();
  if (t.includes('thread')) return 'thread';
  if (t.includes('article')) return 'article';
  if (t.includes('carousel')) return 'carousel';
  if (t.includes('video')) return 'video_script';
  if (t.includes('quote')) return 'quote_post';
  if (t.includes('reply')) return 'reply';
  return 'single_tweet';
}
