import { assertAuthorized } from '../../../lib/env';
import { compactRunIntoMemory, type CompactionResult } from '../../../lib/structured-memory-compaction';

const VERSION = 'memory-compact-run-v1';

export async function POST(req: Request) {
  try {
    assertAuthorized(req);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      // Empty body is ok
    }

    const runId = body.run_id;
    if (!runId) {
      return Response.json({
        ok: false,
        version: VERSION,
        error: 'Missing run_id in request body. Provide { "run_id": "..." }',
      }, { status: 400 });
    }

    const result: CompactionResult = await compactRunIntoMemory(runId);

    return Response.json({
      ok: true,
      version: VERSION,
      run_id: runId,
      result,
    });
  } catch (err: any) {
    return Response.json({
      ok: false,
      version: VERSION,
      error: err.message,
    }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    assertAuthorized(req);
    const url = new URL(req.url);
    const runId = url.searchParams.get('run_id');

    if (!runId) {
      return Response.json({
        ok: false,
        version: VERSION,
        error: 'Missing run_id query parameter. Use ?run_id=...',
      }, { status: 400 });
    }

    const result: CompactionResult = await compactRunIntoMemory(runId);

    return Response.json({
      ok: true,
      version: VERSION,
      run_id: runId,
      result,
    });
  } catch (err: any) {
    return Response.json({
      ok: false,
      version: VERSION,
      error: err.message,
    }, { status: 500 });
  }
}
