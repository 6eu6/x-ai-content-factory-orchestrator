import OpenAI from 'openai';
import { optionalEnv, requiredEnv } from './env';

export async function generateDailyContentPack(input: {
  accountState: unknown;
  targets: unknown;
  requirements: unknown;
  recentContent: unknown;
  creatorIntel: unknown;
}) {
  const client = new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY') });
  const model = optionalEnv('OPENAI_MODEL', 'gpt-4.1');
  const prompt = `
You are the X AI Content Factory operator for @${optionalEnv('X_USERNAME', '30piq')}.
Create a practical daily mission for an English X account about AI x productivity x career growth.

Rules:
- Do not copy creators.
- No engagement bait.
- Every post needs originality: opinion, workflow, comparison, experiment, caveat, or proof.
- Posting remains manual by the human.
- Output valid JSON only.

State:
accountState=${JSON.stringify(input.accountState)}
targets=${JSON.stringify(input.targets)}
requirements=${JSON.stringify(input.requirements)}
recentContent=${JSON.stringify(input.recentContent)}
creatorIntel=${JSON.stringify(input.creatorIntel)}

Return JSON with:
{
  "mode": "bootstrap|partial|live",
  "today_goal": "...",
  "single_tweets": [{"text":"...","why_it_works":"...","originality_element":"...","best_time_utc":"..."}],
  "reply_targets_strategy": [{"target_type":"creator/topic","reply_angle":"...","prepared_reply":"..."}],
  "quote_tweet_strategy": [{"target_type":"post/topic","quote_angle":"...","prepared_quote":"..."}],
  "github_decision": {"needed":false,"repo_name":"","asset_type":"","readme_outline":""},
  "quality_checks": ["..."],
  "human_checklist": ["..."]
}`;
  const response = await client.responses.create({ model, input: prompt, temperature: 0.7 });
  const text = response.output_text || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text, parse_warning: 'Model did not return strict JSON.' };
  }
}
