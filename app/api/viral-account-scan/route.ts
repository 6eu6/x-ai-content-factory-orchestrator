import OpenAI from 'openai';
import { createHash } from 'crypto';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';
import { getXUserAndTimeline, analyzeXTweet } from '../../../lib/x';
import { learnFromCrawlerItems, toArray } from '../../../lib/learning-memory';

const VERSION = 'viral-account-scan-v5-deep-memory';

type AnyRecord = Record<string, any>;

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

function textFrom(value: any, keys: string[] = []) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of keys) if (typeof value[key] === 'string' && value[key].trim()) return value[key];
  return '';
}

function normalizeDeepIntel(raw: any) {
  return {
    ...raw,
    account_analyses: asArray(raw.account_analyses || raw.accounts).map((a: any) => ({
      ...a,
      tweet_analyses: asArray(a?.tweet_analyses),
      winner_vs_loser: a?.winner_vs_loser || {},
      timing_patterns: asArray(a?.timing_patterns),
      publish_rules: asArray(a?.publish_rules),
      reply_rules: asArray(a?.reply_rules),
      quote_rules: asArray(a?.quote_rules),
      bookmark_rules: asArray(a?.bookmark_rules),
      avoid_rules: asArray(a?.avoid_rules)
    })),
    cross_account_patterns: asArray(raw.cross_account_patterns),
    timing_rules: asArray(raw.timing_rules),
    reply_rules: asArray(raw.reply_rules),
    quote_rules: asArray(raw.quote_rules),
    post_rules: asArray(raw.post_rules),
    bookmark_rules: asArray(raw.bookmark_rules),
    needs_more_data: asArray(raw.needs_more_data)
  };
}

function numParam(value: any, fallback: number, min: number, max: number) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

function boolParam(value: any) {
  return String(value || '').toLowerCase() === 'true';
}

function hashTweetIds(tweets: any[]) {
  return createHash('sha256').update(tweets.map((t: any) => String(t.tweet_id || '')).join('|')).digest('hex').slice(0, 24);
}

function analysisHandle(value: any) {
  return cleanHandle(value?.creator_handle || value?.username || value?.handle || value?.user?.username || '').toLowerCase();
}

function classifyRole(tweet: any, best: any, weakest: any) {
  if (tweet?.tweet_id && tweet.tweet_id === best?.tweet_id) return 'best';
  if (tweet?.tweet_id && tweet.tweet_id === weakest?.tweet_id) return 'weakest';
  return 'sample';
}

async function readCachedScan(supabase: any, handle: string, cacheHours: number) {
  const since = new Date(Date.now() - cacheHours * 60 * 60 * 1000).toISOString();
  const { data: run } = await supabase
    .from('viral_scan_runs')
    .select('*')
    .eq('creator_handle', handle)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!run) return null;

  const [tweets, patterns] = await Promise.all([
    supabase.from('viral_tweet_analyses').select('*').eq('scan_run_id', run.id).order('engagement_per_1k_followers', { ascending: false }),
    supabase.from('viral_account_patterns').select('*').eq('scan_run_id', run.id).order('confidence_score', { ascending: false })
  ]);
  return { creator_handle: handle, reused_cached_result: true, run, tweet_analyses: tweets.data || [], patterns: patterns.data || [] };
}

