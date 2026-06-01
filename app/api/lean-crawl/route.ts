import { assertAuthorized } from '../../../lib/env';
import { runCrawl } from '../../../lib/lean/crawl';

/**
 * POST /api/lean-crawl — harvest the niche and distill transferable patterns
 * into the brain (outward learning). Safe to run on a cron.
 */
export const maxDuration = 300;

async function handle(req: Request) {
  try {
    assertAuthorized(req);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const report = await runCrawl();
    return Response.json({ ok: true, ...report });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'crawl failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
