import { describe, it, expect } from 'vitest';
import { withRetry, isTransientError } from '../lib/retry';

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; });
    expect(result).toBe('ok');
    expect(calls).toBe(1);
  });

  it('retries then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return 'recovered';
    }, { attempts: 4, baseDelayMs: 1 });
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('throws after exhausting attempts', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error('always'); }, { attempts: 2, baseDelayMs: 1 }))
      .rejects.toThrow('always');
    expect(calls).toBe(2);
  });

  it('does not retry when shouldRetry returns false', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls++;
      const err = new Error('fatal') as Error & { status: number };
      err.status = 401;
      throw err;
    }, { attempts: 5, baseDelayMs: 1, shouldRetry: isTransientError })).rejects.toThrow('fatal');
    expect(calls).toBe(1);
  });
});

describe('isTransientError', () => {
  it('treats network errors (no status) as transient', () => {
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
  });

  it('retries 429 and 5xx', () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
  });

  it('does not retry 4xx (except listed)', () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });
});