async function persistAccountAnalysis(input: { supabase: any; handle: string; scanResult: AnyRecord; accountAnalysis: AnyRecord; budget: AnyRecord; model: string; dataQuality: string; }) {
  const { supabase, handle, scanResult, accountAnalysis, budget, model, dataQuality } = input;
  const analyzedTweets = scanResult.top_tweets || [];
  const best = analyzedTweets[0] || null;
  const weakest = analyzedTweets[analyzedTweets.length - 1] || null;
  const { data: runRow, error: runError } = await supabase.from('viral_scan_runs').insert({
    creator_handle: handle,
    scan_version: VERSION,
    tweets_requested: budget.tweets_per_account || analyzedTweets.length,
    tweets_analyzed: analyzedTweets.length,
    data_quality: dataQuality || 'unknown',
    tweet_ids_hash: hashTweetIds(analyzedTweets),
    best_tweet_url: best?.tweet_url || null,
    weakest_tweet_url: weakest?.tweet_url || null,
    timing_summary: { timing_patterns: accountAnalysis.timing_patterns || [] },
    budget,
    raw_summary: { user: scanResult.user, winner_vs_loser: accountAnalysis.winner_vs_loser || {}, account_summary: accountAnalysis.account_summary || null, today_adaptation: accountAnalysis.today_adaptation || null },
    model_used: model,
    reused_cached_result: false
  }).select('*').single();
  if (runError) throw runError;

  const analysisById = new Map<string, AnyRecord>();
  for (const item of asArray(accountAnalysis.tweet_analyses)) {
    const id = String(item.tweet_id || '').trim();
    if (id) analysisById.set(id, item);
  }

  const tweetRows = analyzedTweets.map((tweet: any) => {
    const a = analysisById.get(String(tweet.tweet_id)) || {};
    return {
      scan_run_id: runRow.id,
      creator_handle: handle,
      tweet_id: tweet.tweet_id || null,
      tweet_url: tweet.tweet_url || null,
      tweet_text: tweet.text || null,
      created_at_x: tweet.created_at || null,
      hour_utc: tweet.hour_utc,
      weekday_utc: tweet.weekday_utc,
      metrics: tweet.metrics || {},
      engagement_score: tweet.engagement_score,
      engagement_per_1k_followers: tweet.engagement_per_1k_followers,
      tweet_type: textFrom(a, ['tweet_type', 'type']) || null,
      hook_formula: textFrom(a, ['hook_formula', 'hook']) || null,
      claim_type: textFrom(a, ['claim_type']) || null,
      tone: textFrom(a, ['tone']) || null,
      format_pattern: textFrom(a, ['format_pattern', 'format']) || null,
      timing_pattern: textFrom(a, ['timing_pattern']) || null,
      audience_pain: textFrom(a, ['audience_pain']) || null,
      why_replies: textFrom(a, ['why_replies', 'reply_trigger']) || null,
      why_quotes: textFrom(a, ['why_quotes', 'quote_trigger']) || null,
      why_bookmarks: textFrom(a, ['why_bookmarks', 'bookmark_trigger']) || null,
      why_views: textFrom(a, ['why_views', 'view_driver']) || null,
      adaptation_for_30piq: textFrom(a, ['adaptation_for_30piq', 'adaptation']) || null,
      originality_risk: textFrom(a, ['originality_risk', 'avoid_note']) || null,
      role_in_sample: classifyRole(tweet, best, weakest),
      analysis_payload: a
    };
  });
  if (tweetRows.length) await supabase.from('viral_tweet_analyses').insert(tweetRows);

  const patternCandidates = [
    ...asArray(accountAnalysis.publish_rules).map((p: any) => ({ type: 'publish_rule', value: p })),
    ...asArray(accountAnalysis.reply_rules).map((p: any) => ({ type: 'reply_rule', value: p })),
    ...asArray(accountAnalysis.quote_rules).map((p: any) => ({ type: 'quote_rule', value: p })),
    ...asArray(accountAnalysis.bookmark_rules).map((p: any) => ({ type: 'bookmark_rule', value: p })),
    ...asArray(accountAnalysis.timing_patterns).map((p: any) => ({ type: 'timing_rule', value: p })),
    ...asArray(accountAnalysis.avoid_rules).map((p: any) => ({ type: 'avoid_rule', value: p }))
  ];

  const patternRows = patternCandidates.map((p: any) => ({
    scan_run_id: runRow.id,
    creator_handle: handle,
    pattern_type: p.type,
    rule: textFrom(p.value, ['rule', 'pattern', 'formula']) || String(p.value || '').slice(0, 500),
    evidence: textFrom(p.value, ['evidence', 'why', 'mechanism']) || null,
    confidence_score: Number(p.value?.confidence_score || p.value?.confidence || 7),
    apply_to_30piq: textFrom(p.value, ['apply_to_30piq', 'adaptation_for_30piq', 'adaptation']) || null,
    avoid_copying_note: textFrom(p.value, ['avoid_note', 'risk']) || null,
    status: 'new'
  })).filter((p: any) => p.rule && p.rule !== '[object Object]').slice(0, 30);
  if (patternRows.length) await supabase.from('viral_account_patterns').insert(patternRows);

  return { run_id: runRow.id, tweet_rows: tweetRows.length, pattern_rows: patternRows.length };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    let body: any = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch {} }

    const maxAccounts = numParam(body.max_accounts || url.searchParams.get('max_accounts') || optionalEnv('X_SCAN_MAX_ACCOUNTS', '2'), 2, 1, 10);
    const tweetsPerAccount = numParam(body.tweets_per_account || url.searchParams.get('tweets_per_account') || optionalEnv('X_SCAN_TWEETS_PER_ACCOUNT', '8'), 8, 5, 20);
    const cacheHours = numParam(body.cache_hours || url.searchParams.get('cache_hours') || optionalEnv('X_SCAN_CACHE_HOURS', '12'), 12, 0, 168);
    const dryRun = boolParam(body.dry_run || url.searchParams.get('dry_run'));
    const force = boolParam(body.force || url.searchParams.get('force'));

    const manualHandles = body.handles || url.searchParams.getAll('handle');
    const { data: accountRows } = await supabase.from('accounts').select('*').order('tier', { ascending: true }).limit(maxAccounts);
    const dbHandles = (accountRows || []).map((a: any) => a.handle || a.username || a.account_handle).filter(Boolean);
    const handles = Array.from(new Set([...manualHandles, ...dbHandles].map(cleanHandle).filter(Boolean))).slice(0, maxAccounts);

    const budget = { max_accounts: maxAccounts, tweets_per_account: tweetsPerAccount, estimated_twitterapi_requests: force ? handles.length : `0-${handles.length}`, dry_run: dryRun, force, cache_hours: cacheHours, note: 'Cached scans are reused within cache_hours unless force=true.' };
    if (dryRun) return Response.json({ ok: true, version: VERSION, budget, handles, note: 'Dry run only.' });

    const scanResults: any[] = [];
    const cachedResults: any[] = [];
    const errors: any[] = [];

    for (const handle of handles) {
      try {
        if (!force && cacheHours > 0) {
          const cached = await readCachedScan(supabase, handle, cacheHours);
          if (cached) { cachedResults.push(cached); continue; }
        }
        const { user, tweets } = await getXUserAndTimeline(handle, tweetsPerAccount, false);
        const analyzed = tweets.map((t: any) => analyzeXTweet(t, user)).sort((a: any, b: any) => (b.engagement_per_1k_followers || 0) - (a.engagement_per_1k_followers || 0));
        scanResults.push({ creator_handle: cleanHandle(user.username || handle), user, top_tweets: analyzed.slice(0, tweetsPerAccount), best_tweet: analyzed[0] || null, weakest_tweet: analyzed[analyzed.length - 1] || null, all_tweets_count: tweets.length, tweet_ids_hash: hashTweetIds(analyzed) });
      } catch (err: any) {
        errors.push({ handle, error: err.message });
      }
    }

    if (!scanResults.length) {
      const log = await insertSessionLog({ actions_completed: ['viral_account_scan_cache_only', VERSION], decisions_made: cachedResults, pending_tasks: [], next_recommendation: 'Run daily-run using cached viral memory, or rerun scan with force=true.' });
      return Response.json({ ok: true, version: VERSION, budget, handles, cachedResults, errors, scanResults: [], intel: null, sessionLog: log });
    }

    const model = optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini');
    const prompt = `Deeply analyze X post mechanics for @${optionalEnv('X_USERNAME', '30piq')}, an English AI x Productivity x Career Growth account.
Use only the provided scanResults and errors. Do not invent evidence.
For each account: compare best_tweet vs weakest_tweet; classify every post as research_summary, opinion, demo, controversy, question, prediction, framework, tool_take, or other; extract hook_formula, claim_type, tone, format_pattern, timing_pattern, audience_pain, why_replies, why_quotes, why_bookmarks, why_views, adaptation_for_30piq, originality_risk.
Return strict JSON keys: mode, data_quality, account_analyses, cross_account_patterns, timing_rules, post_rules, reply_rules, quote_rules, bookmark_rules, today_content_brief, needs_more_data.
Each account_analyses item must include: creator_handle, account_summary, tweet_analyses, winner_vs_loser, timing_patterns, publish_rules, reply_rules, quote_rules, bookmark_rules, avoid_rules, today_adaptation.
scanResults=${JSON.stringify(scanResults)}
errors=${JSON.stringify(errors)}`;

    const completion = await client().chat.completions.create({ model, temperature: 0.08, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Return operational viral mechanics from supplied metrics only. No invented facts.' }, { role: 'user', content: prompt }] });
    const intel = normalizeDeepIntel(JSON.parse(completion.choices[0]?.message?.content || '{}'));

    const accountAnalysisByHandle = new Map<string, AnyRecord>();
    for (const a of intel.account_analyses) {
      const key = analysisHandle(a);
      if (key) accountAnalysisByHandle.set(key, a);
    }

    const persisted: any[] = [];
    for (const scanResult of scanResults) {
      const handle = cleanHandle(scanResult.creator_handle || scanResult.user?.username).toLowerCase();
      persisted.push(await persistAccountAnalysis({ supabase, handle, scanResult, accountAnalysis: accountAnalysisByHandle.get(handle) || {}, budget, model, dataQuality: intel.data_quality }));
    }

    if (intel.cross_account_patterns.length) await supabase.from('creator_intel').insert(intel.cross_account_patterns.slice(0, 10).map((p: any) => ({ creator_handle: 'account_scan', post_url: null, topic: p.pattern_type || 'deep_viral_pattern', hook_pattern: p.rule || p.pattern || null, format_pattern: p.evidence || p.mechanism || null, why_it_worked: p.evidence || p.why || null, adaptation_idea: p.apply_to_30piq || p.adaptation_for_30piq || p.adaptation || null, status: intel.data_quality || 'new', notes: p.avoid_note || null })));

    const trendRows = [
      ...intel.timing_rules.slice(0, 5).map((r: any) => ({ topic: 'timing_rule', source: 'viral-account-scan', heat_score: 8, content_type_suggestion: 'timing', notes: `${r.rule || r.timing || String(r)} Evidence: ${r.evidence || ''}` })),
      ...intel.post_rules.slice(0, 5).map((r: any) => ({ topic: 'post_rule', source: 'viral-account-scan', heat_score: 8, content_type_suggestion: 'post_rule', notes: `${r.rule || String(r)} Evidence: ${r.evidence || ''}` })),
      ...intel.bookmark_rules.slice(0, 3).map((r: any) => ({ topic: 'bookmark_rule', source: 'viral-account-scan', heat_score: 7, content_type_suggestion: 'bookmarkable_post', notes: `${r.rule || String(r)} Evidence: ${r.evidence || ''}` }))
    ];
    if (trendRows.length) await supabase.from('trends').insert(trendRows);

    // --- Normalize scan results + deep intel for learning-memory ---
    const crawlerItems: any[] = [];

    // From scanResults: each analyzed tweet's hook, format, timing, engagement mechanics
    for (const scanResult of scanResults) {
      const handle = cleanHandle(scanResult.creator_handle || scanResult.user?.username);
      for (const tweet of (scanResult.top_tweets || [])) {
        crawlerItems.push({
          title: tweet.hook_formula || tweet.format_pattern || `@${handle} viral tweet`,
          url: tweet.tweet_url || '',
          summary: [
            tweet.hook_formula ? `Hook: ${tweet.hook_formula}` : '',
            tweet.claim_type ? `Claim: ${tweet.claim_type}` : '',
            tweet.tone ? `Tone: ${tweet.tone}` : '',
            tweet.format_pattern ? `Format: ${tweet.format_pattern}` : '',
            tweet.why_replies ? `Reply trigger: ${tweet.why_replies}` : '',
            tweet.why_quotes ? `Quote trigger: ${tweet.why_quotes}` : '',
            tweet.why_bookmarks ? `Bookmark trigger: ${tweet.why_bookmarks}` : '',
            tweet.why_views ? `View driver: ${tweet.why_views}` : '',
            tweet.audience_pain ? `Pain: ${tweet.audience_pain}` : '',
            tweet.adaptation_for_30piq ? `Adapt: ${tweet.adaptation_for_30piq}` : '',
            `Engagement/1k: ${tweet.engagement_per_1k_followers || 'N/A'}`
          ].filter(Boolean).join(' | '),
          confidence_score: Math.min(10, Math.max(1, Math.round((tweet.engagement_per_1k_followers || 0) / 5))),
          source_type: 'viral_tweet',
          mechanism: tweet.hook_formula || tweet.format_pattern || ''
        });
      }
    }

    // From deep intel: account analyses with rules and patterns
    for (const account of intel.account_analyses) {
      const ah = analysisHandle(account);

      // Tweet-level deep analyses (hook, format, timing mechanics)
      for (const ta of asArray(account.tweet_analyses)) {
        crawlerItems.push({
          title: ta.hook_formula || ta.format_pattern || `@${ah} deep analysis`,
          url: ta.tweet_url || '',
          summary: [
            ta.hook_formula ? `Hook: ${ta.hook_formula}` : '',
            ta.claim_type ? `Claim: ${ta.claim_type}` : '',
            ta.tone ? `Tone: ${ta.tone}` : '',
            ta.format_pattern ? `Format: ${ta.format_pattern}` : '',
            ta.timing_pattern ? `Timing: ${ta.timing_pattern}` : '',
            ta.audience_pain ? `Pain: ${ta.audience_pain}` : '',
            ta.why_replies ? `Reply trigger: ${ta.why_replies}` : '',
            ta.why_quotes ? `Quote trigger: ${ta.why_quotes}` : '',
            ta.why_bookmarks ? `Bookmark trigger: ${ta.why_bookmarks}` : '',
            ta.adaptation_for_30piq ? `Adapt: ${ta.adaptation_for_30piq}` : '',
            ta.originality_risk ? `Risk: ${ta.originality_risk}` : ''
          ].filter(Boolean).join(' | '),
          confidence_score: 8,
          source_type: 'deep_tweet_analysis',
          mechanism: ta.hook_formula || ta.format_pattern || ta.timing_pattern || ''
        });
      }

      // Account-level rules (publish, reply, quote, bookmark, timing, avoid)
      for (const rule of [...asArray(account.publish_rules), ...asArray(account.reply_rules), ...asArray(account.quote_rules), ...asArray(account.bookmark_rules), ...asArray(account.timing_patterns), ...asArray(account.avoid_rules)]) {
        const ruleText = textFrom(rule, ['rule', 'pattern', 'formula']) || String(rule || '').slice(0, 200);
        if (!ruleText || ruleText === '[object Object]') continue;
        const ruleType = asArray(account.publish_rules).includes(rule) ? 'publish_rule' :
                         asArray(account.reply_rules).includes(rule) ? 'reply_rule' :
                         asArray(account.quote_rules).includes(rule) ? 'quote_rule' :
                         asArray(account.bookmark_rules).includes(rule) ? 'bookmark_rule' :
                         asArray(account.timing_patterns).includes(rule) ? 'timing_pattern' : 'avoid_rule';
        crawlerItems.push({
          title: `@${ah} ${ruleType}: ${ruleText.slice(0, 80)}`,
          url: '',
          summary: [
            ruleText,
            textFrom(rule, ['evidence', 'why', 'mechanism']) || '',
            textFrom(rule, ['apply_to_30piq', 'adaptation_for_30piq', 'adaptation']) ? `Adapt: ${textFrom(rule, ['apply_to_30piq', 'adaptation_for_30piq', 'adaptation'])}` : ''
          ].filter(Boolean).join(' | '),
          confidence_score: Number(rule.confidence_score || rule.confidence || 7),
          source_type: ruleType,
          mechanism: textFrom(rule, ['mechanism', 'why', 'evidence']) || ruleText
        });
      }

      // Winner vs Loser comparison
      if (account.winner_vs_loser && typeof account.winner_vs_loser === 'object') {
        const wvl = account.winner_vs_loser;
        crawlerItems.push({
          title: `@${ah} winner vs loser: ${textFrom(wvl, ['key_difference', 'insight', 'summary']).slice(0, 80)}`,
          url: '',
          summary: [
            textFrom(wvl, ['key_difference', 'insight', 'summary']),
            textFrom(wvl, ['winner_why', 'why_winner_worked']),
            textFrom(wvl, ['loser_why', 'why_loser_failed']),
            textFrom(wvl, ['adaptation', 'adaptation_for_30piq'])
          ].filter(Boolean).join(' | '),
          confidence_score: 9,
          source_type: 'winner_vs_loser',
          mechanism: textFrom(wvl, ['key_difference', 'insight']) || ''
        });
      }
    }

    // Cross-account patterns (most powerful — apply across niches)
    for (const cap of intel.cross_account_patterns) {
      crawlerItems.push({
        title: `Cross-account: ${textFrom(cap, ['pattern', 'rule', 'pattern_type']).slice(0, 80)}`,
        url: '',
        summary: [
          textFrom(cap, ['pattern', 'rule', 'pattern_type']),
          textFrom(cap, ['mechanism', 'evidence', 'why']),
          textFrom(cap, ['apply_to_30piq', 'adaptation_for_30piq', 'adaptation'])
        ].filter(Boolean).join(' | '),
        confidence_score: Number(cap.confidence_score || cap.confidence || 8),
        source_type: 'cross_account_pattern',
        mechanism: textFrom(cap, ['mechanism', 'evidence', 'why']) || textFrom(cap, ['pattern', 'rule'])
      });
    }

    // Global timing, post, reply, quote, bookmark rules
    for (const rule of [...intel.timing_rules, ...intel.post_rules, ...intel.reply_rules, ...intel.quote_rules, ...intel.bookmark_rules]) {
      const ruleText = textFrom(rule, ['rule', 'pattern', 'formula']) || String(rule || '').slice(0, 200);
      if (!ruleText || ruleText === '[object Object]') continue;
      crawlerItems.push({
        title: `Global rule: ${ruleText.slice(0, 80)}`,
        url: '',
        summary: [
          ruleText,
          textFrom(rule, ['evidence', 'why', 'mechanism']) || '',
          textFrom(rule, ['apply_to_30piq', 'adaptation']) ? `Adapt: ${textFrom(rule, ['apply_to_30piq', 'adaptation'])}` : ''
        ].filter(Boolean).join(' | '),
        confidence_score: Number(rule.confidence_score || rule.confidence || 8),
        source_type: 'global_viral_rule',
        mechanism: textFrom(rule, ['mechanism', 'why', 'evidence']) || ruleText
      });
    }

    let learningMemoryResult: any = null;
    if (crawlerItems.length > 0) {
      try {
        learningMemoryResult = await learnFromCrawlerItems(supabase, {
          runType: 'viral_account_scan',
          source: `viral_scan:${handles.join(',')}`,
          items: crawlerItems,
          mode: url.searchParams.get('mode') || 'trial'
        });
      } catch (learnErr: any) {
        errors.push({ handle: 'learning_memory', error: learnErr.message });
      }
    }

    const log = await insertSessionLog({ actions_completed: ['viral_account_scan', VERSION, 'deep_tweet_analysis_saved', 'viral_memory_tables_updated', learningMemoryResult ? `learning_memory:${learningMemoryResult.algorithmRules}algo+${learningMemoryResult.stylePatterns}style+${learningMemoryResult.mcpOpportunities}mcp` : 'learning_memory:skipped'], decisions_made: [intel.today_content_brief || {}, { persisted }], pending_tasks: [...intel.post_rules, ...intel.reply_rules, ...intel.quote_rules].slice(0, 20), next_recommendation: 'Run daily-run so final content uses fresh viral memory tables.' });
    return Response.json({ ok: true, version: VERSION, budget, handles, cachedResults, errors, scanResults, intel, persisted, learningMemory: learningMemoryResult ? { algorithmRules: learningMemoryResult.algorithmRules, stylePatterns: learningMemoryResult.stylePatterns, mcpOpportunities: learningMemoryResult.mcpOpportunities, rejectedLowQuality: learningMemoryResult.rejectedLowQuality, runId: learningMemoryResult.run?.id } : null, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
