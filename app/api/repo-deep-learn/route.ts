import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { callModel, parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-deep-learn-v1';
const DEFAULT_REPO = 'codebreaker77/X-Algo-Breakdown';

function clean(value: any, max = 1200) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function arr(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function score(value: any, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, Math.round(n > 0 && n <= 1 ? n * 10 : n)));
}

function ghHeaders() {
  const token = optionalEnv('GITHUB_TOKEN');
  return {
    accept: 'application/vnd.github+json',
    'user-agent': 'x-ai-content-factory-orchestrator',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
}

async function getDefaultBranch(repo: string): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: ghHeaders(),
      cache: 'no-store'
    });
    if (!res.ok) return 'main';
    const json = await res.json();
    return json.default_branch || 'main';
  } catch {
    return 'main';
  }
}

function rawUrl(repo: string, branch: string, path: string) {
  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

async function fetchRaw(repo: string, branch: string, path: string): Promise<{ text: string; branch: string }> {
  const candidates = Array.from(new Set([branch, 'main', 'master']));
  let lastStatus = '';
  for (const candidate of candidates) {
    const res = await fetch(rawUrl(repo, candidate, path), {
      headers: { 'user-agent': 'x-ai-content-factory-orchestrator' },
      cache: 'no-store'
    });
    if (res.ok) {
      return { text: await res.text(), branch: candidate };
    }
    lastStatus = `${res.status} on ${candidate}`;
  }
  throw new Error(`fetch failed ${lastStatus} for ${path}`);
}

async function insertIfMissing(supabase: any, table: string, where: Record<string, any>, payload: Record<string, any>) {
  let q = supabase.from(table).select('id').limit(1);
  for (const [k, v] of Object.entries(where)) q = v == null ? q.is(k, null) : q.eq(k, v);
  const existing = await q.maybeSingle();
  if (existing.data?.id) return false;
  const inserted = await supabase.from(table).insert(payload).select('id').single();
  if (inserted.error) throw inserted.error;
  return true;
}

async function analyzeFile(input: { repo: string; path: string; text: string }) {
  const prompt = `You are the deep repo learning engine for @30piq.
The account goal is English AI x Productivity x Career Growth, using real crawls and repo evidence.
Deep learning means: extract reusable knowledge, not shallow summaries.
For this file, identify:
1. factual/technical knowledge useful for X growth, repo building, or content strategy,
2. style or template lessons from how the repo is structured/written,
3. rules that can guide planning/scoring/content decisions,
4. whether the file is truly useful or should be ignored.
Do not copy text. Do not invent beyond this file.
Return JSON only:
{
 "useful": true,
 "usefulness_reason":"...",
 "file_summary":"...",
 "technical_points":["..."],
 "content_angles":["..."],
 "repo_style_lessons":[{"lesson_name":"...","lesson":"...","applies_to":"repo_writer|readme|playbook|docs|content"}],
 "x_algorithm_rules":[{"rule_type":"ranking|candidate_pipeline|home_mixer|reply|bookmark|network_reach|safety|quality|human_originality|format","rule":"...","evidence":"...","applies_to":"daily_run|growth_daily_plan|content_score|reply_strategy|quote_strategy|repo_build","confidence_score":1}],
 "style_patterns":[{"pattern_type":"hook|structure|bookmark_trigger|reply_trigger|quality_filter|safety_filter|anti_ai_voice","pattern_name":"...","pattern_description":"...","why_it_works":"...","risks":"...","adaptation_for_30piq":"...","confidence_score":1}]
}
Repo=${input.repo}
Path=${input.path}
Content=${input.text.slice(0, 16000)}`;
  const modelResponse = await callModel('deep_analysis', [
    { role: 'system', content: 'Extract deep reusable repo learning. JSON only. No shallow source-title memories.' },
    { role: 'user', content: prompt }
  ], { temperature: 0.02 });
  return parseModelJson(modelResponse);
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const repo = url.searchParams.get('repo') || DEFAULT_REPO;
    const mode = url.searchParams.get('mode') || 'trial';
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') || 6)));
    const force = url.searchParams.get('force') === '1';

    const source = await supabase.from('repo_sources').select('*').eq('github_full_name', repo).maybeSingle();
    if (source.error) throw source.error;
    if (!source.data) throw new Error(`repo source not found: ${repo}`);

    const defaultBranch = url.searchParams.get('branch') || await getDefaultBranch(repo);

    const filesRes = await supabase.from('repo_source_files').select('*').eq('repo_source_id', source.data.id).order('path', { ascending: true });
    if (filesRes.error) throw filesRes.error;
    const files = (filesRes.data || []).filter((f: any) => force || f.analysis_status !== 'deep_learned').slice(0, limit);

    let filesLearned = 0;
    let filesSkipped = 0;
    let algorithmRules = 0;
    let stylePatterns = 0;
    let repoRules = 0;
    const learned: any[] = [];
    let usedBranch = defaultBranch;

    for (const file of files) {
      let text = '';
      let fetchedBranch = defaultBranch;
      try {
        const fetched = await fetchRaw(repo, defaultBranch, file.path);
        text = fetched.text;
        fetchedBranch = fetched.branch;
        usedBranch = fetchedBranch;
      } catch (e: any) {
        await supabase.from('repo_source_files').update({ analysis_status: 'fetch_failed', extracted_summary: clean(e.message, 500), updated_at: new Date().toISOString() }).eq('id', file.id);
        filesSkipped++;
        continue;
      }

      const result = await analyzeFile({ repo, path: file.path, text });
      const useful = result.useful !== false;
      await supabase.from('repo_source_files').update({
        content_excerpt: text.slice(0, 8000),
        analysis_status: useful ? 'deep_learned' : 'not_useful',
        extracted_summary: clean(result.file_summary || result.usefulness_reason, 1600),
        extracted_technical_points: arr(result.technical_points).map((x) => clean(x, 600)).slice(0, 20),
        extracted_content_angles: arr(result.content_angles).map((x) => clean(x, 600)).slice(0, 20),
        updated_at: new Date().toISOString()
      }).eq('id', file.id);

      if (!useful) { filesSkipped++; continue; }
      filesLearned++;
      const sourceUrl = `https://github.com/${repo}/blob/${fetchedBranch}/${file.path}`;

      for (const item of arr(result.x_algorithm_rules).slice(0, 10)) {
        const ruleType = clean(item.rule_type || 'general', 120);
        const rule = clean(item.rule, 1200);
        if (!rule || rule.length < 30) continue;
        const ok = await insertIfMissing(supabase, 'x_algorithm_learning_rules', { rule_type: ruleType, rule }, {
          rule_type: ruleType,
          rule,
          evidence: clean(item.evidence || result.file_summary, 1500),
          source_type: 'repo_deep_learn',
          source_url: sourceUrl,
          applies_to: clean(item.applies_to || 'growth_daily_plan,content_score', 300),
          confidence_score: score(item.confidence_score, 7),
          status: 'active',
          test_run: mode !== 'production',
          updated_at: new Date().toISOString()
        });
        if (ok) algorithmRules++;
      }

      for (const item of arr(result.style_patterns).slice(0, 8)) {
        const patternType = clean(item.pattern_type || 'structure', 120);
        const patternName = clean(item.pattern_name, 180);
        const desc = clean(item.pattern_description, 1200);
        if (!patternName || !desc || /github|http|\.com|\//i.test(patternName)) continue;
        const ok = await insertIfMissing(supabase, 'viral_style_patterns', { pattern_type: patternType, pattern_name: patternName }, {
          pattern_type: patternType,
          pattern_name: patternName,
          pattern_description: desc,
          example_structure: { repo, path: file.path, source_url: sourceUrl },
          why_it_works: clean(item.why_it_works, 1000),
          risks: clean(item.risks, 1000),
          adaptation_for_30piq: clean(item.adaptation_for_30piq, 1000),
          source_handles: [],
          source_tweet_urls: [],
          confidence_score: score(item.confidence_score, 7),
          status: 'active',
          test_run: mode !== 'production',
          updated_at: new Date().toISOString()
        });
        if (ok) stylePatterns++;
      }

      for (const item of arr(result.repo_style_lessons).slice(0, 8)) {
        const lesson = clean(item.lesson, 1200);
        if (!lesson || lesson.length < 30) continue;
        const ok = await insertIfMissing(supabase, 'repo_extracted_rules', { repo_source_id: source.data.id, rule: lesson }, {
          repo_source_id: source.data.id,
          rule_type: clean(item.lesson_name || 'repo_style_lesson', 120),
          rule: lesson,
          evidence: clean(result.file_summary, 1000),
          source_paths: [file.path],
          apply_to_30piq: clean(item.applies_to || 'repo_writer,content_strategy', 500),
          content_use_case: 'Deep repo learning for future proof assets and content strategy.',
          confidence_score: 8,
          status: 'active',
          test_run: mode !== 'production'
        });
        if (ok) repoRules++;
      }

      learned.push({ path: file.path, useful, technical_points: arr(result.technical_points).length, content_angles: arr(result.content_angles).length });
    }

    await supabase.from('repo_sources').update({ status: filesLearned ? 'deep_learned' : source.data.status, updated_at: new Date().toISOString(), last_ingested_at: new Date().toISOString() }).eq('id', source.data.id);

    const summary = `Repo deep learned ${repo}: ${filesLearned} files learned, ${filesSkipped} skipped, ${algorithmRules} algorithm rules, ${stylePatterns} style patterns, ${repoRules} repo lessons.`;
    const runRow = await supabase.from('growth_learning_runs').insert({
      run_type: 'repo_deep_learn',
      mode,
      summary,
      evidence: { repo, default_branch: usedBranch, repo_source_id: source.data.id, learned, counts: { filesLearned, filesSkipped, algorithmRules, stylePatterns, repoRules } },
      status: 'completed',
      test_run: mode !== 'production',
      updated_at: new Date().toISOString()
    }).select('*').single();
    if (runRow.error) throw runRow.error;

    const log = await insertSessionLog({
      actions_completed: ['repo_deep_learn', VERSION, `files:${filesLearned}`, `algorithm_rules:${algorithmRules}`, `style_patterns:${stylePatterns}`, `repo_rules:${repoRules}`],
      decisions_made: [{ repo, run_id: runRow.data.id }],
      pending_tasks: ['Run memory-maintenance-run after repo deep learning.', 'Use X-Algo deep rules in content scoring and growth planning.'],
      next_recommendation: 'Continue repo-deep-learn until all useful files are deep_learned.'
    });

    return Response.json({ ok: true, version: VERSION, repo, default_branch: usedBranch, run_id: runRow.data.id, summary, counts: { filesLearned, filesSkipped, algorithmRules, stylePatterns, repoRules }, learned, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
