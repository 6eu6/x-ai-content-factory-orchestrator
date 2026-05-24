import { assertAuthorized } from '../../../lib/env';
import { createGitHubRepo } from '../../../lib/github';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

export async function POST(req: Request) {
  try {
    assertAuthorized(req);
    const body = await req.json();
    const repo = await createGitHubRepo({
      name: body.name,
      description: body.description,
      private: body.private,
      readme: body.readme
    });
    const supabase = supabaseAdmin();
    const { data, error } = await supabase.from('github_repos').insert({
      repo_name: repo.name,
      repo_url: repo.html_url,
      repo_purpose: body.purpose || body.description || 'Supporting asset for X AI Content Factory',
      repo_type: body.repo_type || 'supporting_asset',
      status: 'created',
      created_by_ai_tool: 'orchestrator',
      notes: 'Created through orchestrator API.'
    }).select('*').single();
    if (error) throw error;
    await insertSessionLog({ actions_completed: ['created_github_repo'], github_updates: [repo.html_url], db_updates: [{ table: 'github_repos', id: data.id }] });
    return Response.json({ ok: true, repo, db: data });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
