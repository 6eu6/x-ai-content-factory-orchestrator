import { waitUntil } from '@vercel/functions';

/**
 * runBackground — run a task in the background, portable across environments
 *
 * - On Vercel (serverless): waitUntil is called to keep the function alive after
 *   returning the response until the background task completes.
 * - On a persistent server (Raspberry Pi / plain Node): there is no request context
 *   for waitUntil, so it throws an exception which we ignore — the process stays
 *   alive anyway so the task completes on its own.
 *
 * This way, migrating the project from Vercel to Pi requires no changes at call sites.
 */
export function runBackground(task: Promise<unknown>): void {
  const guarded = Promise.resolve(task).catch((err: unknown) => {
    const msg = (err as { message?: string })?.message || String(err);
    console.error('[background] task failed:', msg);
  });

  try {
    waitUntil(guarded);
  } catch {
    // Not a Vercel environment — the persistent process will complete the promise on its own.
  }
}
