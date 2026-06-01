/**
 * Lean Core — Crawl (outward learning)
 *
 * Continuously harvests the niche and distills the highest-signal tweets into a
 * few transferable patterns, stored in the brain as `source_pattern` memories.
 *
 * Crucially this stores PATTERNS, not raw competitor tweets — so the brain
 * learns "what works" without turning into a copy-paste pile (the failure mode
 * of the legacy viral_pattern table). One model call per run keeps it cheap.
 */

import { callModel, parseModelJson } from '../model-router';
import { remember } from '../brain';
import { getActiveProfile } from './profile';
import { getLeanConfig, configFromProfile } from './config';
import { loadSourceAccounts } from './config';
import { harvestSources } from './harvest';

export type CrawlReport = {
  harvested: number;
  patterns_learned: number;
  patterns: string[];
};

export async function runCrawl(opts?: { accountHandle?: string }): Promise<CrawlReport> {
  const profile = await getActiveProfile(opts?.accountHandle).catch(() => null);
  const cfg = profile ? configFromProfile(profile) : getLeanConfig();

  const sources = cfg.sourceHandles.length
    ? cfg.sourceHandles.slice(0, cfg.sourceLimit).map((handle) => ({ handle, tier: null, category: null, followers: null }))
    : await loadSourceAccounts(cfg.sourceLimit);

  const tweets = await harvestSources(sources, cfg.tweetsPerSource);
  if (!tweets.length) return { harvested: 0, patterns_learned: 0, patterns: [] };

  // Take the strongest performers and ask the model for transferable patterns.
  const top = tweets.slice(0, 15);
  const system = [
    `You analyse high-performing tweets in the niche "${cfg.niche}" to extract reusable patterns.`,
    'Return ONLY JSON: {"patterns":[{"pattern":"<a transferable principle, not a copy of the tweet>","why":"<why it earns engagement>"}]}',
    'Each pattern must be a generalisable tactic (hook shape, angle, structure, timing), 1 sentence, usable for future original posts.',
    'Extract at most 5 distinct, non-obvious patterns. Skip anything generic.',
  ].join('\n');
  const user = top
    .map((t, i) => `[${i + 1}] (${Math.round(t.engagement)} eng) "${t.text.replace(/\s+/g, ' ').slice(0, 240)}"`)
    .join('\n');

  let patterns: { pattern: string; why: string }[] = [];
  try {
    const raw = await callModel('learning_extraction', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { response_format: { type: 'json_object' }, max_tokens: 1200 });
    const parsed = parseModelJson(raw);
    patterns = Array.isArray(parsed?.patterns) ? parsed.patterns : [];
  } catch {
    patterns = [];
  }

  const learned: string[] = [];
  for (const p of patterns.slice(0, 5)) {
    const content = String(p?.pattern || '').trim();
    if (content.length < 15) continue;
    const why = String(p?.why || '').trim();
    const full = why ? `${content} (why: ${why})` : content;
    const id = await remember({
      kind: 'source_pattern',
      content: full,
      weight: 5,
      niche: cfg.niche,
      language: cfg.tweetLanguage,
      source: 'niche_crawl',
    });
    if (id) learned.push(full);
  }

  return { harvested: tweets.length, patterns_learned: learned.length, patterns: learned };
}
