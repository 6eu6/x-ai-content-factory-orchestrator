/**
 * Lean Core — Generator (single model call)
 *
 * One prompt produces the whole daily batch: replies, quotes, and standalone
 * posts, in the account's voice, grounded in (a) freshly harvested niche tweets
 * and (b) the account's own best-performing past posts (RAG few-shot).
 *
 * This single call replaces the legacy chain of opportunity_intelligence ->
 * content_crafting -> quality_enhance -> opportunity_judge -> near_pass_polish
 * (5+ model calls per opportunity, each a failure point).
 */

import { callModel, parseModelJson } from '../model-router';
import type { LeanConfig } from './config';
import type { HarvestedTweet } from './harvest';
import type { WinningExample } from './memory';

export type Suggestion = {
  type: 'reply' | 'quote' | 'standalone';
  text: string;
  source_url: string | null;
  source_handle: string | null;
  rationale: string;
};

function buildSystemPrompt(cfg: LeanConfig, examples: WinningExample[]): string {
  const lines: string[] = [];
  lines.push(`You write X (Twitter) content for the account @${cfg.accountHandle}.`);
  lines.push(`Niche (stay strictly inside it): ${cfg.niche}.`);
  lines.push('');
  lines.push('VOICE:');
  lines.push(cfg.voice);
  lines.push('');
  lines.push('HARD RULES:');
  for (const r of cfg.rules) lines.push(`- ${r}`);
  lines.push('');
  lines.push('WHAT MAKES A POST WORTH SUGGESTING:');
  lines.push('- It says something a knowledgeable person would actually think but most people would not bother to write.');
  lines.push('- Replies should add a specific angle, caveat, example, or counterpoint — not "great point" or "so true".');
  lines.push('- Quotes should reframe the original with your own take, not just restate it.');
  lines.push('- Standalone posts should be a sharp observation or useful tip from the niche, self-contained.');

  if (examples.length) {
    lines.push('');
    lines.push('THE ACCOUNT\'S OWN BEST-PERFORMING POSTS (match this register and quality, do not copy):');
    for (const ex of examples.slice(0, 6)) {
      lines.push(`- (${ex.type}) ${ex.text.replace(/\s+/g, ' ').slice(0, 220)}`);
    }
  }

  lines.push('');
  lines.push('OUTPUT: Return ONLY valid JSON, no markdown, in this exact shape:');
  lines.push('{"suggestions":[{"type":"reply|quote|standalone","source_url":"<url or null>","text":"<the post>","rationale":"<one short line: why this can earn engagement>"}]}');
  return lines.join('\n');
}

function buildUserPrompt(cfg: LeanConfig, tweets: HarvestedTweet[]): string {
  const lines: string[] = [];
  lines.push(`Produce exactly ${cfg.mix.replies} replies, ${cfg.mix.quotes} quotes, and ${cfg.mix.standalone} standalone posts.`);
  lines.push('Replies and quotes MUST target one of the source tweets below (use its url as source_url).');
  lines.push('Standalone posts have source_url = null.');
  lines.push('');
  lines.push('SOURCE TWEETS (recent, from accounts in the niche):');
  const pool = tweets.slice(0, 25);
  pool.forEach((t, i) => {
    const age = t.age_hours == null ? '?' : `${Math.round(t.age_hours)}h`;
    lines.push(`[${i + 1}] @${t.source_handle} (${age} old) ${t.tweet_url}`);
    lines.push(`    "${t.text.replace(/\s+/g, ' ').slice(0, 260)}"`);
  });
  return lines.join('\n');
}

export async function generateSuggestions(
  cfg: LeanConfig,
  tweets: HarvestedTweet[],
  examples: WinningExample[],
  runId?: string,
): Promise<Suggestion[]> {
  const system = buildSystemPrompt(cfg, examples);
  const user = buildUserPrompt(cfg, tweets);

  const raw = await callModel(
    'content_crafting',
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { response_format: { type: 'json_object' }, temperature: 0.55, max_tokens: 2600, run_id: runId },
  );

  const parsed = parseModelJson(raw);
  const arr: any[] = Array.isArray(parsed) ? parsed : parsed?.suggestions || [];

  const urlByIndex = new Map<string, HarvestedTweet>();
  for (const t of tweets) urlByIndex.set(t.tweet_url, t);

  const out: Suggestion[] = [];
  for (const s of arr) {
    const type = String(s?.type || '').toLowerCase();
    const text = String(s?.text || '').trim();
    if (!text) continue;
    if (type !== 'reply' && type !== 'quote' && type !== 'standalone') continue;
    const sourceUrl = s?.source_url && String(s.source_url).startsWith('http') ? String(s.source_url) : null;
    const matched = sourceUrl ? urlByIndex.get(sourceUrl) : null;
    out.push({
      type: type as Suggestion['type'],
      text,
      source_url: sourceUrl,
      source_handle: matched?.source_handle || null,
      rationale: String(s?.rationale || '').trim().slice(0, 160),
    });
  }
  return out;
}
