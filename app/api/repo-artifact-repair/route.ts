import OpenAI from 'openai';
import crypto from 'crypto';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-artifact-repair-v1';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function sha(value: string) {
  return crypto.createHash('sha256').update(value || '').digest('hex');
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function safePath(value: any) {
  return String(value || '').trim().replace(/^\/+/, '').replace(/\.\./g, '').slice(0, 180);
}

function quality(path: string, content: string) {
  const reasons: string[] = [];
  const lower = content.toLowerCase();
  if (!content || content.length < 120) reasons.push('content_too_short');
  if (/lorem ipsum|todo: write|placeholder text|coming soon/i.test(content)) reasons.push('placeholder_content');
  if (/api[_-]?key\s*=\s*['"][a-z0-9_-]{12,}/i.test(content)) reasons.push('possible_hardcoded_api_key');
  if (path.toLowerCase().includes('credential')) {
    if ((lower.includes('randombytes(32)') || lower.includes('crypto.randombytes')) && !/(example only|do not use.*production|inject.*secret|environment variable|key management service)/i.test(content)) {
      reasons.push('credential_or_crypto_example_missing_production_warning');
    }
  }
  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const planId = url.searchParams.get('plan_id');
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 3), 1), 10);

    let validationQuery = supabase
      .from('repo_validation_runs')
      .select('*')
      .in('status', ['warning', 'failed'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (planId) validationQuery = validationQuery.eq('repo_build_plan_id', planId);
    const { data: validations, error: validationError } = await validationQuery;
    if (validationError) throw validationError;
    if (!validations?.length) return Response.json({ ok: true, version: VERSION, inserted: { repaired_artifacts: 0 }, note: 'No warning/failed validation runs found.' });

    const planIds = Array.from(new Set(validations.map((v: any) => v.repo_build_plan_id).filter(Boolean)));
    const [plansRes, artifactsRes, requirementsRes] = await Promise.all([
      supabase.from('repo_build_plans').select('*').in('id', planIds),
      supabase.from('repo_build_artifacts').select('*').in('repo_build_plan_id', planIds),
      supabase.from('repo_artifact_requirements').select('*').in('repo_build_plan_id', planIds)
    ]);
    if (plansRes.error) throw plansRes.error;
    if (artifactsRes.error) throw artifactsRes.error;
    if (requirementsRes.error) throw requirementsRes.error;

    const repaired: any[] = [];

    for (const validation of validations) {
      const plan = (plansRes.data || []).find((p: any) => p.id === validation.repo_build_plan_id);
      if (!plan) continue;
      const artifacts = (artifactsRes.data || []).filter((a: any) => a.repo_build_plan_id === plan.id);
      const requirements = (requirementsRes.data || []).filter((r: any) => r.repo_build_plan_id === plan.id);
      const notes = String(validation.failure_notes || '').toLowerCase();
      const targetArtifacts = artifacts.filter((a: any) => {
        if (notes.includes('credential') && String(a.artifact_path).toLowerCase().includes('credential')) return true;
        if (a.quality_status !== 'ready') return true;
        return false;
      });

      for (const artifact of targetArtifacts) {
        const prompt = `Repair this repository artifact. Keep the same path. Fix only the validation and quality issues. Do not add filler.
Plan=${JSON.stringify(plan)}
Validation=${JSON.stringify(validation)}
Requirements=${JSON.stringify(requirements)}
ArtifactPath=${artifact.artifact_path}
CurrentContent=${artifact.generated_content}
Specific repair rules:
- If credential or crypto example is educational, make it safe: inject secrets/config from caller or environment; add clear production warning; avoid hardcoded secrets; avoid presenting random runtime key as production pattern.
- Preserve useful exported types/classes where possible.
Return strict JSON: {"path":"...","content":"...","repair_notes":["..."]}`;
        const completion = await client().chat.completions.create({
          model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
          temperature: 0.04,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Repair repository artifact content safely. JSON only.' },
            { role: 'user', content: prompt }
          ]
        });
        const raw = parseModelJson(completion.choices[0]?.message?.content || '');
        const path = safePath(raw.path || artifact.artifact_path);
        const content = String(raw.content || '').trim();
        if (!path || !content) continue;
        const q = quality(path, content);
        const { data, error } = await supabase.from('repo_build_artifacts').upsert({
          repo_build_plan_id: plan.id,
          artifact_path: path,
          artifact_type: artifact.artifact_type || 'file',
          artifact_purpose: artifact.artifact_purpose || null,
          content_summary: artifact.content_summary || null,
          generated_content: content,
          content_hash: sha(content),
          quality_status: q.status,
          quality_reasons: q.reasons,
          writer_version: VERSION,
          status: q.status === 'ready' ? 'ready' : 'needs_review',
          updated_at: new Date().toISOString()
        }, { onConflict: 'repo_build_plan_id,artifact_path' }).select('*').single();
        if (error) throw error;
        repaired.push({ plan_id: plan.id, path, status: q.status, reasons: q.reasons, notes: asArray(raw.repair_notes) });
        await supabase.from('repo_artifact_requirements').update({ fulfilled_by_artifact_id: data?.id || null, status: 'fulfilled', updated_at: new Date().toISOString() }).eq('repo_build_plan_id', plan.id).ilike('path', path);
      }

      await supabase.from('repo_build_plans').update({ status: 'artifact_repaired', artifact_writing_status: 'artifact_repaired', updated_at: new Date().toISOString() }).eq('id', plan.id);
    }

    const log = await insertSessionLog({
      actions_completed: ['repo_artifact_repair', VERSION, `repaired:${repaired.length}`],
      decisions_made: repaired,
      pending_tasks: ['Rerun repo-validation-run for repaired plans.'],
      next_recommendation: 'Rerun validation. If passed, create the GitHub repo.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { repaired_artifacts: repaired.length }, repaired, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
