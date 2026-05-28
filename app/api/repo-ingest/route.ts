import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { callModel, parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-ingest-v1.1-persisted';

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

function score(v: any, fallback = 7) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const scaled = n > 0 && n <= 1 ? n * 10 : n;
  return Math.min(10, Math.max(1, Math.round(scaled)));
}

function sourceUrls(value: any, repoUrl: string) {
  const urls = arr(value).map((x) => String(x || '').trim()).filter(Boolean);
  const normalized = urls.map((x) => x.startsWith('http') ? x : repoUrl).filter(Boolean);
  return Array.from(new Set(normalized.length ? normalized : [repoUrl]));
}

function scoreFromObject(scores: any, keys: string[], fallback = 7) {
  for (const key of keys) {
    if (scores && scores[key] !== undefined) return score(scores[key], fallback);
  }
  return fallback;
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
      const { error } = await supabase.from('repo_source_files').upsert({ repo_source_id: repoRow.id, path: f.path, file_type: 'markdown', content_sha: f.sha, content_excerpt: text.slice(0, 5000), file_role: role(f.path), analysis_status: 'loaded', updated_at: new Date().toISOString() }, { onConflict: 'repo_source_id,path' });
      if (error) throw error;
    }

    const prompt = `Analyze this GitHub repository for technical learning and content planning. Do not copy text. Create original content opportunities and maintainable repo ideas.
Return JSON only with: repo_summary, scores, rules, content_opportunities, repo_creation_decisions.
Scores must be integers 1-10. Confidence values must be integers 1-10.
Each rule: rule_type, rule, evidence, source_paths, apply_to_30piq, content_use_case, confidence_score.
Each opportunity: opportunity_type, topic, angle, audience_pain, source_urls, evidence_notes, originality_notes, risk_notes, confidence_score, priority_score.
Each repo decision: repo_type, proposed_name, repo_goal, why_this_must_be_repo, documentation_plan, test_plan, maintenance_plan, localization_plan, decision_confidence.
Repo URL: ${meta.html_url}
Repo meta: ${JSON.stringify({ full: r.full, stars: meta.stargazers_count, language: meta.language, description: meta.description })}
Docs: ${JSON.stringify(docs)}`;

    const modelResponse = await callModel('deep_analysis', [
      { role: 'system', content: 'Analyze repos for learning, content opportunities, testing plans, and maintenance plans. JSON only.' },
      { role: 'user', content: prompt }
    ], { temperature: 0.06 });
    const intel = parseModelJson(modelResponse);
    const scores = intel.scores || {};
    await supabase.from('repo_sources').update({
      technical_depth_score: scoreFromObject(scores, ['technical_depth_score', 'content_depth', 'learning_potential'], 7),
      content_potential_score: scoreFromObject(scores, ['content_potential_score', 'content_opportunity', 'documentation_quality'], 7),
      repo_creation_potential_score: scoreFromObject(scores, ['repo_creation_potential_score', 'test_coverage_potential', 'code_modularity'], 7),
      status: 'analyzed',
      updated_at: new Date().toISOString()
    }).eq('id', repoRow.id);

    const rules = arr(intel.rules).slice(0, 40);
    let rulesInserted = 0;
    if (rules.length) {
      const { data, error } = await supabase.from('repo_extracted_rules').insert(rules.map((x: any) => ({
        repo_source_id: repoRow.id,
        rule_type: String(x.rule_type || 'repo_learning').slice(0, 120),
        rule: x.rule || 'repo rule',
        evidence: x.evidence || null,
        source_paths: arr(x.source_paths),
        apply_to_30piq: typeof x.apply_to_30piq === 'string' ? x.apply_to_30piq : x.apply_to_30piq ? 'Applicable to 30piq.' : null,
        content_use_case: x.content_use_case || null,
        confidence_score: score(x.confidence_score, 7),
        status: 'active'
      }))).select('id');
      if (error) throw error;
      rulesInserted = data?.length || 0;
    }

    const opportunities = arr(intel.content_opportunities).slice(0, 12);
    let opportunitiesInserted = 0;
    if (opportunities.length) {
      const { data, error } = await supabase.from('content_opportunities').insert(opportunities.map((x: any) => ({
        opportunity_type: String(x.opportunity_type || 'thread').slice(0, 80),
        topic: x.topic || r.full,
        angle: x.angle || null,
        audience_pain: x.audience_pain || null,
        source_urls: sourceUrls(x.source_urls, meta.html_url),
        evidence_notes: x.evidence_notes || null,
        originality_notes: x.originality_notes || null,
        risk_notes: x.risk_notes || null,
        confidence_score: score(x.confidence_score, 7),
        priority_score: score(x.priority_score, 7),
        status: 'candidate'
      }))).select('id');
      if (error) throw error;
      opportunitiesInserted = data?.length || 0;
    }

    const decisions = arr(intel.repo_creation_decisions).slice(0, 5);
    let decisionsInserted = 0;
    if (decisions.length) {
      const { data, error } = await supabase.from('repo_creation_decisions').insert(decisions.map((x: any) => ({
        repo_source_id: repoRow.id,
        decision: 'create_repo',
        decision_confidence: score(x.decision_confidence, 10),
        repo_type: String(x.repo_type || 'guide').slice(0, 80),
        proposed_name: x.proposed_name || `${r.repo}-notes`,
        repo_goal: x.repo_goal || `Create a useful original repo inspired by ${r.full}`,
        why_this_must_be_repo: x.why_this_must_be_repo || 'The topic benefits from structured, maintained documentation or tooling.',
        documentation_plan: x.documentation_plan || {},
        test_plan: x.test_plan || {},
        maintenance_plan: x.maintenance_plan || {},
        localization_plan: x.localization_plan || {},
        status: 'approved_for_build'
      }))).select('id');
      if (error) throw error;
      decisionsInserted = data?.length || 0;
    }

    const autolearn = u.searchParams.get('autolearn') === '1';
    const automaintain = u.searchParams.get('automaintain') === '1';
    const mode = u.searchParams.get('mode') || 'trial';
    const secret = process.env.ORCHESTRATOR_SECRET || '';

    const log = await insertSessionLog({
      actions_completed: ['repo_ingest', VERSION, r.full, `files:${docs.length}`, `rules:${rulesInserted}`, `opportunities:${opportunitiesInserted}`, `repo_decisions:${decisionsInserted}`, autolearn ? 'autolearn_enabled' : 'autolearn_disabled', automaintain ? 'automaintain_enabled' : 'automaintain_disabled'],
      decisions_made: [intel.repo_summary || {}, { scores }],
      pending_tasks: [
        ...decisions.map((x: any) => `Build repo: ${x.proposed_name}`),
        ...(autolearn ? [`Auto-deep-learn ${r.full} in progress`] : []),
        ...(automaintain ? ['Auto memory-maintenance-run queued'] : [])
      ],
      next_recommendation: autolearn ? 'Deep learning is running automatically. Check growth_learning_runs for results.' : 'Run repo-deep-learn to deeply learn from ingested files.'
    });

    const baseUrl = `${u.protocol}//${u.host}`;
    const authHeaders: Record<string, string> = secret ? { 'x-orchestrator-secret': secret } : {};

    if (autolearn) {
      const learnUrl = `${baseUrl}/api/repo-deep-learn?repo=${encodeURIComponent(r.full)}&mode=${mode}&limit=20&force=0`;
      fetch(learnUrl, { method: 'GET', headers: authHeaders }).then(async (res) => {
        const learnResult = await res.json().catch(() => ({}));
        console.log(`[autolearn] repo-deep-learn completed for ${r.full}:`, JSON.stringify(learnResult.counts || {}));

        if (automaintain) {
          const maintainUrl = `${baseUrl}/api/memory-maintenance-run?mode=${mode}`;
          try {
            const maintainRes = await fetch(maintainUrl, { method: 'GET', headers: authHeaders });
            const maintainResult = await maintainRes.json().catch(() => ({}));
            console.log(`[automaintain] memory-maintenance-run completed:`, JSON.stringify(maintainResult.counts || {}));
          } catch (e: any) {
            console.error(`[automaintain] memory-maintenance-run failed:`, e.message);
          }
        }
      }).catch((e: any) => {
        console.error(`[autolearn] repo-deep-learn failed for ${r.full}:`, e.message);
      });
    }

    return Response.json({
      ok: true,
      version: VERSION,
      repo: { id: repoRow.id, repo_url: meta.html_url, github_full_name: r.full },
      files_loaded: docs.length,
      inserted: { rules: rulesInserted, opportunities: opportunitiesInserted, repo_creation_decisions: decisionsInserted },
      pipeline: {
        autolearn,
        automaintain,
        status: autolearn ? 'deep_learning_in_background' : 'manual_deep_learn_required',
        next_steps: autolearn
          ? ['repo-deep-learn running in background', automaintain ? 'memory-maintenance-run will follow automatically' : 'Run memory-maintenance-run after deep learning completes']
          : ['Run repo-deep-learn manually', 'Then run memory-maintenance-run']
      },
      intel,
      sessionLog: log
    });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
