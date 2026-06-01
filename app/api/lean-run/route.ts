import { assertAuthorized } from '../../../lib/env';
import { runLeanLoop } from '../../../lib/lean/run';

/**
 * POST /api/lean-run  (also GET for convenience while testing)
 *
 * Runs the simplified growth loop and returns the day's suggestions.
 * Light enough to run inside this single Vercel function — no Oracle worker
 * needed for the lean path.
 *
 * Auth: x-orchestrator-secret header, or ?cron=1 with Vercel cron header.
 * Query: ?telegram=1 to also push the formatted suggestions to Telegram.
 */
export const maxDuration = 300;

async function handle(req: Request) {
  try {
    assertAuthorized(req);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(req.url);
  const deliverTelegram = url.searchParams.get('telegram') === '1' || url.searchParams.get('cron') === '1';

  try {
    const result = await runLeanLoop({ deliverTelegram });
    return Response.json(result);
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'lean-run failed' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
