import OpenAI from 'openai';
import { optionalEnv, requiredEnv } from './env';

function buildClient() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({
    apiKey: requiredEnv('OPENAI_API_KEY'),
    baseURL: baseURL || undefined,
    defaultHeaders: baseURL.includes('openrouter.ai')
      ? {
          'HTTP-Referer': optionalEnv('OPENROUTER_REFERER', 'https://x.com/30piq'),
          'X-OpenRouter-Title': optionalEnv('OPENROUTER_TITLE', 'X AI Content Factory')
        }
      : undefined
  });
}

export async function generateDailyContentPack(input: {
  accountState: unknown;
  targets: unknown;
  requirements: unknown;
  recentContent: unknown;
  creatorIntel: unknown;
}) {
  const client = buildClient();
  const model = optionalEnv('OPENAI_MODEL', optionalEnv('OPENAI_BASE_URL').includes('openrouter.ai') ? 'openai/gpt-4.1-mini' : 'gpt-4.1-mini');
  const prompt = `
You are the X AI Content Factory operator for @${optionalEnv('X_USERNAME', '30piq')}.
Create a practical daily mission for an English X account about AI x productivity x career growth.

Critical rules:
- Output valid JSON only.
- Use plain ASCII punctuation only. Do not use curly quotes, em dashes, or special symbols.
- Do not invent personal experiences, test results, percentages, revenue, job outcomes, or tool performance.
- Do not write "I tried", "I found", "my experience", or any first-person claim unless the provided state contains proof.
- Do not copy creators and do not create engagement bait.
- Keep each tweet under 240 characters.
- Each tweet must contain one original element: useful framework, contrarian opinion, comparison, checklist, caveat, or practical workflow.
- Replies must be specific but safe: no fake personal claims.
- If live X data is unavailable, operate in bootstrap mode and say so in the goal.
- Prefer quality over volume: create exactly 3 single tweets, 3 reply templates, and 1 quote template.

State:
accountState=${JSON.stringify(input.accountState)}
targets=${JSON.stringify(input.targets)}
requirements=${JSON.stringify(input.requirements)}
recentContent=${JSON.stringify(input.recentContent)}
creatorIntel=${JSON.stringify(input.creatorIntel)}

Return JSON with this shape:
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
  const response = await client.chat.completions.create({
    model,
    temperature: 0.45,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a strict JSON-producing editor. Never invent personal proof or metrics.' },
      { role: 'user', content: prompt }
    ]
  });
  const text = response.choices[0]?.message?.content || '{}';
  try {
    return JSON.parse(text);
  } catch {
    return { raw_text: text, parse_warning: 'Model did not return strict JSON.' };
  }
}
