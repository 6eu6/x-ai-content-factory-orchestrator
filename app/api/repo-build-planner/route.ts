import { assertAuthorized, optionalEnv } from '../../../lib/env';
import { callModel, parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-build-planner-v1';

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function score(value: any, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const scaled = n > 0 && n <= 1 ? n * 10 : n;
  return Math.min(10, Math.max(1, Math.round(scaled)));
}

function cleanRepoName(value: any, fallback: string) {
  const raw = String(value || fallback || 'content-lab-repo').toLowerCase();
  return raw.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || fallback;
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 5), 1), 10);

    const [decisions, repoRules, learningRules, productionCards] = await Promise.all([
      supabase.from('repo_creation_decisions').select('*, repo_sources(*)').in('status', ['approved_for_build', 'planned']).order('created_at', { ascending: false }).limit(limit),
      supabase.from('repo_extracted_rules').select('*').order('confidence_score', { ascending: false }).limit(50),
      supabase.from('system_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(50),
      supabase.from('content_production_cards').select('*').order('created_at', { ascending: false }).limit(30)
    ]);

    const decisionRows = decisions.data || [];
    if (!decisionRows.length) return Response.json({ ok: true, version: VERSION, plans: [], note: 'No approved repo creation decisions found.' });

    const prompt = `You are the Repo Build Planner for @${optionalEnv('X_USERNAME', '30piq')}.
Goal: convert broad create_repo decisions into small, useful, testable V1 GitHub repositories.
Important:
- Do NOT plan a huge clone of the source repo.
- Produce a narrow V1 that can be built, tested, documented, maintained, and used as content proof.
- Every plan must include test requirements and validation commands.
- Every plan must include a launch content plan for X.
- Use clear human documentation, examples, and changelog. Avoid boilerplate.
Return strict JSON:
{
  "plans":[{
    "repo_creation_decision_id":"...",
    "proposed_repo_name":"...",
    "repo_description":"...",
    "target_user":"...",
    "problem_statement":"...",
    "v1_goal":"...",
    "must_have_files":[{"path":"README.md","purpose":"..."}],
    "nice_to_have_files":[{"path":"...","purpose":"..."}],
    "readme_sections":["..."],
    "example_assets":[{"path":"...","purpose":"..."}],
    "test_requirements":["..."],
    "validation_commands":["..."],
    "maintenance_tasks":["..."],
    "launch_content_plan":{"x_post":"...","thread_angle":"...","repo_link_placeholder":"..."},
    "risk_notes":"...",
    "readiness_score":1,
    "artifacts":[{"artifact_path":"README.md","artifact_type":"file","artifact_purpose":"...","content_summary":"..."}]
  }]
}
decisions=${JSON.stringify(decisionRows)}
repoRules=${JSON.stringify(repoRules.data || [])}
systemLearningRules=${JSON.stringify(learningRules.data || [])}
productionCards=${JSON.stringify(productionCards.data || [])}`;

    const modelResponse = await callModel('repo_artifact', [
      { role: 'system', content: 'Plan small, useful, testable GitHub repositories from approved repo decisions. JSON only.' },
      { role: 'user', content: prompt }
    ], { temperature: 0.05 });
    const raw = parseModelJson(modelResponse);
    const plans = asArray(raw.plans).slice(0, limit);
    const insertedPlans: any[] = [];
    let artifactsInserted = 0;

    for (const plan of plans) {
      const decisionId = String(plan.repo_creation_decision_id || '').trim();
      const decision = decisionRows.find((d: any) => String(d.id) === decisionId);
      if (!decision) continue;
      const repoName = cleanRepoName(plan.proposed_repo_name, decision.proposed_name || 'content-lab-repo');
      const { data: buildPlan, error: planError } = await supabase.from('repo_build_plans').insert({
        repo_creation_decision_id: decisionId,
        plan_version: 'v1',
        build_scope: 'small_testable_repo',
        proposed_repo_name: repoName,
        repo_description: plan.repo_description || null,
        target_user: plan.target_user || null,
        problem_statement: plan.problem_statement || null,
        v1_goal: plan.v1_goal || decision.repo_goal || 'Build a small useful repository.',
        must_have_files: asArray(plan.must_have_files),
        nice_to_have_files: asArray(plan.nice_to_have_files),
        readme_sections: asArray(plan.readme_sections),
        example_assets: asArray(plan.example_assets),
        test_requirements: asArray(plan.test_requirements),
        validation_commands: asArray(plan.validation_commands),
        maintenance_tasks: asArray(plan.maintenance_tasks),
        launch_content_plan: plan.launch_content_plan || {},
        risk_notes: plan.risk_notes || null,
        readiness_score: score(plan.readiness_score, 7),
        status: 'planned'
      }).select('*').single();
      if (planError) throw planError;
      insertedPlans.push(buildPlan);

      const artifacts = asArray(plan.artifacts).slice(0, 30);
      for (const artifact of artifacts) {
        const artifactPath = String(artifact.artifact_path || '').trim();
        if (!artifactPath) continue;
        const { error } = await supabase.from('repo_build_artifacts').upsert({
          repo_build_plan_id: buildPlan.id,
          artifact_path: artifactPath,
          artifact_type: artifact.artifact_type || 'file',
          artifact_purpose: artifact.artifact_purpose || null,
          content_summary: artifact.content_summary || null,
          generated_content: artifact.generated_content || null,
          status: 'draft',
          updated_at: new Date().toISOString()
        }, { onConflict: 'repo_build_plan_id,artifact_path' });
        if (!error) artifactsInserted++;
      }

      await supabase.from('repo_creation_decisions').update({
        build_plan_id: buildPlan.id,
        build_planning_status: 'planned',
        status: 'planned',
        updated_at: new Date().toISOString()
      }).eq('id', decisionId);

      await supabase.from('repo_validation_runs').insert({
        repo_build_plan_id: buildPlan.id,
        validation_type: 'pre_build_review',
        status: 'pending',
        checks: asArray(plan.test_requirements),
        results: { validation_commands: asArray(plan.validation_commands) }
      });
    }

    const log = await insertSessionLog({
      actions_completed: ['repo_build_planner', VERSION, `plans:${insertedPlans.length}`, `artifacts:${artifactsInserted}`],
      decisions_made: insertedPlans,
      pending_tasks: insertedPlans.map((p) => `Build repo V1: ${p.proposed_repo_name}`),
      next_recommendation: 'Review repo_build_plans, then run repo artifact writer/build step.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { plans: insertedPlans.length, artifacts: artifactsInserted }, plans: insertedPlans, raw, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
