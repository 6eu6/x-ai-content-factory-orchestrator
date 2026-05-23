import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-validation-run-v1';

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function parsePackageScripts(content: string) {
  try {
    const json = JSON.parse(content);
    return json.scripts || {};
  } catch {
    return {};
  }
}

function extractReadmeCommands(readme: string) {
  const commands = new Set<string>();
  const blockRegex = /```(?:bash|sh|shell)?\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = blockRegex.exec(readme))) {
    for (const rawLine of match[1].split('\n')) {
      const line = rawLine.trim().replace(/^\$\s*/, '');
      if (/^(npm|pnpm|yarn|node|npx)\s+/.test(line)) commands.add(line);
    }
  }
  return Array.from(commands);
}

function scriptNameFromCommand(command: string) {
  const npmRun = command.match(/^(npm|pnpm|yarn)\s+run\s+([a-zA-Z0-9:_-]+)/);
  if (npmRun) return npmRun[2];
  const npmShortcut = command.match(/^npm\s+(test|start|build)$/);
  if (npmShortcut) return npmShortcut[1] === 'test' ? 'test' : npmShortcut[1];
  const yarnShortcut = command.match(/^yarn\s+(test|start|build)$/);
  if (yarnShortcut) return yarnShortcut[1];
  return null;
}

function looksRiskySecurity(content: string) {
  const lower = content.toLowerCase();
  const risks: string[] = [];
  if (lower.includes('cryptorandom') || lower.includes('randombytes(32)')) {
    if (!lower.includes('do not use in production') && !lower.includes('example only') && !lower.includes('inject')) {
      risks.push('credential_or_crypto_example_missing_production_warning');
    }
  }
  if (/api[_-]?key\s*=\s*['"][a-z0-9_-]{12,}/i.test(content)) risks.push('possible_hardcoded_api_key');
  if (/password\s*=\s*['"][^'"]{4,}/i.test(content)) risks.push('possible_hardcoded_password');
  return risks;
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 3), 1), 10);
    const planId = url.searchParams.get('plan_id');

    let planQuery = supabase
      .from('repo_build_plans')
      .select('*')
      .in('status', ['artifacts_ready', 'artifact_needs_review'])
      .order('readiness_score', { ascending: false })
      .limit(limit);
    if (planId) planQuery = planQuery.eq('id', planId);
    const { data: plans, error: plansError } = await planQuery;
    if (plansError) throw plansError;
    if (!plans?.length) return Response.json({ ok: true, version: VERSION, inserted: { validation_runs: 0 }, note: 'No artifact-ready plans found.' });

    const planIds = plans.map((p: any) => p.id);
    const [artifactsRes, requirementsRes] = await Promise.all([
      supabase.from('repo_build_artifacts').select('*').in('repo_build_plan_id', planIds),
      supabase.from('repo_artifact_requirements').select('*').in('repo_build_plan_id', planIds)
    ]);
    if (artifactsRes.error) throw artifactsRes.error;
    if (requirementsRes.error) throw requirementsRes.error;

    const validationRuns: any[] = [];

    for (const plan of plans) {
      const artifacts = (artifactsRes.data || []).filter((a: any) => a.repo_build_plan_id === plan.id);
      const requirements = (requirementsRes.data || []).filter((r: any) => r.repo_build_plan_id === plan.id);
      const byPath = new Map(artifacts.map((a: any) => [String(a.artifact_path).toLowerCase(), a]));
      const checks: any[] = [];
      const failures: string[] = [];
      const warnings: string[] = [];

      const missingRequired = requirements.filter((r: any) => r.required && !byPath.has(String(r.path).toLowerCase())).map((r: any) => r.path);
      checks.push({ check: 'required_files_present', status: missingRequired.length ? 'failed' : 'passed', details: { missingRequired } });
      if (missingRequired.length) failures.push(`missing_required_files:${missingRequired.join(',')}`);

      const readme = byPath.get('readme.md');
      checks.push({ check: 'readme_present', status: readme ? 'passed' : 'failed' });
      if (!readme) failures.push('readme_missing');

      const packageJson = byPath.get('package.json');
      const packageScripts = packageJson ? parsePackageScripts(packageJson.generated_content || '') : {};
      if (readme) {
        const commands = extractReadmeCommands(readme.generated_content || '');
        const missingScripts = commands
          .map((cmd) => ({ cmd, script: scriptNameFromCommand(cmd) }))
          .filter((x) => x.script && !packageScripts[x.script]);
        checks.push({ check: 'readme_commands_have_scripts', status: missingScripts.length ? 'failed' : 'passed', details: { commands, missingScripts, packageScripts: Object.keys(packageScripts) } });
        if (missingScripts.length) failures.push(`readme_commands_missing_scripts:${missingScripts.map((x) => x.cmd).join('|')}`);
      }

      const readyFailures = artifacts.filter((a: any) => a.quality_status !== 'ready').map((a: any) => ({ path: a.artifact_path, reasons: a.quality_reasons }));
      checks.push({ check: 'artifact_quality_ready', status: readyFailures.length ? 'failed' : 'passed', details: { readyFailures } });
      if (readyFailures.length) failures.push('artifact_quality_not_ready');

      const testArtifacts = artifacts.filter((a: any) => /test|spec|validation/i.test(a.artifact_path));
      checks.push({ check: 'test_or_validation_present', status: testArtifacts.length ? 'passed' : 'failed', details: { testArtifacts: testArtifacts.map((a: any) => a.artifact_path) } });
      if (!testArtifacts.length) failures.push('missing_test_or_validation_artifact');

      for (const artifact of artifacts) {
        const securityRisks = looksRiskySecurity(artifact.generated_content || '');
        if (securityRisks.length) {
          warnings.push(...securityRisks.map((r) => `${artifact.artifact_path}:${r}`));
        }
      }
      checks.push({ check: 'security_example_review', status: warnings.length ? 'warning' : 'passed', details: { warnings } });

      const validationStatus = failures.length ? 'failed' : warnings.length ? 'warning' : 'passed';
      const { data: runRow, error: runError } = await supabase.from('repo_validation_runs').insert({
        repo_build_plan_id: plan.id,
        validation_type: 'artifact_consistency',
        status: validationStatus,
        checks,
        results: { failures, warnings, artifact_count: artifacts.length, requirement_count: requirements.length },
        failure_notes: failures.length ? failures.join('\n') : warnings.join('\n') || null,
        completed_at: new Date().toISOString()
      }).select('*').single();
      if (runError) throw runError;
      validationRuns.push(runRow);

      await supabase.from('repo_build_plans').update({
        status: validationStatus === 'passed' ? 'validated_ready' : validationStatus === 'warning' ? 'validation_warning' : 'validation_failed',
        updated_at: new Date().toISOString()
      }).eq('id', plan.id);
    }

    const log = await insertSessionLog({
      actions_completed: ['repo_validation_run', VERSION, `runs:${validationRuns.length}`],
      decisions_made: validationRuns.map((r: any) => ({ id: r.id, status: r.status, plan: r.repo_build_plan_id })),
      pending_tasks: validationRuns.filter((r: any) => r.status !== 'passed').map((r: any) => `Fix validation for plan ${r.repo_build_plan_id}: ${r.failure_notes || 'warning'}`),
      next_recommendation: validationRuns.some((r: any) => r.status === 'passed') ? 'Create GitHub repo for validated plans.' : 'Repair artifacts and rerun validation.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { validation_runs: validationRuns.length }, validation_runs: validationRuns, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
