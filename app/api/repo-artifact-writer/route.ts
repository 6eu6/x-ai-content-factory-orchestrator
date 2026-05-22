import OpenAI from 'openai';
import crypto from 'crypto';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-artifact-writer-v1';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

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

function artifactQuality(path: string, content: string, plan: any) {
  const reasons: string[] = [];
  const lower = content.toLowerCase();
  if (!content || content.trim().length < 120) reasons.push('content_too_short');
  if (/lorem ipsum|todo: write|placeholder text/i.test(content)) reasons.push('placeholder_content');
  if (path.toLowerCase() === 'readme.md') {
    if (!lower.includes(plan.proposed_repo_name?.toLowerCase?.() || '')) reasons.push('readme_missing_repo_name');
    if (!/install|usage|example|why|test|validation/i.test(content)) reasons.push('readme_missing_core_sections');
  }
  if (/test|spec|validation/i.test(path) && !/assert|expect|test|check|pass|fail|validate/i.test(content)) reasons.push('test_file_missing_test_language');
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
      .select('*, repo_creation_decisions(*, repo_sources(*))')
      .in('status', ['planned', 'artifact_needs_review', 'artifacts_ready'])
      .order('readiness_score', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(limit);
    if (planId) query = query.eq('id', planId);
    const { data: plans, error: plansError } = await query;
    if (plansError) throw plansError;
    if (!plans?.length) return Response.json({ ok: true, version: VERSION, inserted: { plans: 0, artifacts: 0 }, note: 'No repo build plans found.' });

    const [repoRules, learningRules, existingArtifacts] = await Promise.all([
      supabase.from('repo_extracted_rules').select('*').order('confidence_score', { ascending: false }).limit(40),
      supabase.from('system_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(40),
      supabase.from('repo_build_artifacts').select('*').in('repo_build_plan_id', plans.map((p: any) => p.id))
    ]);

    let totalArtifacts = 0;
    const writtenPlans: any[] = [];

    for (const plan of plans) {
      const prompt = `You are writing files for a small, useful, testable GitHub repository.
Repository name: ${plan.proposed_repo_name}
Description: ${plan.repo_description || ''}
Target user: ${plan.target_user || ''}
Problem: ${plan.problem_statement || ''}
V1 goal: ${plan.v1_goal}
Rules:
- Write practical, human documentation.
- No filler, no hype, no fake claims.
- Include validation/testing instructions.
- Keep V1 small and usable.
- If this is not a code repo, tests can be checklist validation files.
Return strict JSON:
{"artifacts":[{"path":"README.md","type":"file","purpose":"...","content":"..."}]}
Plan=${JSON.stringify(plan)}
ExistingArtifacts=${JSON.stringify(existingArtifacts.data || [])}
RepoRules=${JSON.stringify(repoRules.data || [])}
SystemLearningRules=${JSON.stringify(learningRules.data || [])}`;

      const completion = await client().chat.completions.create({
        model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
        temperature: 0.08,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'Generate repository artifact files. Return JSON only.' },
          { role: 'user', content: prompt }
        ]
      });

      const raw = JSON.parse(completion.choices[0]?.message?.content || '{}');
      const artifacts = asArray(raw.artifacts).slice(0, 30);
      let readyArtifacts = 0;
      for (const artifact of artifacts) {
        const path = safePath(artifact.path || artifact.artifact_path);
        const content = String(artifact.content || artifact.generated_content || '').trim();
        if (!path || !content) continue;
        const quality = artifactQuality(path, content, plan);
        if (quality.status === 'ready') readyArtifacts++;
        const { error } = await supabase.from('repo_build_artifacts').upsert({
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
          status: quality.status === 'ready' ? 'ready' : 'needs_review',
          updated_at: new Date().toISOString()
        }, { onConflict: 'repo_build_plan_id,artifact_path' });
        if (error) throw error;
        totalArtifacts++;
      }

      const planStatus = artifacts.length && readyArtifacts === artifacts.length ? 'artifacts_ready' : 'artifact_needs_review';
      await supabase.from('repo_build_plans').update({
        artifact_writing_status: planStatus,
        artifact_writer_version: VERSION,
        artifact_last_written_at: new Date().toISOString(),
        status: planStatus,
        updated_at: new Date().toISOString()
      }).eq('id', plan.id);
      writtenPlans.push({ id: plan.id, proposed_repo_name: plan.proposed_repo_name, artifacts: artifacts.length, ready_artifacts: readyArtifacts, status: planStatus });
    }

    const log = await insertSessionLog({
      actions_completed: ['repo_artifact_writer', VERSION, `plans:${writtenPlans.length}`, `artifacts:${totalArtifacts}`],
      decisions_made: writtenPlans,
      pending_tasks: writtenPlans.filter((p) => p.status !== 'artifacts_ready').map((p) => `Review artifacts for ${p.proposed_repo_name}`),
      next_recommendation: 'Run repo validation before creating GitHub repositories.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { plans: writtenPlans.length, artifacts: totalArtifacts }, plans: writtenPlans, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
