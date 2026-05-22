import { assertAuthorized } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-investment-run-mvp';

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function scoreFromMetrics(repo: any, cards: any[], plans: any[]) {
  const readyCards = cards.filter((c) => c.quality_status === 'ready').length;
  const reviewCards = cards.filter((c) => c.quality_status !== 'ready').length;
  const readiness = Number(repo?.readiness_score || plans[0]?.readiness_score || 5);
  let score = Math.max(1, Math.min(10, readiness));
  if (readyCards >= 2) score += 1;
  if (reviewCards > readyCards) score -= 1;
  return Math.max(1, Math.min(10, score));
}

function decisionFromScore(score: number, hasOwnedRepo: boolean) {
  if (!hasOwnedRepo) return score >= 8 ? 'write_more_content' : 'needs_more_signal';
  if (score >= 8) return 'expand_repo';
  if (score >= 6) return 'maintain_repo';
  return 'needs_more_signal';
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const [ownedRepos, buildPlans, cards] = await Promise.all([
      supabase.from('owned_repo_projects').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('repo_build_plans').select('*').order('created_at', { ascending: false }).limit(30),
      supabase.from('content_production_cards').select('*').order('created_at', { ascending: false }).limit(80)
    ]);

    const repoRows = ownedRepos.data || [];
    const planRows = buildPlans.data || [];
    const cardRows = cards.data || [];
    const inserted: any[] = [];

    for (const plan of planRows) {
      const relatedRepo = repoRows.find((r: any) => r.repo_creation_decision_id && r.repo_creation_decision_id === plan.repo_creation_decision_id) || null;
      const relatedCards = cardRows.filter((c: any) => {
        const text = JSON.stringify(c || {}).toLowerCase();
        return text.includes(String(plan.proposed_repo_name || '').toLowerCase()) || text.includes(String(plan.problem_statement || '').slice(0, 30).toLowerCase());
      });
      const investmentScore = scoreFromMetrics(plan, relatedCards, [plan]);
      const decision = decisionFromScore(investmentScore, Boolean(relatedRepo));
      const reason = relatedRepo
        ? `Repo exists. Score ${investmentScore}/10 based on readiness and related production cards.`
        : `Build plan exists but repo is not published yet. Score ${investmentScore}/10; publish or create launch content before major expansion.`;
      const nextActions = decision === 'expand_repo'
        ? ['Plan V2 features from repo issues and X feedback.', 'Create more content around the repo use case.']
        : decision === 'write_more_content'
          ? ['Create launch thread or article for this planned repo.', 'Wait for X and GitHub engagement before expanding scope.']
          : ['Wait for more signal before expanding.', 'Keep V1 small and testable.'];

      const { data, error } = await supabase.from('repo_investment_decisions').insert({
        owned_repo_project_id: relatedRepo?.id || null,
        repo_build_plan_id: plan.id,
        decision,
        investment_score: investmentScore,
        reason,
        evidence: { ready_related_cards: relatedCards.filter((c: any) => c.quality_status === 'ready').length, review_related_cards: relatedCards.filter((c: any) => c.quality_status !== 'ready').length, readiness_score: plan.readiness_score || null },
        recommended_next_actions: nextActions,
        content_plan: { next_content: decision === 'write_more_content' ? 'launch_post_or_thread' : 'status_update_or_case_study' },
        repo_plan_updates: { expansion_stage: decision === 'expand_repo' ? 'v2_candidate' : 'v1_signal_gathering' },
        status: 'open'
      }).select('*').single();
      if (error) throw error;
      inserted.push(data);
      await supabase.from('repo_build_plans').update({ investment_gate: decision, updated_at: new Date().toISOString() }).eq('id', plan.id);
    }

    const log = await insertSessionLog({
      actions_completed: ['repo_investment_run', VERSION, `decisions:${inserted.length}`],
      decisions_made: inserted,
      pending_tasks: inserted.flatMap((x: any) => asArray(x.recommended_next_actions)).slice(0, 12),
      next_recommendation: 'Do not expand repos until X/GitHub signals justify it. Use planned repos to create launch content first.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { decisions: inserted.length }, decisions: inserted, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
