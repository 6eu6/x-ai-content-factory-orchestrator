import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-ingest-v1';

function ai() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function repoName(input: string) {
  const raw = String(input || '').trim();
  const m = raw.match(/github\.com\/([^/]+)\/([^/#?]+)/i) || raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!m) throw new Error('Use owner/name or github repo URL');
  return { owner: m[1], repo: m[2].replace(/\.git$/, ''), full: `${m[1]}/${m[2].replace(/\.git$/, '')}` };
}

function headers() {
  const token = optionalEnv('GITHUB_TOKEN');
  return { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function gh(path: string) {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getText(url: string) {
  const res = await fetch(url);
  if (!res.ok) return '';
  return (await res.text()).slice(0, 20000);
}

function rank(path: string) {
  const p = path.toLowerCase();
  if (p === 'readme.md') return 100;
  if (p.includes('cheat') || p.includes('playbook') || p.includes('guide')) return 90;
  if (/^\d+[-_]/.test(p)) return 80;
  if (p.includes('docs/')) return 70;
  return p.endsWith('.md') ? 60 : 0;
}

function role(path: string) {
  const p = path.toLowerCase();
  if (p === 'readme.md') return 'readme';
  if (p.includes('cheat') || p.includes('playbook')) return 'playbook';
  if (p.includes('guide')) return 'guide';
  if (/^\d+[-_]/.test(p)) return 'chapter';
  return 'doc';
}

function arr(v: any) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  if (typeof v === 'object') return Object.values(v);
  return [v];
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const u = new URL(req.url);
    let body: any = {};
    if (req.method === 'POST') { try { body = await req.json(); } catch {} }
    const input = body.repo || u.searchParams.get('repo');
    if (!input) throw new Error('Missing repo');
    const r = repoName(input);
    const meta = await gh(`/repos/${r.owner}/${r.repo}`);
    const tree = await gh(`/repos/${r.owner}/${r.repo}/git/trees/${meta.default_branch}?recursive=1`);
    const files = (tree.tree || []).filter((x: any) => x.type === 'blob' && String(x.path).toLowerCase().endsWith('.md')).sort((a: any, b: any) => rank(b.path) - rank(a.path)).slice(0, 14);

    const { data: repoRow, error: repoErr } = await supabase.from('repo_sources').upsert({
      repo_url: meta.html_url,
      github_full_name: r.full,
      source_type: 'github_repo',
      discovery_source: body.discovery_source || u.searchParams.get('discovery_source') || 'manual',
      topic_cluster: body.topic_cluster || u.searchParams.get('topic_cluster') || 'repo_intelligence',
      description: meta.description || null,
      stars: meta.stargazers_count || 0,
      forks: meta.forks_count || 0,
      language: meta.language || null,
      license: meta.license?.spdx_id || null,
      last_pushed_at: meta.pushed_at || null,
      last_ingested_at: new Date().toISOString(),
      priority_score: Math.min(10, Math.max(5, Math.round(Math.log10((meta.stargazers_count || 1) + 1) + 5))),
      raw_payload: meta,
      status: 'ingested',
      updated_at: new Date().toISOString()
    }, { onConflict: 'repo_url' }).select('*').single();
    if (repoErr) throw repoErr;

    const docs: any[] = [];
    for (const f of files) {
      const c = await gh(`/repos/${r.owner}/${r.repo}/contents/${encodeURIComponent(f.path)}?ref=${meta.default_branch}`);
      const text = c.download_url ? await getText(c.download_url) : '';
      docs.push({ path: f.path, role: role(f.path), sha: f.sha, excerpt: text.slice(0, 5000) });
      await supabase.from('repo_source_files').upsert({ repo_source_id: repoRow.id, path: f.path, file_type: 'markdown', content_sha: f.sha, content_excerpt: text.slice(0, 5000), file_role: role(f.path), analysis_status: 'loaded', updated_at: new Date().toISOString() }, { onConflict: 'repo_source_id,path' });
    }

    const prompt = `Analyze this GitHub repository for technical learning and content planning. Do not copy text. Create original content opportunities and maintainable repo ideas.
Return JSON only with: repo_summary, scores, rules, content_opportunities, repo_creation_decisions.
Each rule: rule_type, rule, evidence, source_paths, apply_to_30piq, content_use_case, confidence_score.
Each opportunity: opportunity_type, topic, angle, audience_pain, source_urls, evidence_notes, originality_notes, risk_notes, confidence_score, priority_score.
Each repo decision: repo_type, proposed_name, repo_goal, why_this_must_be_repo, documentation_plan, test_plan, maintenance_plan, localization_plan, decision_confidence.
Repo URL: ${meta.html_url}
Repo meta: ${JSON.stringify({ full: r.full, stars: meta.stargazers_count, language: meta.language, description: meta.description })}
Docs: ${JSON.stringify(docs)}`;

    const out = await ai().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.06,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Analyze repos for learning, content opportunities, testing plans, and maintenance plans. JSON only.' }, { role: 'user', content: prompt }]
    });
    const intel = JSON.parse(out.choices[0]?.message?.content || '{}');
    const scores = intel.scores || {};
    await supabase.from('repo_sources').update({ technical_depth_score: Number(scores.technical_depth_score || 5), content_potential_score: Number(scores.content_potential_score || 5), repo_creation_potential_score: Number(scores.repo_creation_potential_score || 5), status: 'analyzed', updated_at: new Date().toISOString() }).eq('id', repoRow.id);

    const rules = arr(intel.rules).slice(0, 40);
    if (rules.length) await supabase.from('repo_extracted_rules').insert(rules.map((x: any) => ({ repo_source_id: repoRow.id, rule_type: x.rule_type || 'repo_learning', rule: x.rule || 'repo rule', evidence: x.evidence || null, source_paths: arr(x.source_paths), apply_to_30piq: x.apply_to_30piq || null, content_use_case: x.content_use_case || null, confidence_score: Number(x.confidence_score || 5), status: 'active' })));

    const opportunities = arr(intel.content_opportunities).slice(0, 12);
    if (opportunities.length) await supabase.from('content_opportunities').insert(opportunities.map((x: any) => ({ opportunity_type: x.opportunity_type || 'thread', topic: x.topic || r.full, angle: x.angle || null, audience_pain: x.audience_pain || null, source_urls: arr(x.source_urls).length ? arr(x.source_urls) : [meta.html_url], evidence_notes: x.evidence_notes || null, originality_notes: x.originality_notes || null, risk_notes: x.risk_notes || null, confidence_score: Number(x.confidence_score || 6), priority_score: Number(x.priority_score || 6), status: 'candidate' })));

    const decisions = arr(intel.repo_creation_decisions).slice(0, 5);
    if (decisions.length) await supabase.from('repo_creation_decisions').insert(decisions.map((x: any) => ({ repo_source_id: repoRow.id, decision: 'create_repo', decision_confidence: Number(x.decision_confidence || 10), repo_type: x.repo_type || 'guide', proposed_name: x.proposed_name || `${r.repo}-notes`, repo_goal: x.repo_goal || `Create a useful original repo inspired by ${r.full}`, why_this_must_be_repo: x.why_this_must_be_repo || 'The topic benefits from structured, maintained documentation or tooling.', documentation_plan: x.documentation_plan || {}, test_plan: x.test_plan || {}, maintenance_plan: x.maintenance_plan || {}, localization_plan: x.localization_plan || {}, status: 'approved_for_build' })));

    const log = await insertSessionLog({ actions_completed: ['repo_ingest', VERSION, r.full, `files:${docs.length}`, `rules:${rules.length}`, `opportunities:${opportunities.length}`, `repo_decisions:${decisions.length}`], decisions_made: [intel.repo_summary || {}, { scores }], pending_tasks: decisions.map((x: any) => `Build repo: ${x.proposed_name}`), next_recommendation: 'Run format-decision for opportunities or build approved repo decisions.' });
    return Response.json({ ok: true, version: VERSION, repo: repoRow, files_loaded: docs.length, inserted: { rules: rules.length, opportunities: opportunities.length, repo_creation_decisions: decisions.length }, intel, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
