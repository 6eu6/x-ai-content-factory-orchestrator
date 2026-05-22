import { optionalEnv } from './env';

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  source: string;
};

export async function webSearch(query: string, limit = 5): Promise<WebSearchResult[]> {
  const provider = optionalEnv('SEARCH_PROVIDER', '').toLowerCase();
  if (provider === 'serper') return searchSerper(query, limit);
  if (provider === 'serpapi') return searchSerpApi(query, limit);
  return [];
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
  return (data.organic || []).slice(0, limit).map((x: any) => ({ title: x.title || '', url: x.link || '', snippet: x.snippet || '', source: 'serper' }));
}

async function searchSerpApi(query: string, limit: number): Promise<WebSearchResult[]> {
  const key = optionalEnv('SERPAPI_API_KEY') || optionalEnv('SERPER_API_KEY');
  if (!key) return [];
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(limit));
  url.searchParams.set('api_key', key);
  const res = await fetch(url.toString());
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`SerpApi error: ${res.status} ${JSON.stringify(data)}`);
  return (data.organic_results || []).slice(0, limit).map((x: any) => ({ title: x.title || '', url: x.link || '', snippet: x.snippet || '', source: 'serpapi' }));
}
