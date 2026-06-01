import { assertAuthorized } from '../../../lib/env';
import { runCrawl } from '../../../lib/lean/crawl';
import { runLeanLoop } from '../../../lib/lean/run';
import { runFeedbackScan } from '../../../lib/lean/feedback';
import { pruneBrain } from '../../../lib/brain/prune';

/**
 * The full daily brain cycle in one cron-friendly call:
 *   1. crawl    — learn new niche patterns (outward learning)
 *   2. feedback — measure yesterday's posts, learn from results (inward learning)
 *   3. suggest  — generate today's batch grounded in the updated brain, to Telegram
 *   4. prune    — once a week, forget stale/contradicted memories
 *
 * GET/POST /api/lean-cycle  (cron sends ?cron=1 + x-vercel-cron)
 */
// Hobby plan caps serverless maxDuration at 300s.
export const maxDuration = 300;

async function handle(req: Request) {
  try {
    assertAuthorized(req);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const out: Record<string, any> = {};
  // Each stage is independent: one failing must not abort the rest.
  try { out.crawl = await runCrawl(); } catch (e: any) { out.crawl = { error: e?.message }; }
  try { out.feedback = await runFeedbackScan(); } catch (e: any) { out.feedback = { error: e?.message }; }
  try {
    const r = await runLeanLoop({ deliverTelegram: true });
    out.suggest = { accepted: r.accepted, generated: r.generated, harvested: r.harvested };
  } catch (e: any) { out.suggest = { error: e?.message }; }

  // Weekly prune (Sundays).
  if (new Date().getUTCDay() === 0) {
    try { out.prune = await pruneBrain(); } catch (e: any) { out.prune = { error: e?.message }; }
  }

  return Response.json({ ok: true, ...out });
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
