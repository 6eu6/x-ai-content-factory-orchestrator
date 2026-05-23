import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'repo-style-learn-v1';

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

function score(value: any, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const scaled = n > 0 && n <= 1 ? n * 10 : n;
  return Math.min(10, Math.max(1, Math.round(scaled)));
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 5), 1), 10);

    const { data: repos, error: reposError } = await supabase
      .from('repo_sources')
      .select('*')
      .eq('status', 'analyzed')
      .order('content_potential_score', { ascending: false })
      .limit(limit);
    if (reposError) throw reposError;
    if (!repos?.length) return Response.json({ ok: true, version: VERSION, inserted: { templates: 0 }, note: 'No analyzed repo sources found.' });

    const repoIds = repos.map((r: any) => r.id);
    const { data: files } = await supabase
      .from('repo_source_files')
      .select('*')
      .in('repo_source_id', repoIds)
      .order('file_role', { ascending: true })
      .limit(80);

    const prompt = `You are learning reusable GitHub repository style templates from source repos.
Goal: extract structure and writing patterns, not copy text.
Create templates that help future repos avoid robotic writing and README-only shells.
Return strict JSON:
{"templates":[{"repo_source_id":"...","template_name":"...","repo_type":"tool|guide|playbook|framework|template|docs","style_purpose":"...","structure_pattern":{},"readme_pattern":{},"file_pattern":[{"path_pattern":"...","purpose":"...","when_needed":"..."}],"voice_rules":["..."],"anti_patterns":["..."],"evidence_paths":["..."],"confidence_score":1}]}
Repos=${JSON.stringify(repos)}
Files=${JSON.stringify(files || [])}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.04,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Extract repo style templates. Do not copy source wording. JSON only.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = JSON.parse(completion.choices[0]?.message?.content || '{}');
    const templates = asArray(raw.templates).slice(0, 20);
    let inserted = 0;
    for (const template of templates) {
      const { error } = await supabase.from('repo_style_templates').upsert({
        repo_source_id: template.repo_source_id || null,
        template_name: String(template.template_name || 'repo-style-template').slice(0, 120),
        repo_type: template.repo_type || 'guide',
        style_purpose: template.style_purpose || null,
        structure_pattern: template.structure_pattern || {},
        readme_pattern: template.readme_pattern || {},
        file_pattern: asArray(template.file_pattern),
        voice_rules: asArray(template.voice_rules),
        anti_patterns: asArray(template.anti_patterns),
        evidence_paths: asArray(template.evidence_paths),
        confidence_score: score(template.confidence_score, 7),
        status: 'active',
        updated_at: new Date().toISOString()
      }, { onConflict: 'template_name,repo_type' });
      if (!error) inserted++;
    }

    const log = await insertSessionLog({
      actions_completed: ['repo_style_learn', VERSION, `templates:${inserted}`],
      decisions_made: templates,
      pending_tasks: ['Use repo_style_templates in repo-artifact-writer.'],
      next_recommendation: 'Run repo-artifact-writer after style templates exist.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { templates: inserted }, templates, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
