import { assertAuthorized } from '../../../lib/env';
import { scanAccountPerformance } from '../../../lib/performance-feedback';

/**
 * GET/POST /api/account-performance-scan
 * 
 * Scans @30piq account and learns from the results:
 * - Pulls account tweets + their metrics
 * - Analyzes: why each tweet succeeded or failed
 * - Teaches the brain: increases/decreases rule confidence
 * - Extracts new patterns from success/failure
 */
export async function POST(req: Request) { return run(req); }
export async function GET(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const maxTweets = Math.min(Number(url.searchParams.get('max_tweets') || 10), 20);
    const username = url.searchParams.get('username') || '30piq';

    const result = await scanAccountPerformance(maxTweets, username);
    return Response.json(result);
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
