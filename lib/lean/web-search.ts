/**
 * Lean Core — Web search (dynamic Serper ↔ SerpAPI, with Reddit & YouTube)
 *
 * One search layer used by deep-research and by the daily web enrichment.
 * It tries Serper first and falls back to SerpAPI (or vice-versa) so a single
 * key being missing, rate-limited, or empty never breaks search.
 *
 * Engines:
 *  - 'google'  general web (also used for Reddit via a site: filter)
 *  - 'youtube' video results (SerpAPI youtube engine, Serper /videos fallback)
 */

import { optionalEnv } from '../env';

export type SearchHit = { title: string; snippet: string; link: string; source: 'web' | 'reddit' | 'youtube' };
export type SearchEngine = 'google' | 'youtube';

const serperKey = () => optionalEnv('SERPER_API_KEY');
const serpapiKey = () => optionalEnv('SERPAPI_API_KEY');

async function tryFetchJson(url: string, init?: RequestInit): Promise<any | null> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function serperGoogle(q: string, num: number, source: SearchHit['source']): Promise<SearchHit[] | null> {
  const key = serperKey();
  if (!key) return null;
  const json = await tryFetchJson('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
    body: JSON.stringify({ q, num }),
  });
  if (!json) return null;
  const organic: any[] = Array.isArray(json.organic) ? json.organic : [];
  return organic.slice(0, num).map((o) => ({ title: String(o?.title || ''), snippet: String(o?.snippet || ''), link: String(o?.link || ''), source }));
}

async function serpapiGoogle(q: string, num: number, source: SearchHit['source']): Promise<SearchHit[] | null> {
  const key = serpapiKey();
  if (!key) return null;
  const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=${num}&api_key=${key}`;
  const json = await tryFetchJson(url);
  if (!json) return null;
  const organic: any[] = Array.isArray(json.organic_results) ? json.organic_results : [];
  return organic.slice(0, num).map((o) => ({ title: String(o?.title || ''), snippet: String(o?.snippet || ''), link: String(o?.link || ''), source }));
}

async function serpapiYoutube(q: string, num: number): Promise<SearchHit[] | null> {
  const key = serpapiKey();
  if (!key) return null;
  const url = `https://serpapi.com/search.json?engine=youtube&search_query=${encodeURIComponent(q)}&api_key=${key}`;
  const json = await tryFetchJson(url);
  if (!json) return null;
  const vids: any[] = Array.isArray(json.video_results) ? json.video_results : [];
  return vids.slice(0, num).map((v) => ({ title: String(v?.title || ''), snippet: String(v?.description || v?.published_date || ''), link: String(v?.link || ''), source: 'youtube' as const }));
}

async function serperVideos(q: string, num: number): Promise<SearchHit[] | null> {
  const key = serperKey();
  if (!key) return null;
  const json = await tryFetchJson('https://google.serper.dev/videos', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
    body: JSON.stringify({ q, num }),
  });
  if (!json) return null;
  const vids: any[] = Array.isArray(json.videos) ? json.videos : [];
  return vids.slice(0, num).map((v) => ({ title: String(v?.title || ''), snippet: String(v?.snippet || ''), link: String(v?.link || ''), source: 'youtube' as const }));
}

export function searchEnabled(): boolean {
  return Boolean(serperKey() || serpapiKey());
}

/** Build a Reddit-scoped query. */
export function redditQuery(topic: string): string {
  return `site:reddit.com ${topic}`;
}

/**
 * Dynamic search: Serper first, SerpAPI fallback (and vice-versa for youtube).
 * Returns [] only when both providers are unavailable/empty.
 */
export async function webSearch(query: string, opts: { engine?: SearchEngine; num?: number; source?: SearchHit['source'] } = {}): Promise<SearchHit[]> {
  const num = opts.num ?? 6;
  const engine = opts.engine ?? 'google';
  const source = opts.source ?? (engine === 'youtube' ? 'youtube' : 'web');

  if (engine === 'youtube') {
    return (await serpapiYoutube(query, num)) ?? (await serperVideos(query, num)) ?? [];
  }
  // google: try Serper, fall back to SerpAPI
  const primary = (await serperGoogle(query, num, source)) ?? [];
  if (primary.length) return primary;
  return (await serpapiGoogle(query, num, source)) ?? [];
}
