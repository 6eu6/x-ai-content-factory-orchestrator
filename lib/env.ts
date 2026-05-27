export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] || fallback;
}

/**
 * Parse a numeric env var with bounds checking
 * Returns fallback if missing, NaN, or out of [min, max]
 */
export function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (Number.isNaN(n) || n < min || n > max) return fallback;
  return n;
}

export function assertAuthorized(req: Request): void {
  const secret = process.env.ORCHESTRATOR_SECRET;
  if (!secret) throw new Error('Missing ORCHESTRATOR_SECRET');
  const url = new URL(req.url);
  const token = req.headers.get('x-orchestrator-secret') || url.searchParams.get('secret') || '';
  const isCron = url.searchParams.get('cron') === '1';
  const vercelCronHeader = req.headers.get('x-vercel-cron');
  if (token === secret) return;
  if (isCron && vercelCronHeader) return;
  throw new Error('Unauthorized');
}
