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

function containsUnsafeClaim(text: string): boolean {
  const t = text.toLowerCase();
  const badPatterns = [
    /\bi\b/,
    /\bmy\b/,
    /\bme\b/,
    /from experience/,
    /experiment/,
    /tested/,
    /i found/,
    /result\??/,
    /\d+\s*%/,
    /\d+\s*(hours?|minutes?|x)\b/,
    /saved/,
    /boosted/,
    /increased/,
    /improved/,
    /doubling/,
    /recruiters notice/,
    /â/,
    /—/,
    /’/,
    /“/,
    /”/
  ];
  return badPatterns.some((p) => p.test(t));
}

function cleanAscii(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/â€”/g, '-')
    .replace(/[^\x00-\x7F]/g, '')
    .trim();
}

function fallbackPack() {
  return {
    mode: 'bootstrap',
    today_goal: 'Publish safe, original bootstrap content without unverified personal claims or fake metrics.',
    single_tweets: [
      {
        text: 'Most AI productivity advice starts with tools. Better starting point: pick one recurring workflow, write the decision steps, then use AI to reduce the busywork without hiding the reasoning.',
        why_it_works: 'Practical framework, no fake personal claim, clear AI productivity angle.',
        originality_element: 'Workflow-first framework',
        best_time_utc: '13:00'
      },
      {
        text: 'A useful AI rule for career growth: automate the repeatable parts, but keep the judgment loop. The goal is not to think less. It is to spend more time on decisions that compound.',
        why_it_works: 'Balanced opinion that avoids hype and supports long-term career positioning.',
        originality_element: 'Caveat plus decision framework',
        best_time_utc: '15:00'
      },
      {
        text: 'Before adding another AI tool, ask: does it reduce a real bottleneck, improve output quality, or help you learn faster? If it does none of those, it is probably productivity theatre.',
        why_it_works: 'Simple checklist that helps readers evaluate tools instead of chasing trends.',
        originality_element: 'Three-question evaluation checklist',
        best_time_utc: '17:00'
      }
    ],
    reply_targets_strategy: [
      {
        target_type: 'creator',
        reply_angle: 'Add a workflow-first perspective without claiming personal metrics.',
        prepared_reply: 'Useful point. One filter that helps: before adding an AI tool, map the workflow bottleneck first. Otherwise the tool becomes another tab instead of real leverage.'
      },
      {
        target_type: 'topic',
        reply_angle: 'Add a balanced career growth caveat.',
        prepared_reply: 'The career upside is strongest when AI removes repeatable work but keeps the judgment loop visible. Automating the wrong step can make people faster but not better.'
      },
      {
        target_type: 'topic',
        reply_angle: 'Offer a simple evaluation checklist.',
        prepared_reply: 'A simple test: does the tool reduce a bottleneck, improve quality, or speed up learning? If none of those happen, it is probably just productivity theatre.'
      }
    ],
    quote_tweet_strategy: [
      {
        target_type: 'post/topic',
        quote_angle: 'Add a practical framework to AI productivity discussions.',
        prepared_quote: 'The best AI workflows do not just save time. They preserve judgment while removing repeatable busywork. That distinction matters for career growth.'
      }
    ],
    github_decision: { needed: false, repo_name: '', asset_type: '', readme_outline: '' },
    quality_checks: [
      'No fake personal claims.',
      'No unverified numbers or percentages.',
      'ASCII punctuation only.',
      'Each tweet has a framework, caveat, checklist, or workflow.'
    ],
    human_checklist: [
      'Publish the 3 safe tweets manually.',
      'Use the 3 reply templates only after adapting them to the target post.',
      'Do not publish any older queued content with fake metrics.',
      'Log published URLs after posting.'
    ]
  };
}

function normalizePack(pack: any) {
  const tweets = Array.isArray(pack?.single_tweets) ? pack.single_tweets : [];
  const allText = [
    ...tweets.map((t: any) => String(t.text || '')),
    ...(Array.isArray(pack?.reply_targets_strategy) ? pack.reply_targets_strategy.map((r: any) => String(r.prepared_reply || '')) : []),
    ...(Array.isArray(pack?.quote_tweet_strategy) ? pack.quote_tweet_strategy.map((q: any) => String(q.prepared_quote || '')) : [])
  ];

  if (tweets.length !== 3 || allText.some(containsUnsafeClaim)) {
    return fallbackPack();
  }

  pack.single_tweets = tweets.slice(0, 3).map((t: any) => ({
    ...t,
    text: cleanAscii(String(t.text || '')).slice(0, 240),
    why_it_works: cleanAscii(String(t.why_it_works || '')),
    originality_element: cleanAscii(String(t.originality_element || 'Original framework')),
    best_time_utc: cleanAscii(String(t.best_time_utc || '15:00'))
  }));

  pack.reply_targets_strategy = (Array.isArray(pack.reply_targets_strategy) ? pack.reply_targets_strategy : []).slice(0, 3).map((r: any) => ({
    ...r,
    reply_angle: cleanAscii(String(r.reply_angle || 'Add a useful perspective.')),
    prepared_reply: cleanAscii(String(r.prepared_reply || '')).slice(0, 280)
  }));

  pack.quote_tweet_strategy = (Array.isArray(pack.quote_tweet_strategy) ? pack.quote_tweet_strategy : []).slice(0, 1).map((q: any) => ({
    ...q,
    quote_angle: cleanAscii(String(q.quote_angle || 'Add a practical framework.')),
    prepared_quote: cleanAscii(String(q.prepared_quote || '')).slice(0, 280)
  }));

  pack.human_checklist = (Array.isArray(pack.human_checklist) ? pack.human_checklist : []).slice(0, 4).map((x: any) => cleanAscii(String(x)));
  pack.quality_checks = (Array.isArray(pack.quality_checks) ? pack.quality_checks : []).slice(0, 5).map((x: any) => cleanAscii(String(x)));
  return pack;
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
- Use plain ASCII punctuation only.
- Do not invent personal experiences, test results, percentages, revenue, job outcomes, or tool performance.
- Do not write first-person claims unless the provided state contains proof.
- Do not copy creators and do not create engagement bait.
- Keep each tweet under 240 characters.
- Create exactly 3 single tweets, 3 reply templates, and 1 quote template.
- Each tweet must contain one original element: useful framework, contrarian opinion, comparison, checklist, caveat, or practical workflow.

State:
accountState=${JSON.stringify(input.accountState)}
targets=${JSON.stringify(input.targets)}
requirements=${JSON.stringify(input.requirements)}
recentContent=${JSON.stringify(input.recentContent)}
creatorIntel=${JSON.stringify(input.creatorIntel)}

Return JSON with keys: mode, today_goal, single_tweets, reply_targets_strategy, quote_tweet_strategy, github_decision, quality_checks, human_checklist.`;
  const response = await client.chat.completions.create({
    model,
    temperature: 0.35,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'You are a strict JSON-producing editor. Never invent personal proof or metrics.' },
      { role: 'user', content: prompt }
    ]
  });
  const text = response.choices[0]?.message?.content || '{}';
  try {
    return normalizePack(JSON.parse(text));
  } catch {
    return fallbackPack();
  }
}
