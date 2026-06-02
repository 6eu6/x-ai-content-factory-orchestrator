/**
 * Lean Core — Web enrichment (Reddit + YouTube + web → brain)
 *
 * Twitter alone is an echo chamber. Once a day this pulls what the niche is
 * actually discussing on Reddit (pain points, questions), what's trending on
 * YouTube (tutorials, tools), and recent web signal — then distils transferable
 * content angles into the brain as `source_pattern` / `insight` memories.
 *
 * Feeds the brain silently (no Telegram noise). Bounded: a few searches + one
 * model call per run, so cost stays negligible (well within Serper's free tier).
 */

import { callModel, parseModelJson } from '../model-router';
import { remember } from '../brain';
import { webSearch, redditQuery, searchEnabled } from './web-search';
import type { LeanConfig } from './config';

export type EnrichReport = { searched: number; learned: number; patterns: string[] };

export async function enrichFromWeb(cfg: LeanConfig): Promise<EnrichReport> {
  if (!searchEnabled()) return { searched: 0, learned: 0, patterns: [] };

  const niche = cfg.niche;
  const [reddit, youtube, web] = await Promise.all([
    webSearch(redditQuery(`${niche} (problem OR frustrating OR how do I OR best tool)`), { num: 6, source: 'reddit' }),
    webSearch(niche, { engine: 'youtube', num: 6 }),
    webSearch(`${niche} latest`, { num: 5 }),
  ]);

  const all = [...reddit, ...youtube, ...web].filter((h) => h.title || h.snippet);
  if (!all.length) return { searched: 0, learned: 0, patterns: [] };

  const system = [
    `You mine real niche discussion to find transferable CONTENT ANGLES for the X account in niche "${niche}".`,
    'Input mixes Reddit threads (pain points, questions), YouTube videos (what people want explained), and web headlines.',
    'Return ONLY JSON: {"angles":[{"angle":"<a specific post idea or recurring pain point, 1 sentence>","why":"<why it would land>","source":"reddit|youtube|web"}]}',
    'Extract at most 6 distinct, concrete angles. Skip anything generic or off-niche. No engagement-bait phrasing.',
  ].join('\n');

  const user = all
    .slice(0, 17)
    .map((h, i) => `[${i + 1}] (${h.source}) ${h.title} — ${String(h.snippet).slice(0, 160)}`)
    .join('\n');

  let angles: { angle: string; why: string; source: string }[] = [];
  try {
    const raw = await callModel('learning_extraction', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { response_format: { type: 'json_object' }, max_tokens: 1300 });
    const parsed = parseModelJson(raw);
    angles = Array.isArray(parsed?.angles) ? parsed.angles : [];
  } catch {
    angles = [];
  }

  const learned: string[] = [];
  for (const a of angles.slice(0, 6)) {
    const angle = String(a?.angle || '').trim();
    if (angle.length < 15) continue;
    const why = String(a?.why || '').trim();
    const src = ['reddit', 'youtube', 'web'].includes(String(a?.source)) ? String(a.source) : 'web';
    const content = why ? `${angle} (why: ${why})` : angle;
    const id = await remember({
      kind: 'source_pattern',
      // Unproven web angle: start below proven account memories so it informs
      // but never dominates; it earns weight only if it actually performs.
      content,
      weight: 4,
      niche,
      language: cfg.tweetLanguage,
      source: `web_enrich:${src}`,
    });
    if (id) learned.push(content);
  }

  return { searched: all.length, learned: learned.length, patterns: learned };
}
