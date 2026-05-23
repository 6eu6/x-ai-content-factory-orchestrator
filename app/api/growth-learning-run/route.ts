import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'growth-learning-run-v1';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function score(value: any, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const scaled = n > 0 && n <= 1 ? n * 10 : n;
  return Math.min(10, Math.max(1, Math.round(scaled)));
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const mode = url.searchParams.get('mode') || 'trial';

    const [repoRules, repoSources, viralTweets, viralPatterns, styleTemplates, learningRules, mcpMap, productionCards, ownedRepos] = await Promise.all([
      supabase.from('repo_extracted_rules').select('*').order('confidence_score', { ascending: false }).limit(80),
      supabase.from('repo_sources').select('*').order('content_potential_score', { ascending: false }).limit(20),
      supabase.from('viral_tweet_analyses').select('*').order('engagement_per_1k_followers', { ascending: false }).limit(50),
      supabase.from('viral_account_patterns').select('*').order('confidence_score', { ascending: false }).limit(50),
      supabase.from('repo_style_templates').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(30),
      supabase.from('system_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(50),
      supabase.from('mcp_opportunity_map').select('*').eq('status', 'active').order('priority_score', { ascending: false }).limit(30),
      supabase.from('content_production_cards').select('*').order('created_at', { ascending: false }).limit(40),
      supabase.from('owned_repo_projects').select('*').order('created_at', { ascending: false }).limit(20)
    ]);

    const prompt = `You are the Growth Learning Engine for @${optionalEnv('X_USERNAME', '30piq')}.
Goal: help grow an English X account from 0 to 10k-20k+ followers in AI x Productivity x Career Growth.
This is trial mode unless explicitly production. Do not propose spam. We need original, useful, technically credible content.
Use evidence from:
- X algorithm/recommendation repo rules
- Viral tweet/account scans
- Repo style templates
- MCP opportunity map
- Owned repo/project proof assets
Return strict JSON:
{
  "summary":"...",
  "x_algorithm_rules":[{"rule_type":"ranking|engagement|format|timing|reply|quote|bookmark","rule":"...","evidence":"...","source_type":"repo|x_scan|inference","source_url":"...","applies_to":"...","confidence_score":1}],
  "viral_style_patterns":[{"pattern_type":"hook|structure|claim|reply_trigger|quote_trigger|bookmark_trigger","pattern_name":"...","pattern_description":"...","example_structure":{},"why_it_works":"...","risks":"...","adaptation_for_30piq":"...","source_handles":["..."],"source_tweet_urls":["..."],"confidence_score":1}],
  "timeline_scan_targets":[{"target_kind":"account|topic|search","handle":"...","query":"...","reason":"...","priority":1,"scan_cadence_hours":24}],
  "mcp_opportunities":[{"opportunity_area":"...","mcp_use_case":"...","audience_segment":"...","pain_point":"...","content_angles":["..."],"repo_or_tool_ideas":["..."],"monetization_notes":"...","proof_required":["..."],"priority_score":1,"confidence_score":1}],
  "growth_experiments":[{"experiment_name":"...","hypothesis":"...","target_metric":"...","content_format":"...","source_basis":"...","execution_plan":{},"success_threshold":{},"priority_score":1}],
  "next_build_priorities":["..."]
}
RepoRules=${JSON.stringify(repoRules.data || [])}
RepoSources=${JSON.stringify(repoSources.data || [])}
ViralTweets=${JSON.stringify(viralTweets.data || [])}
ViralPatterns=${JSON.stringify(viralPatterns.data || [])}
RepoStyleTemplates=${JSON.stringify(styleTemplates.data || [])}
SystemLearningRules=${JSON.stringify(learningRules.data || [])}
McpMap=${JSON.stringify(mcpMap.data || [])}
RecentProductionCards=${JSON.stringify(productionCards.data || [])}
OwnedRepos=${JSON.stringify(ownedRepos.data || [])}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.05,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Create operational growth learning memory and experiments. JSON only.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = parseModelJson(completion.choices[0]?.message?.content || '');
    const { data: runRow, error: runError } = await supabase.from('growth_learning_runs').insert({
      run_type: 'growth_learning',
      mode,
      summary: raw.summary || null,
      evidence: raw,
      status: 'completed',
      test_run: mode !== 'production',
      updated_at: new Date().toISOString()
    }).select('*').single();
    if (runError) throw runError;

    let algorithmRules = 0;
    for (const item of asArray(raw.x_algorithm_rules).slice(0, 50)) {
      if (!item.rule) continue;
      const { error } = await supabase.from('x_algorithm_learning_rules').upsert({
        rule_type: item.rule_type || 'general',
        rule: item.rule,
        evidence: item.evidence || null,
        source_type: item.source_type || null,
        source_url: item.source_url || null,
        applies_to: item.applies_to || null,
        confidence_score: score(item.confidence_score, 7),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      }, { onConflict: 'rule_type,rule' });
      if (!error) algorithmRules++;
    }

    let stylePatterns = 0;
    for (const item of asArray(raw.viral_style_patterns).slice(0, 50)) {
      if (!item.pattern_name || !item.pattern_description) continue;
      const { error } = await supabase.from('viral_style_patterns').upsert({
        pattern_type: item.pattern_type || 'structure',
        pattern_name: item.pattern_name,
        pattern_description: item.pattern_description,
        example_structure: item.example_structure || {},
        why_it_works: item.why_it_works || null,
        risks: item.risks || null,
        adaptation_for_30piq: item.adaptation_for_30piq || null,
        source_handles: asArray(item.source_handles),
        source_tweet_urls: asArray(item.source_tweet_urls),
        confidence_score: score(item.confidence_score, 7),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      }, { onConflict: 'pattern_type,pattern_name' });
      if (!error) stylePatterns++;
    }

    let scanTargets = 0;
    for (const item of asArray(raw.timeline_scan_targets).slice(0, 30)) {
      const { error } = await supabase.from('x_timeline_scan_targets').upsert({
        target_kind: item.target_kind || 'topic',
        handle: item.handle || null,
        query: item.query || null,
        reason: item.reason || null,
        priority: score(item.priority, 6),
        scan_cadence_hours: Math.min(168, Math.max(6, Number(item.scan_cadence_hours || 24))),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      }, { onConflict: 'target_kind,handle,query' });
      if (!error) scanTargets++;
    }

    let mcpOpportunities = 0;
    for (const item of asArray(raw.mcp_opportunities).slice(0, 30)) {
      if (!item.opportunity_area || !item.mcp_use_case) continue;
      const { error } = await supabase.from('mcp_opportunity_map').upsert({
        opportunity_area: item.opportunity_area,
        mcp_use_case: item.mcp_use_case,
        audience_segment: item.audience_segment || null,
        pain_point: item.pain_point || null,
        content_angles: asArray(item.content_angles),
        repo_or_tool_ideas: asArray(item.repo_or_tool_ideas),
        monetization_notes: item.monetization_notes || null,
        proof_required: asArray(item.proof_required),
        priority_score: score(item.priority_score, 7),
        confidence_score: score(item.confidence_score, 7),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      }, { onConflict: 'opportunity_area,mcp_use_case' });
      if (!error) mcpOpportunities++;
    }

    let experiments = 0;
    for (const item of asArray(raw.growth_experiments).slice(0, 30)) {
      if (!item.experiment_name || !item.hypothesis) continue;
      const { error } = await supabase.from('growth_experiment_backlog').upsert({
        experiment_name: item.experiment_name,
        hypothesis: item.hypothesis,
        target_metric: item.target_metric || null,
        content_format: item.content_format || null,
        source_basis: item.source_basis || null,
        execution_plan: item.execution_plan || {},
        success_threshold: item.success_threshold || {},
        status: 'candidate',
        priority_score: score(item.priority_score, 7),
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      }, { onConflict: 'experiment_name' });
      if (!error) experiments++;
    }

    const log = await insertSessionLog({
      actions_completed: ['growth_learning_run', VERSION, `algorithm_rules:${algorithmRules}`, `style_patterns:${stylePatterns}`, `scan_targets:${scanTargets}`, `mcp:${mcpOpportunities}`, `experiments:${experiments}`],
      decisions_made: [raw.summary || {}, { run_id: runRow.id }],
      pending_tasks: asArray(raw.next_build_priorities).slice(0, 12),
      next_recommendation: 'Use growth learning memory inside daily-run and launch-content repair before production mode.'
    });

    return Response.json({ ok: true, version: VERSION, run_id: runRow.id, summary: raw.summary || null, inserted: { algorithm_rules: algorithmRules, style_patterns: stylePatterns, timeline_scan_targets: scanTargets, mcp_opportunities: mcpOpportunities, growth_experiments: experiments }, raw, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
