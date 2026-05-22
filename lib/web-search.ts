import { optionalEnv } from './env';

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
  score?: number;
};

function scoreResults(results: WebSearchResult[]) {
  const uniqueHosts = new Set<string>();
  let textScore = 0;
  for (const item of results) {
    try {
      uniqueHosts.add(new URL(item.url).hostname.replace(/^www\./, ''));
    } catch {}
    textScore += `${item.title} ${item.snippet}`.trim().length;
  }
  return results.length * 100 + uniqueHosts.size * 25 + Math.min(textScore, 1000) / 20;
}

function dedupeAndRank(results: WebSearchResult[], limit: number) {
  const seen = new Set<string>();
  const cleaned: WebSearchResult[] = [];
  for (const item of results) {
    const key = item.url || `${item.title}:${item.snippet}`;
    if (!item.title || !key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(item);
  }
  return cleaned
    .map((item) => ({ ...item, score: `${item.title} ${item.snippet}`.length + (item.url ? 50 : 0) }))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, limit);
}

async function safeSearch(name: string, fn: () => Promise<WebSearchResult[]>) {
  try {
    return { name, ok: true, results: await fn(), error: null as string | null };
  } catch (err: any) {
    return { name, ok: false, results: [] as WebSearchResult[], error: err.message || String(err) };
  }
}

export async function webSearch(query: string, limit = 5): Promise<WebSearchResult[]> {
  const provider = optionalEnv('SEARCH_PROVIDER', 'auto').toLowerCase();

  if (provider === 'serper') return searchSerper(query, limit);
  if (provider === 'serpapi') return searchSerpApi(query, limit);

  const [serper, serpapi] = await Promise.all([
    safeSearch('serper', () => searchSerper(query, limit)),
    safeSearch('serpapi', () => searchSerpApi(query, limit))
  ]);

  const available = [serper, serpapi].filter((x) => x.results.length > 0);
  if (!available.length) return [];

  const best = available.sort((a, b) => scoreResults(b.results) - scoreResults(a.results))[0];
  const merged = dedupeAndRank([...best.results, ...available.flatMap((x) => x.results)], limit);
  return merged.map((item) => ({ ...item, source: item.source || best.name }));
}

async function searchSerper(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = optionalEnv('SERPER_API_KEY');
  if (!key) return [];
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: limit })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Serper error: ${res.status} ${JSON.stringify(data)}`);
  return (data.organic || []).slice(0, limit).map((x: any) => ({
    title: x.title || '',
    url: x.link || '',
    snippet: x.snippet || '',
    source: 'serper'
  }));
}

async function searchSerpApi(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = optionalEnv('SERPAPI_API_KEY');
  if (!key) return [];
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(limit));
  url.searchParams.set('api_key', key);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`SerpApi error: ${res.status} ${JSON.stringify(data)}`);
  return (data.organic_results || []).slice(0, limit).map((x: any) => ({
    title: x.title || '',
    url: x.link || '',
    snippet: x.snippet || '',
    source: 'serpapi'
  }));
}
