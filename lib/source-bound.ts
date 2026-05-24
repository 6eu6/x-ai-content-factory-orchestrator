export function sourceCorpus(searchResults: any[]) {
  return searchResults
    .flatMap((g) => g.results || [])
    .map((r: any) => `${r.title || ''} ${r.snippet || ''} ${r.url || ''}`.toLowerCase())
    .join('\n');
}

export function allowedUrlSet(searchResults: any[]) {
  return new Set(searchResults.flatMap((g) => (g.results || []).map((r: any) => r.url)).filter(Boolean));
}

export function hasValidSourceUrls(item: any, urls: Set<string>) {
  return Array.isArray(item?.source_urls) && item.source_urls.some((u: string) => urls.has(u));
}

export function hasUnsupportedEntity(item: any, corpus: string) {
  const text = JSON.stringify(item || {}).toLowerCase();
  const risky = ['gemini omni', 'meta avocado', 'claude squad', 'nyt + leaks', 'leaked reports'];
  return risky.some((term) => text.includes(term) && !corpus.includes(term));
}

export function sourceBoundFilter(items: any, searchResults: any[]) {
  const urls = allowedUrlSet(searchResults);
  const corpus = sourceCorpus(searchResults);
  return (Array.isArray(items) ? items : []).filter((item) => hasValidSourceUrls(item, urls) && !hasUnsupportedEntity(item, corpus));
}

export function safeBriefFromOpportunities(opportunities: any[]) {
  const top = opportunities.slice(0, 3);
  return {
    summary: 'Use only source-backed opportunities from the latest research run. Avoid unsupported tool names, leaked-news claims, and invented metrics.',
    key_actions: top.map((o: any) => `Create source-backed ${o.content_type || o.type || 'content'}: ${o.title || o.idea || o.topic}`),
    source_urls: top.flatMap((o: any) => o.source_urls || [])
  };
}
