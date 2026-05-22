import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { getXUserByUsername, getXUserTimeline, analyzeXTweet } from '../../../lib/x';

const VERSION = 'viral-account-scan-v1';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function cleanHandle(value: string) {
  return String(value || '').replace(/^@/, '').trim();
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

    const manualHandles = body.handles || url.searchParams.getAll('handle');
    const { data: accountRows } = await supabase.from('accounts').select('*').order('tier', { ascending: true }).limit(25);
    const dbHandles = (accountRows || []).map((a: any) => a.handle || a.username || a.account_handle).filter(Boolean);
    const handles = Array.from(new Set([...manualHandles, ...dbHandles].map(cleanHandle))).slice(0, 25);

    const scanResults: any[] = [];
    const errors: any[] = [];
    for (const handle of handles) {
      try {
        const user = await getXUserByUsername(handle);
        if (!user.id) throw new Error('User id not returned from X.');
        const tweets = await getXUserTimeline(user.id);
        const analyzed = tweets.map((t: any) => analyzeXTweet(t, user)).sort((a: any, b: any) => (b.engagement_per_1k_followers || 0) - (a.engagement_per_1k_followers || 0));
        scanResults.push({ user, top_tweets: analyzed.slice(0, 10), all_tweets_count: tweets.length });
      } catch (err: any) {
        errors.push({ handle, error: err.message });
      }
    }

    const prompt = `You are the Deep Viral Mechanics Analyst for @${optionalEnv('X_USERNAME', '30piq')}.
Goal: understand how high-performing accounts in AI x Productivity x Career Growth get engagement: what they post, when they post, how they phrase hooks, why people reply, repost, quote, or bookmark, and how @30piq should adapt without copying.
Use only scanResults and errors. Do not invent tweets or metrics. Analyze timing, format, tone, hook, simplicity, controversy, social proof, utility, reply triggers, and bookmark triggers.
scanResults=${JSON.stringify(scanResults)}
errors=${JSON.stringify(errors)}
Return strict JSON with keys: mode, data_quality, account_patterns, cross_account_patterns, timing_rules, reply_rules, quote_rules, post_rules, today_content_brief, needs_more_data.`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Analyze real engagement mechanics from supplied X timeline metrics only. No invented claims.' },
        { role: 'user', content: prompt }
      ]
    });
    const intel = JSON.parse(completion.choices[0]?.message?.content || '{}');

    if (Array.isArray(intel.cross_account_patterns) && intel.cross_account_patterns.length) {
      await supabase.from('creator_intel').insert(intel.cross_account_patterns.slice(0, 10).map((p: any) => ({
        creator_handle: 'account_scan',
        post_url: null,
        topic: 'deep_viral_pattern',
        hook_pattern: p.pattern || null,
        format_pattern: p.evidence || null,
        why_it_worked: p.evidence || null,
        adaptation_idea: p.adaptation_for_30piq || null,
        status: intel.data_quality || 'new'
      })));
    }

    const trendRows = [
      ...(intel.timing_rules || []).slice(0, 5).map((r: any) => ({ topic: 'timing_rule', source: 'viral-account-scan', heat_score: 8, content_type_suggestion: 'timing', notes: `${r.rule || ''} Evidence: ${r.evidence || ''}` })),
      ...(intel.post_rules || []).slice(0, 5).map((r: any) => ({ topic: 'post_rule', source: 'viral-account-scan', heat_score: 8, content_type_suggestion: 'post_rule', notes: `${r.rule || ''} Why: ${r.why || ''}` }))
    ];
    if (trendRows.length) await supabase.from('trends').insert(trendRows);

    const log = await insertSessionLog({
      actions_completed: ['viral_account_scan', VERSION],
      decisions_made: [intel.today_content_brief || {}],
      pending_tasks: [...(intel.post_rules || []), ...(intel.reply_rules || [])],
      next_recommendation: 'Run daily-run after viral-account-scan so final content uses timing, tone, and engagement mechanics.'
    });

    return Response.json({ ok: true, version: VERSION, handles, errors, scanResults, intel, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
