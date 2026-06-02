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
import { recallBrainContext } from '../brain';
import type { LeanConfig } from './config';
import type { HarvestedTweet } from './harvest';
import type { WinningExample } from './memory';

export type Suggestion = {
  type: 'reply' | 'quote' | 'standalone';
  text: string;
  source_url: string | null;
  source_handle: string | null;
  source_age_hours: number | null;
  rationale: string;
};

type BrainContext = Awaited<ReturnType<typeof recallBrainContext>>;

function buildSystemPrompt(cfg: LeanConfig, examples: WinningExample[], brain: BrainContext | null): string {
  const lines: string[] = [];
  lines.push(`You write X (Twitter) content for the account @${cfg.accountHandle}.`);
  lines.push(`Niche (stay strictly inside it): ${cfg.niche}.`);
  lines.push('');
  lines.push('VOICE:');
  lines.push(cfg.voice);
  lines.push('');
  lines.push('HARD RULES:');
  for (const r of cfg.rules) lines.push(`- ${r}`);

  // Ground the model in the brain: algorithm mechanics, the account's proven
  // winners, and patterns to avoid. This is what makes output follow the mind.
  if (brain) {
    if (brain.algorithm.length) {
      lines.push('');
      lines.push('HOW THE X ALGORITHM ACTUALLY REWARDS CONTENT (apply these mechanics):');
      for (const m of brain.algorithm.slice(0, 5)) lines.push(`- ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    if (brain.patterns.length) {
      lines.push('');
      lines.push('PATTERNS THAT PERFORM IN THIS NICHE RIGHT NOW (apply the tactic, never copy the wording):');
      for (const m of brain.patterns.slice(0, 4)) lines.push(`- ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    if (brain.winners.length) {
      lines.push('');
      lines.push('WHAT HAS WORKED FOR THIS ACCOUNT BEFORE (match the underlying angle, do not copy):');
      for (const m of brain.winners.slice(0, 4)) lines.push(`- ${m.content.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    if (brain.avoid.length) {
      lines.push('');
      lines.push('PATTERNS THAT FAILED — DO NOT REPEAT THESE:');
      for (const m of brain.avoid.slice(0, 3)) lines.push(`- ${m.content.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
  }

  lines.push('');
  lines.push('WHAT MAKES A POST WORTH SUGGESTING:');
  lines.push('- It says something a knowledgeable person would actually think but most people would not bother to write.');
  lines.push('- Replies should add a specific angle, caveat, example, or counterpoint — not "great point" or "so true".');
  lines.push('- Quotes should reframe the original with your own take. Write ONLY your take — do NOT quote or echo the source\'s words, and do not start with "\\"...\\" →".');
  lines.push('- Standalone posts should be a sharp observation or useful tip from the niche, self-contained.');
  lines.push('');
  lines.push('BANNED FILLER — never use these formula phrases, they read as empty:');
  lines.push('  "the real win", "the underrated win", "the real innovation", "ultimate moat",');
  lines.push('  "most miss that", "the gap isn\'t just", "here\'s the thing", "plot twist".');
  lines.push('  Make the concrete claim directly instead of announcing that you have an insight.');
  lines.push('NEVER speculate about internal hardware/model capabilities you cannot verify');
  lines.push('  (no "they\'ve likely cracked...", "must have solved...", "means they cracked...").');

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
  // Build a retrieval query from the freshest harvested context so the brain
  // returns knowledge relevant to today's conversation, not generic rules.
  const recallQuery = [cfg.niche, ...tweets.slice(0, 8).map((t) => t.text)].join(' \n ').slice(0, 2000);
  let brain: BrainContext | null = null;
  try {
    brain = await recallBrainContext(recallQuery, cfg.niche);
  } catch {
    brain = null; // brain is optional; never block generation on it
  }

  const system = buildSystemPrompt(cfg, examples, brain);
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
      source_age_hours: matched?.age_hours ?? null,
      rationale: String(s?.rationale || '').trim().slice(0, 160),
    });
  }
  return out;
}
