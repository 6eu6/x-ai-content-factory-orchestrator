import crypto from 'crypto';
import { assertAuthorized } from '../../../lib/env';
import { callModel, parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-artifact-writer-v1.2-style-aware';

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function sha(value: string) {
  return crypto.createHash('sha256').update(value || '').digest('hex');
}

function safePath(value: any) {
  return String(value || '').trim().replace(/^\/+/, '').replace(/\.\./g, '').slice(0, 180);
}

function inferRepoType(plan: any) {
  const text = `${plan.proposed_repo_name || ''} ${plan.repo_description || ''} ${plan.v1_goal || ''} ${plan.problem_statement || ''}`.toLowerCase();
  if (/sdk|framework|builder|typescript|api|package|cli|tool|src\//i.test(text)) return 'tool';
  if (/playbook|algorithm|breakdown|guide|deepdive|deep-dive/i.test(text)) return 'playbook';
  if (/checklist|scorecard|template/i.test(text)) return 'template';
  return 'guide';
}

function defaultRequirements(plan: any, repoType: string) {
  const reqs = new Map<string, any>();
  const add = (path: string, purpose: string, required = true, reason = 'dynamic default') => reqs.set(path, { path, purpose, required, reason });
  add('README.md', 'Main entry point with why, usage, examples, and validation steps');
  add('CHANGELOG.md', 'Track meaningful changes and future improvements');
  add('LICENSE', 'Make reuse terms clear');
  if (repoType === 'tool') {
    add('package.json', 'Package metadata and validation scripts');
    add('tsconfig.json', 'TypeScript compiler configuration');
    add('src/piece-builder.ts', 'Core builder logic or typed scaffold');
    add('src/credential-service.ts', 'Credential handling example or scaffold');
    add('examples/sample-piece.ts', 'Concrete example integration');
    add('tests/piece-builder.test.ts', 'Smoke/unit test for the builder behavior');
    add('docs/ux-guidelines.md', 'Practical UX guidelines for integrations');
  } else if (repoType === 'playbook') {
    add('docs/overview.md', 'Structured overview of the system or topic');
    add('playbooks/practical-checklist.md', 'Actionable checklist derived from the breakdown');
    add('examples/content-review-example.md', 'Concrete example applying the playbook');
    add('validation.md', 'Manual validation checklist for claims and usefulness');
  } else if (repoType === 'template') {
    add('template/checklist.md', 'Reusable checklist template');
    add('examples/filled-example.md', 'Filled example showing realistic usage');
    add('validation.md', 'Checklist validation rules');
  } else {
    add('docs/guide.md', 'Main guide content');
    add('examples/example.md', 'Concrete example');
    add('validation.md', 'Manual validation checklist');
  }
  return Array.from(reqs.values());
}

function artifactQuality(path: string, content: string, plan: any, rules: any[]) {
  const reasons: string[] = [];
  const lower = content.toLowerCase();
  if (!content || content.trim().length < 120) reasons.push('content_too_short');
  if (/lorem ipsum|todo: write|placeholder text|coming soon/i.test(content)) reasons.push('placeholder_content');
  if (/comprehensive|seamless|unlock|revolutionize|cutting-edge|game-changing/i.test(content)) reasons.push('generic_ai_voice_risk');
  if (path.toLowerCase() === 'readme.md') {
    if (!lower.includes(plan.proposed_repo_name?.toLowerCase?.() || '')) reasons.push('readme_missing_repo_name');
    if (!/install|usage|example|why|test|validation/i.test(content)) reasons.push('readme_missing_core_sections');
  }
  if (/test|spec|validation/i.test(path) && !/assert|expect|test|check|pass|fail|validate|manual validation/i.test(content)) reasons.push('test_file_missing_test_language');
  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 1), 1), 3);
    const planId = url.searchParams.get('plan_id');

    let query = supabase
      .from('repo_build_plans')
      .select('*')
      .in('status', ['planned', 'artifact_needs_review', 'artifacts_ready'])
      .order('readiness_score', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(limit);
    if (planId) query = query.eq('id', planId);
    const { data: plans, error: plansError } = await query;
    if (plansError) throw plansError;
    if (!plans?.length) return Response.json({ ok: true, version: VERSION, inserted: { plans: 0, artifacts: 0 }, note: 'No repo build plans found.' });

    const decisionIds = plans.map((p: any) => p.repo_creation_decision_id).filter(Boolean);
    const [repoRules, learningRules, existingArtifacts, decisions, styleTemplates, writerRules] = await Promise.all([
      supabase.from('repo_extracted_rules').select('*').order('confidence_score', { ascending: false }).limit(40),
      supabase.from('system_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(40),
      supabase.from('repo_build_artifacts').select('*').in('repo_build_plan_id', plans.map((p: any) => p.id)),
      decisionIds.length ? supabase.from('repo_creation_decisions').select('*').in('id', decisionIds) : Promise.resolve({ data: [], error: null }),
      supabase.from('repo_style_templates').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(20),
      supabase.from('repo_writer_quality_rules').select('*').eq('status', 'active').order('severity', { ascending: true })
    ]);
    if (decisions.error) throw decisions.error;

    const sourceIds = (decisions.data || []).map((d: any) => d.repo_source_id).filter(Boolean);
    const sources = sourceIds.length ? await supabase.from('repo_sources').select('*').in('id', sourceIds) : { data: [], error: null };
    if (sources.error) throw sources.error;

    const decisionsById = new Map((decisions.data || []).map((d: any) => [d.id, d]));
    const sourcesById = new Map((sources.data || []).map((s: any) => [s.id, s]));

    let totalArtifacts = 0;
    let totalRequirements = 0;
    const writtenPlans: any[] = [];

    for (const plan of plans) {
      const repoType = plan.repo_type_inferred || inferRepoType(plan);
      const matchingTemplates = (styleTemplates.data || []).filter((t: any) => t.repo_type === repoType || (repoType === 'tool' && t.repo_type === 'tool') || (repoType === 'playbook' && t.repo_type === 'playbook')).slice(0, 3);
      const requirements = defaultRequirements(plan, repoType);
      for (const req of requirements) {
        const { data: reqRow } = await supabase.from('repo_artifact_requirements').upsert({
          repo_build_plan_id: plan.id,
          requirement_type: 'file',
          path: req.path,
          purpose: req.purpose,
          required: req.required,
          reason: req.reason,
          status: 'required',
          source: 'dynamic_writer',
          updated_at: new Date().toISOString()
        }, { onConflict: 'repo_build_plan_id,path' }).select('*').single();
        if (reqRow) totalRequirements++;
      }

      const decision = decisionsById.get(plan.repo_creation_decision_id) || null;
      const source = decision?.repo_source_id ? sourcesById.get(decision.repo_source_id) : null;
      const planContext = { ...plan, repo_type_inferred: repoType, repo_creation_decision: decision, repo_source: source };
      const prompt = `You are writing a complete small GitHub repository artifact set.
Repository name: ${plan.proposed_repo_name}
Repo type: ${repoType}
Description: ${plan.repo_description || ''}
Target user: ${plan.target_user || ''}
Problem: ${plan.problem_statement || ''}
V1 goal: ${plan.v1_goal}
Rules:
- Generate every required artifact listed in RequiredFiles.
- Do not stop at README.md.
- Write practical, human documentation.
- Avoid robotic or marketing-heavy phrasing.
- No filler, no hype, no fake claims.
- Include validation/testing instructions.
- Keep V1 small and usable.
- If this is not a code repo, tests can be checklist validation files.
Return strict JSON:
{"artifacts":[{"path":"README.md","type":"file","purpose":"...","content":"..."}]}
RequiredFiles=${JSON.stringify(requirements)}
StyleTemplates=${JSON.stringify(matchingTemplates)}
WriterQualityRules=${JSON.stringify(writerRules.data || [])}
Plan=${JSON.stringify(planContext)}
ExistingArtifacts=${JSON.stringify(existingArtifacts.data || [])}
RepoRules=${JSON.stringify(repoRules.data || [])}
SystemLearningRules=${JSON.stringify(learningRules.data || [])}`;

      const modelResponse = await callModel('repo_artifact', [
        { role: 'system', content: 'Generate complete repository artifact files from dynamic requirements and style templates. Return JSON only.' },
        { role: 'user', content: prompt }
      ], { temperature: 0.07 });
      const raw = parseModelJson(modelResponse);
      const artifacts = asArray(raw.artifacts).slice(0, 40);
      let readyArtifacts = 0;
      for (const artifact of artifacts) {
        const path = safePath(artifact.path || artifact.artifact_path);
        const content = String(artifact.content || artifact.generated_content || '').trim();
        if (!path || !content) continue;
        const quality = artifactQuality(path, content, plan, writerRules.data || []);
        if (quality.status === 'ready') readyArtifacts++;
        const { data: artifactRow, error } = await supabase.from('repo_build_artifacts').upsert({
          repo_build_plan_id: plan.id,
          artifact_path: path,
          artifact_type: artifact.type || artifact.artifact_type || 'file',
          artifact_purpose: artifact.purpose || artifact.artifact_purpose || null,
          content_summary: artifact.summary || artifact.content_summary || null,
          generated_content: content,
          content_hash: sha(content),
          quality_status: quality.status,
          quality_reasons: quality.reasons,
          writer_version: VERSION,
          style_basis: { repo_type: repoType, template_ids: matchingTemplates.map((t: any) => t.id) },
          requirement_matched: requirements.some((r) => r.path === path),
          status: quality.status === 'ready' ? 'ready' : 'needs_review',
          updated_at: new Date().toISOString()
        }, { onConflict: 'repo_build_plan_id,artifact_path' }).select('*').single();
        if (error) throw error;
        await supabase.from('repo_artifact_requirements').update({ fulfilled_by_artifact_id: artifactRow?.id || null, status: 'fulfilled', updated_at: new Date().toISOString() }).eq('repo_build_plan_id', plan.id).eq('path', path);
        totalArtifacts++;
      }

      const requiredPaths = requirements.filter((r) => r.required).map((r) => r.path);
      const artifactPaths = artifacts.map((a: any) => safePath(a.path || a.artifact_path)).filter(Boolean);
      const missingRequired = requiredPaths.filter((p) => !artifactPaths.includes(p));
      const planStatus = artifacts.length && missingRequired.length === 0 && readyArtifacts === artifacts.length ? 'artifacts_ready' : 'artifact_needs_review';
      await supabase.from('repo_build_plans').update({
        artifact_writing_status: planStatus,
        artifact_writer_version: VERSION,
        artifact_last_written_at: new Date().toISOString(),
        repo_type_inferred: repoType,
        dynamic_file_strategy: { required_files: requirements, missing_required: missingRequired },
        style_template_ids: matchingTemplates.map((t: any) => t.id),
        status: planStatus,
        updated_at: new Date().toISOString()
      }).eq('id', plan.id);
      for (const template of matchingTemplates) {
        await supabase.from('repo_style_templates').update({ last_used_at: new Date().toISOString(), usage_count: Number(template.usage_count || 0) + 1, updated_at: new Date().toISOString() }).eq('id', template.id);
      }
      writtenPlans.push({ id: plan.id, proposed_repo_name: plan.proposed_repo_name, repo_type: repoType, artifacts: artifacts.length, ready_artifacts: readyArtifacts, missing_required: missingRequired, status: planStatus });
    }

    const log = await insertSessionLog({
      actions_completed: ['repo_artifact_writer', VERSION, `plans:${writtenPlans.length}`, `requirements:${totalRequirements}`, `artifacts:${totalArtifacts}`],
      decisions_made: writtenPlans,
      pending_tasks: writtenPlans.filter((p) => p.status !== 'artifacts_ready').map((p) => `Review artifacts for ${p.proposed_repo_name}: missing ${p.missing_required?.join(', ') || 'quality'}`),
      next_recommendation: 'Run repo validation before creating GitHub repositories.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { plans: writtenPlans.length, requirements: totalRequirements, artifacts: totalArtifacts }, plans: writtenPlans, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
