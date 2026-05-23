import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-post-push-validation-v1';

function ghHeaders() {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'x-github-api-version': '2022-11-28'
  };
}

async function gh(path: string) {
  const res = await fetch(`https://api.github.com${path}`, { headers: ghHeaders() });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: res.ok, status: res.status, json };
}

async function getContent(fullName: string, path: string) {
  const res = await gh(`/repos/${fullName}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=main`);
  if (!res.ok) return null;
  return res.json;
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const repoId = url.searchParams.get('repo_id');
    const fullNameParam = url.searchParams.get('repo');

    let query = supabase.from('owned_repo_projects').select('*').eq('build_status', 'pushed').order('created_at', { ascending: false }).limit(1);
    if (repoId) query = query.eq('id', repoId);
    if (fullNameParam) query = query.eq('github_full_name', fullNameParam);
    const { data: repos, error: repoError } = await query;
    if (repoError) throw repoError;
    if (!repos?.length) return Response.json({ ok: true, version: VERSION, inserted: { validation_runs: 0 }, note: 'No pushed owned repo found.' });

    const owned = repos[0];
    const fullName = owned.github_full_name;
    const repoMeta = await gh(`/repos/${fullName}`);
    if (!repoMeta.ok) throw new Error(`GitHub repo fetch failed ${repoMeta.status}: ${JSON.stringify(repoMeta.json)}`);

    const planId = url.searchParams.get('plan_id');
    let artifactsQuery = supabase.from('repo_build_artifacts').select('*').eq('quality_status', 'ready').order('artifact_path', { ascending: true });
    if (planId) artifactsQuery = artifactsQuery.eq('repo_build_plan_id', planId);
    else {
      const { data: plan } = await supabase.from('repo_build_plans').select('*').eq('repo_creation_decision_id', owned.repo_creation_decision_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (plan?.id) artifactsQuery = artifactsQuery.eq('repo_build_plan_id', plan.id);
    }
    const { data: artifacts, error: artifactsError } = await artifactsQuery;
    if (artifactsError) throw artifactsError;

    const checks: any[] = [];
    const failures: string[] = [];
    const warnings: string[] = [];

    checks.push({ check: 'repo_exists', status: 'passed', details: { fullName, default_branch: repoMeta.json.default_branch, visibility: repoMeta.json.visibility } });
    if (repoMeta.json.visibility !== 'public') warnings.push('repo_not_public');

    const expectedArtifacts = artifacts || [];
    for (const artifact of expectedArtifacts) {
      const path = artifact.artifact_path;
      const remote = await getContent(fullName, path);
      if (!remote) {
        failures.push(`missing_remote_file:${path}`);
        checks.push({ check: 'remote_file_exists', path, status: 'failed' });
      } else {
        checks.push({ check: 'remote_file_exists', path, status: 'passed', details: { size: remote.size, sha: remote.sha } });
      }
    }

    const readme = await getContent(fullName, 'README.md');
    checks.push({ check: 'readme_remote_present', status: readme ? 'passed' : 'failed' });
    if (!readme) failures.push('remote_readme_missing');

    const packageJson = await getContent(fullName, 'package.json');
    checks.push({ check: 'package_json_remote_present', status: packageJson ? 'passed' : 'failed' });
    if (!packageJson && expectedArtifacts.some((a: any) => a.artifact_path === 'package.json')) failures.push('remote_package_json_missing');

    const status = failures.length ? 'failed' : warnings.length ? 'warning' : 'passed';
    const { data: runRow, error: runError } = await supabase.from('repo_validation_runs').insert({
      owned_repo_project_id: owned.id,
      validation_type: 'post_push_github',
      status,
      checks,
      results: { failures, warnings, expected_artifacts: expectedArtifacts.length, github: { full_name: fullName, url: repoMeta.json.html_url } },
      failure_notes: failures.length ? failures.join('\n') : warnings.join('\n') || null,
      completed_at: new Date().toISOString()
    }).select('*').single();
    if (runError) throw runError;

    await supabase.from('owned_repo_projects').update({
      test_status: status === 'passed' ? 'post_push_validated' : status === 'warning' ? 'post_push_warning' : 'post_push_failed',
      last_tested_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).eq('id', owned.id);

    const log = await insertSessionLog({
      actions_completed: ['repo_post_push_validation', VERSION, fullName, status],
      decisions_made: [{ repo: fullName, status, failures, warnings }],
      db_updates: [{ table: 'repo_validation_runs', id: runRow.id }, { table: 'owned_repo_projects', id: owned.id, test_status: status }],
      pending_tasks: status === 'passed' ? ['Create launch content for X.'] : ['Fix post-push validation issues.'],
      next_recommendation: status === 'passed' ? 'Run launch-content-from-repo.' : 'Repair pushed repo files.'
    });

    return Response.json({ ok: true, version: VERSION, status, repo: owned, validation_run: runRow, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
