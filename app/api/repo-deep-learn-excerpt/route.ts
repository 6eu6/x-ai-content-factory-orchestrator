import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-deep-learn-excerpt-v1';
const DEFAULT_REPO = 'codebreaker77/X-Algo-Breakdown';

function client() { const baseURL = optionalEnv('OPENAI_BASE_URL'); return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined }); }
function clean(v: any, max = 1200) { return String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function arr(v: any) { if (Array.isArray(v)) return v; if (!v) return []; if (typeof v === 'object') return Object.values(v); return [v]; }
function sc(v: any, f = 7) { const n = Number(v); if (!Number.isFinite(n)) return f; return Math.min(10, Math.max(1, Math.round(n > 0 && n <= 1 ? n * 10 : n))); }

async function insertIfMissing(supabase: any, table: string, where: Record<string, any>, payload: Record<string, any>) {
  let q = supabase.from(table).select('id').limit(1);
  for (const [k, v] of Object.entries(where)) q = v == null ? q.is(k, null) : q.eq(k, v);
  const existing = await q.maybeSingle();
  if (existing.data?.id) return false;
  const inserted = await supabase.from(table).insert(payload).select('id').single();
  if (inserted.error) throw inserted.error;
  return true;
}

async function analyze(input: { repo: string; path: string; text: string }) {
  const prompt = `Deep learn this repository file for @30piq. Extract only useful reusable knowledge. If the file does not teach anything useful, set useful=false. Do not summarize shallowly. Do not copy. Return JSON only with: useful, file_summary, technical_points, content_angles, repo_style_lessons, x_algorithm_rules, style_patterns. Each x_algorithm_rule has rule_type, rule, evidence, applies_to, confidence_score. Each repo_style_lesson has lesson_name, lesson, applies_to. Each style_pattern has pattern_type, pattern_name, pattern_description, why_it_works, risks, adaptation_for_30piq, confidence_score. Repo=${input.repo}. Path=${input.path}. Content=${input.text.slice(0, 12000)}`;
  const out = await client().chat.completions.create({ model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'), temperature: 0.02, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'Deep repo learning. JSON only. Extract rules, mechanisms, templates, and useful facts.' }, { role: 'user', content: prompt }] });
  return JSON.parse(out.choices[0]?.message?.content || '{}');
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
    const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') || 4)));
    const force = url.searchParams.get('force') === '1';

    const source = await supabase.from('repo_sources').select('*').eq('github_full_name', repo).maybeSingle();
    if (source.error) throw source.error;
    if (!source.data) throw new Error(`repo source not found: ${repo}`);

    const filesRes = await supabase.from('repo_source_files').select('*').eq('repo_source_id', source.data.id).order('path', { ascending: true });
    if (filesRes.error) throw filesRes.error;
    const files = (filesRes.data || []).filter((f: any) => force || f.analysis_status !== 'deep_learned').filter((f: any) => clean(f.content_excerpt, 100).length >= 80).slice(0, limit);

    let filesLearned = 0, filesSkipped = 0, algorithmRules = 0, stylePatterns = 0, repoRules = 0;
    const learned: any[] = [];

    for (const file of files) {
      const text = clean(file.content_excerpt, 16000);
      const result = await analyze({ repo, path: file.path, text });
      const useful = result.useful !== false;
      await supabase.from('repo_source_files').update({
        analysis_status: useful ? 'deep_learned' : 'not_useful',
        extracted_summary: clean(result.file_summary || result.usefulness_reason, 1600),
        extracted_technical_points: arr(result.technical_points).map((x) => clean(x, 600)).slice(0, 20),
        extracted_content_angles: arr(result.content_angles).map((x) => clean(x, 600)).slice(0, 20),
        updated_at: new Date().toISOString()
      }).eq('id', file.id);
      if (!useful) { filesSkipped++; continue; }
      filesLearned++;
      const sourceUrl = `https://github.com/${repo}/blob/main/${file.path}`;

      for (const item of arr(result.x_algorithm_rules).slice(0, 10)) {
        const ruleType = clean(item.rule_type || 'general', 120); const rule = clean(item.rule, 1200); if (!rule || rule.length < 30) continue;
        if (await insertIfMissing(supabase, 'x_algorithm_learning_rules', { rule_type: ruleType, rule }, { rule_type: ruleType, rule, evidence: clean(item.evidence || result.file_summary, 1500), source_type: 'repo_deep_learn_excerpt', source_url: sourceUrl, applies_to: clean(item.applies_to || 'growth_daily_plan,content_score', 300), confidence_score: sc(item.confidence_score, 7), status: 'active', test_run: mode !== 'production', updated_at: new Date().toISOString() })) algorithmRules++;
      }
      for (const item of arr(result.style_patterns).slice(0, 8)) {
        const patternType = clean(item.pattern_type || 'structure', 120); const patternName = clean(item.pattern_name, 180); const desc = clean(item.pattern_description, 1200); if (!patternName || !desc || /github|http|\.com|\//i.test(patternName)) continue;
        if (await insertIfMissing(supabase, 'viral_style_patterns', { pattern_type: patternType, pattern_name: patternName }, { pattern_type: patternType, pattern_name: patternName, pattern_description: desc, example_structure: { repo, path: file.path, source_url: sourceUrl, text_source: 'stored_excerpt' }, why_it_works: clean(item.why_it_works, 1000), risks: clean(item.risks, 1000), adaptation_for_30piq: clean(item.adaptation_for_30piq, 1000), source_handles: [], source_tweet_urls: [], confidence_score: sc(item.confidence_score, 7), status: 'active', test_run: mode !== 'production', updated_at: new Date().toISOString() })) stylePatterns++;
      }
      for (const item of arr(result.repo_style_lessons).slice(0, 8)) {
        const lesson = clean(item.lesson, 1200); if (!lesson || lesson.length < 30) continue;
        if (await insertIfMissing(supabase, 'repo_extracted_rules', { repo_source_id: source.data.id, rule: lesson }, { repo_source_id: source.data.id, rule_type: clean(item.lesson_name || 'repo_style_lesson', 120), rule: lesson, evidence: clean(result.file_summary, 1000), source_paths: [file.path], apply_to_30piq: clean(item.applies_to || 'repo_writer,content_strategy', 500), content_use_case: 'Deep repo learning from stored excerpt.', confidence_score: 8, status: 'active', test_run: mode !== 'production' })) repoRules++;
      }
      learned.push({ path: file.path, useful, textSource: 'stored_excerpt', technical_points: arr(result.technical_points).length, content_angles: arr(result.content_angles).length });
    }

    await supabase.from('repo_sources').update({ status: filesLearned ? 'deep_learned' : source.data.status, updated_at: new Date().toISOString(), last_ingested_at: new Date().toISOString() }).eq('id', source.data.id);
    const summary = `Repo excerpt deep learned ${repo}: ${filesLearned} files learned, ${filesSkipped} skipped, ${algorithmRules} algorithm rules, ${stylePatterns} style patterns, ${repoRules} repo lessons.`;
    const runRow = await supabase.from('growth_learning_runs').insert({ run_type: 'repo_deep_learn_excerpt', mode, summary, evidence: { repo, repo_source_id: source.data.id, learned, counts: { filesLearned, filesSkipped, algorithmRules, stylePatterns, repoRules }, version: VERSION }, status: 'completed', test_run: mode !== 'production', updated_at: new Date().toISOString() }).select('*').single();
    if (runRow.error) throw runRow.error;
    const log = await insertSessionLog({ actions_completed: ['repo_deep_learn_excerpt', VERSION, `files:${filesLearned}`, `algorithm_rules:${algorithmRules}`, `style_patterns:${stylePatterns}`, `repo_rules:${repoRules}`], decisions_made: [{ repo, run_id: runRow.data.id }], pending_tasks: ['Run memory-maintenance-run after repo deep learning.'], next_recommendation: 'Continue until all useful files are deep_learned.' });
    return Response.json({ ok: true, version: VERSION, repo, run_id: runRow.data.id, summary, counts: { filesLearned, filesSkipped, algorithmRules, stylePatterns, repoRules }, learned, sessionLog: log });
  } catch (err: any) { return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 }); }
}
