import { assertAuthorized } from '../../../lib/env';
import { runFeedbackScan } from '../../../lib/lean/feedback';

/**
 * POST /api/lean-feedback  — measure published posts' real engagement and write
 * the lessons back into the brain (inward learning). Safe to run on a cron.
 */
export const maxDuration = 300;

async function handle(req: Request) {
  try {
    assertAuthorized(req);
  } catch {
    return Response.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const report = await runFeedbackScan();
    return Response.json({ ok: true, ...report });
  } catch (e: any) {
    return Response.json({ ok: false, error: e?.message || 'feedback failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return handle(req);
}
export async function POST(req: Request) {
  return handle(req);
}
