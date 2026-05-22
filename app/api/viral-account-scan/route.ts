import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { getXUserByUsername, getXUserTimeline, analyzeXTweet } from '../../../lib/x';

const VERSION = 'viral-account-scan-v3-budget-mode';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function cleanHandle(value: string) {
  return String(value || '').replace(/^@/, '').trim();
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function normalizeIntel(raw: any) {
  return {
    ...raw,
    account_patterns: asArray(raw.account_patterns),
    cross_account_patterns: asArray(raw.cross_account_patterns),
    timing_rules: asArray(raw.timing_rules),
    reply_rules: asArray(raw.reply_rules),
    quote_rules: asArray(raw.quote_rules),
    post_rules: asArray(raw.post_rules),
    needs_more_data: asArray(raw.needs_more_data)
  };
}

function numParam(value: any, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === 'POST') {
      try { body = await req.json(); } catch {}
    }

    const maxAccounts = numParam(body.max_accounts || url.searchParams.get('max_accounts') || optionalEnv('X_SCAN_MAX_ACCOUNTS', '3'), 3, 1, 10);
    const tweetsPerAccount = numParam(body.tweets_per_account || url.searchParams.get('tweets_per_account') || optionalEnv('X_SCAN_TWEETS_PER_ACCOUNT', '5'), 5, 5, 20);
    const dryRun = String(body.dry_run || url.searchParams.get('dry_run') || '').toLowerCase() === 'true';

    const manualHandles = body.handles || url.searchParams.getAll('handle');
    const { data: accountRows } = await supabase.from('accounts').select('*').order('tier', { ascending: true }).limit(maxAccounts);
    const dbHandles = (accountRows || []).map((a: any) => a.handle || a.username || a.account_handle).filter(Boolean);
    const handles = Array.from(new Set([...manualHandles, ...dbHandles].map(cleanHandle))).slice(0, maxAccounts);

    const budget = {
      max_accounts: maxAccounts,
      tweets_per_account: tweetsPerAccount,
      estimated_x_requests: handles.length * 2,
      dry_run: dryRun
    };

    if (dryRun) {
      return Response.json({ ok: true, version: VERSION, budget, handles, note: 'Dry run only. No X API calls were made.' });
    }

    const scanResults: any[] = [];
    const errors: any[] = [];
    for (const handle of handles) {
      try {
        const user = await getXUserByUsername(handle);
        if (!user.id) throw new Error('User id not returned from X.');
        const tweets = await getXUserTimeline(user.id, tweetsPerAccount);
        const analyzed = tweets.map((t: any) => analyzeXTweet(t, user)).sort((a: any, b: any) => (b.engagement_per_1k_followers || 0) - (a.engagement_per_1k_followers || 0));
        scanResults.push({ user, top_tweets: analyzed.slice(0, tweetsPerAccount), all_tweets_count: tweets.length });
      } catch (err: any) {
        errors.push({ handle, error: err.message });
      }
    }

    const prompt = `You are the Deep Viral Mechanics Analyst for @${optionalEnv('X_USERNAME', '30piq')}.
Goal: understand how high-performing accounts in AI x Productivity x Career Growth get engagement: what they post, when they post, how they phrase hooks, why people reply, repost, quote, or bookmark, and how @30piq should adapt without copying.
Use only scanResults and errors. Do not invent tweets or metrics. Analyze timing, format, tone, hook, simplicity, controversy, social proof, utility, reply triggers, and bookmark triggers.
IMPORTANT: Return these fields as arrays even if there is only one item: account_patterns, cross_account_patterns, timing_rules, reply_rules, quote_rules, post_rules, needs_more_data.
budget=${JSON.stringify(budget)}
scanResults=${JSON.stringify(scanResults)}
errors=${JSON.stringify(errors)}
Return strict JSON with keys: mode, data_quality, account_patterns, cross_account_patterns, timing_rules, reply_rules, quote_rules, post_rules, today_content_brief, needs_more_data.`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Analyze real engagement mechanics from supplied X timeline metrics only. No invented claims. Array fields must always be arrays.' },
        { role: 'user', content: prompt }
      ]
    });
    const intel = normalizeIntel(JSON.parse(completion.choices[0]?.message?.content || '{}'));

    if (intel.cross_account_patterns.length) {
      await supabase.from('creator_intel').insert(intel.cross_account_patterns.slice(0, 10).map((p: any) => ({
        creator_handle: 'account_scan',
        post_url: null,
        topic: 'deep_viral_pattern',
        hook_pattern: p.pattern || p.rule || null,
        format_pattern: p.evidence || p.mechanism || null,
        why_it_worked: p.evidence || p.why || null,
        adaptation_idea: p.adaptation_for_30piq || p.adaptation || null,
        status: intel.data_quality || 'new'
      })));
    }

    const trendRows = [
      ...intel.timing_rules.slice(0, 5).map((r: any) => ({ topic: 'timing_rule', source: 'viral-account-scan', heat_score: 8, content_type_suggestion: 'timing', notes: `${r.rule || r.timing || String(r)} Evidence: ${r.evidence || ''}` })),
      ...intel.post_rules.slice(0, 5).map((r: any) => ({ topic: 'post_rule', source: 'viral-account-scan', heat_score: 8, content_type_suggestion: 'post_rule', notes: `${r.rule || String(r)} Why: ${r.why || ''}` }))
    ];
    if (trendRows.length) await supabase.from('trends').insert(trendRows);

    const log = await insertSessionLog({
      actions_completed: ['viral_account_scan', VERSION],
      decisions_made: [intel.today_content_brief || {}],
      pending_tasks: [...intel.post_rules, ...intel.reply_rules],
      next_recommendation: 'Run daily-run after viral-account-scan so final content uses timing, tone, and engagement mechanics.'
    });

    return Response.json({ ok: true, version: VERSION, budget, handles, errors, scanResults, intel, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message });
  }
}
