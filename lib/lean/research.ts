/**
 * Lean Core — Deep research (on demand)
 *
 * Some opportunities are pure entertainment formats (music + clip + reaction) —
 * we never re-use someone else's media (copyright / suspension risk); we only
 * recognise the format. Others are about a tool or feature and deserve a real
 * explainer. For those, this does a precise web search, verifies the facts
 * against sources, and returns a brief + a short clip script so the user can
 * record their OWN original clip.
 *
 * On demand only (triggered by a Telegram button) to keep cost low.
 */

import { optionalEnv } from '../env';
import { callModel, parseModelJson } from '../model-router';
import { languageName } from './config';

type SearchHit = { title: string; snippet: string; link: string };

/** Web search via Serper (google). Returns [] if no key or on failure. */
async function webSearch(query: string, n = 6): Promise<SearchHit[]> {
  const key = optionalEnv('SERPER_API_KEY');
  if (!key) return [];
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
      body: JSON.stringify({ q: query, num: n }),
    });
    if (!res.ok) return [];
    const json: any = await res.json();
    const organic: any[] = Array.isArray(json?.organic) ? json.organic : [];
    return organic.slice(0, n).map((o) => ({
      title: String(o?.title || ''),
      snippet: String(o?.snippet || ''),
      link: String(o?.link || ''),
    }));
  } catch {
    return [];
  }
}

export type ResearchBrief = {
  topic: string;
  verified: boolean;          // true when grounded in real search results
  summary: string;
  key_points: string[];
  clip_script: string[];      // "say this, then this"
  sources: string[];
};

export async function researchTopic(topic: string, language = 'en'): Promise<ResearchBrief> {
  const hits = await webSearch(topic, 6);
  const verified = hits.length > 0;
  const lang = languageName(language);

  const sourcesBlock = hits.length
    ? hits.map((h, i) => `[${i + 1}] ${h.title} — ${h.snippet} (${h.link})`).join('\n')
    : '(no search results available — rely on general knowledge and mark uncertainty)';

  const system = [
    `You produce a tight, ACCURATE explainer brief in ${lang} so the user can record their own short clip about a tool or feature.`,
    verified
      ? 'Ground every claim in the provided sources. Do not invent facts or numbers. If sources disagree or are thin, say so.'
      : 'No live sources were available. Be conservative, avoid specific numbers, and do not present guesses as facts.',
    'Return ONLY JSON: {"summary":"<2-3 sentences>","key_points":["..."],"clip_script":["line the user can say, in order"],"sources":["url"]}',
    'clip_script: 4-7 short spoken lines that build a clear, original explanation. No fluff, no engagement-bait.',
  ].join('\n');

  const user = `TOPIC: ${topic}\n\nSOURCES:\n${sourcesBlock}`;

  let parsed: any = {};
  try {
    const raw = await callModel('research_synthesis', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { response_format: { type: 'json_object' }, temperature: 0.2, max_tokens: 1400 });
    parsed = parseModelJson(raw);
  } catch {
    parsed = {};
  }

  return {
    topic,
    verified,
    summary: String(parsed?.summary || '').trim(),
    key_points: Array.isArray(parsed?.key_points) ? parsed.key_points.map((s: any) => String(s)).slice(0, 8) : [],
    clip_script: Array.isArray(parsed?.clip_script) ? parsed.clip_script.map((s: any) => String(s)).slice(0, 8) : [],
    sources: hits.map((h) => h.link).filter(Boolean),
  };
}

export function formatBrief(b: ResearchBrief, botLang: string): string {
  const isAr = botLang === 'ar';
  const lines: string[] = [];
  lines.push(`<b>🔍 ${isAr ? 'بحث عميق' : 'Deep research'}: ${b.topic}</b>`);
  if (!b.verified) lines.push(`<i>${isAr ? '⚠️ بلا مصادر حية — تحقّق قبل التصوير' : '⚠️ no live sources — verify before recording'}</i>`);
  if (b.summary) lines.push('\n' + b.summary);
  if (b.key_points.length) {
    lines.push(`\n<b>${isAr ? 'نقاط' : 'Key points'}:</b>`);
    for (const p of b.key_points) lines.push(`• ${p}`);
  }
  if (b.clip_script.length) {
    lines.push(`\n<b>${isAr ? 'سكربت المقطع' : 'Clip script'}:</b>`);
    b.clip_script.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  }
  if (b.sources.length) {
    lines.push(`\n<b>${isAr ? 'مصادر' : 'Sources'}:</b>`);
    for (const s of b.sources.slice(0, 5)) lines.push(s);
  }
  return lines.join('\n').slice(0, 4000);
}
