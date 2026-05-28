/**
 * retry — retry with exponential backoff
 *
 * Used around transient network calls (TwitterAPI.io, Telegram,
 * OpenRouter/local model, search engines) so the entire process doesn't
 * crash due to a temporary error (rate limit, network outage, 5xx).
 */

export type RetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  factor?: number;
  label?: string;
  shouldRetry?: (err: unknown) => boolean;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = opts.baseDelayMs ?? 600;
  const max = opts.maxDelayMs ?? 8000;
  const factor = opts.factor ?? 2;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (opts.shouldRetry && !opts.shouldRetry(err)) throw err;
      if (i === attempts - 1) break;
      const delay = Math.min(max, base * Math.pow(factor, i));
      const jitter = Math.random() * delay * 0.25;
      const waitMs = Math.round(delay + jitter);
      if (opts.label) {
        const msg = (err as { message?: string })?.message || String(err);
        console.warn(`[retry] ${opts.label} attempt ${i + 1}/${attempts} failed: ${msg} — retrying in ${waitMs}ms`);
      }
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Determines whether the error (from fetch or OpenAI SDK) is retryable */
export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status === undefined) return true; // Network errors without status code
  return RETRYABLE_STATUS.has(status);
}

/** fetch with retry on network errors and 429/5xx */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: RetryOptions = {}
): Promise<Response> {
  return withRetry(async () => {
    const res = await fetch(url, init);
    if (RETRYABLE_STATUS.has(res.status)) {
      const err = new Error(`HTTP ${res.status}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }
    return res;
  }, { attempts: 4, baseDelayMs: 800, label: opts.label ?? `fetch ${url}`, shouldRetry: isTransientError, ...opts });
}
