import OpenAI from 'openai';
import { assertAuthorized, optionalEnv, requiredEnv } from '../../../lib/env';
import { parseModelJson } from '../../../lib/model-router';
import { supabaseAdmin, insertSessionLog } from '../../../lib/supabase';

const VERSION = 'launch-content-from-repo-v1';

function client() {
  const baseURL = optionalEnv('OPENAI_BASE_URL');
  return new OpenAI({ apiKey: requiredEnv('OPENAI_API_KEY'), baseURL: baseURL || undefined });
}

function asArray(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function cleanText(value: any) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function qualityThread(items: string[]) {
  const reasons: string[] = [];
  if (items.length < 5 || items.length > 8) reasons.push('thread_should_be_5_to_8_items');
  if (items.some((x) => x.length > 280)) reasons.push('thread_item_over_280_chars');
  if (items.some((x) => /^thread\b|^🧵/i.test(x))) reasons.push('generic_thread_opener');
  if (items.some((x) => /what do you think|share your thoughts|rt if/i.test(x))) reasons.push('generic_engagement_bait');
  if (!items.some((x) => /github\.com\//i.test(x))) reasons.push('missing_repo_link');
  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
}

function qualitySingle(text: string) {
  const reasons: string[] = [];
  if (!text || text.length < 80) reasons.push('too_short');
  if (text.length > 280) reasons.push('over_280_chars');
  if (!/github\.com\//i.test(text)) reasons.push('missing_repo_link');
  if (/what do you think|share your thoughts|rt if/i.test(text)) reasons.push('generic_engagement_bait');
  if (/revolutionize|cutting-edge|game-changing|unlock/i.test(text)) reasons.push('generic_ai_voice');
  return { status: reasons.length ? 'needs_review' : 'ready', reasons };
}

export async function GET(req: Request) { return run(req); }
export async function POST(req: Request) { return run(req); }

async function run(req: Request) {
  try {
    assertAuthorized(req);
    const supabase = supabaseAdmin();
    const url = new URL(req.url);
    const repoId = url.searchParams.get('repo_id');
    const fullName = url.searchParams.get('repo');

    let repoQuery = supabase
      .from('owned_repo_projects')
      .select('*')
      .eq('test_status', 'post_push_validated')
      .order('created_at', { ascending: false })
      .limit(1);
    if (repoId) repoQuery = repoQuery.eq('id', repoId);
    if (fullName) repoQuery = repoQuery.eq('github_full_name', fullName);
    const { data: repos, error: repoError } = await repoQuery;
    if (repoError) throw repoError;
    if (!repos?.length) return Response.json({ ok: true, version: VERSION, inserted: { cards: 0 }, note: 'No post-push validated repo found.' });

    const repo = repos[0];
    const [planRes, artifactsRes, viralRes, learningRulesRes, recentCardsRes] = await Promise.all([
      supabase.from('repo_build_plans').select('*').eq('repo_creation_decision_id', repo.repo_creation_decision_id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('repo_build_artifacts').select('artifact_path, artifact_purpose, content_summary, generated_content').order('artifact_path', { ascending: true }).limit(40),
      supabase.from('viral_account_patterns').select('*').order('confidence_score', { ascending: false }).limit(20),
      supabase.from('system_learning_rules').select('*').eq('status', 'active').order('confidence_score', { ascending: false }).limit(30),
      supabase.from('content_production_cards').select('*').order('created_at', { ascending: false }).limit(20)
    ]);

    const plan = planRes.data || null;
    const artifacts = (artifactsRes.data || []).filter((a: any) => JSON.stringify(a).toLowerCase().includes(String(repo.github_full_name.split('/')[1] || '').toLowerCase()) || ['README.md','package.json','examples/sample-piece.ts','docs/UX-guidelines.md'].includes(a.artifact_path));

    const prompt = `Create launch content for an English X account @${optionalEnv('X_USERNAME', '30piq')}.
Niche: AI x Productivity x Career Growth.
Repo: ${repo.repo_url}
Repo name: ${repo.github_full_name}
Repo type: ${repo.repo_type}
Goal: announce the repo without sounding promotional or robotic. Make it useful even if people do not click.
Rules:
- English only.
- No generic marketing words.
- Use a concrete problem-first hook.
- Mention the repo link once.
- Do not claim broad adoption or results.
- Prefer practical builder/developer framing.
Return JSON only:
{"single_post":"...","thread_items":["..."],"why_this_should_work":"...","target_audience":"...","viral_mechanic":"...","repo_value":"..."}
BuildPlan=${JSON.stringify(plan)}
Artifacts=${JSON.stringify(artifacts.map((a: any) => ({ path: a.artifact_path, purpose: a.artifact_purpose, summary: a.content_summary, excerpt: String(a.generated_content || '').slice(0, 1200) })))}
ViralPatterns=${JSON.stringify(viralRes.data || [])}
SystemLearningRules=${JSON.stringify(learningRulesRes.data || [])}
RecentCards=${JSON.stringify(recentCardsRes.data || [])}`;

    const completion = await client().chat.completions.create({
      model: optionalEnv('OPENAI_MODEL', 'gpt-4.1-mini'),
      temperature: 0.12,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Generate practical X launch content for a GitHub repo. JSON only.' },
        { role: 'user', content: prompt }
      ]
    });

    const raw = parseModelJson(completion.choices[0]?.message?.content || '');
    const single = cleanText(raw.single_post);
    const threadItems = asArray(raw.thread_items).map(cleanText).filter(Boolean);
    const singleQuality = qualitySingle(single);
    const threadQuality = qualityThread(threadItems);
    const cards: any[] = [];

    const { data: singleCard, error: singleError } = await supabase.from('content_production_cards').insert({
      production_type: 'single_tweet',
      final_text: single,
      thread_items: [],
      source_urls: [repo.repo_url],
      viral_mechanic: raw.viral_mechanic || 'problem-first repo launch',
      original_angle: raw.repo_value || 'small practical repo built from observed workflow pain',
      audience_pain: raw.target_audience || 'builders need safe, testable automation pieces',
      algorithm_basis: 'Repo launch content tied to useful artifact and bookmarkable technical value.',
      source_basis: `Owned repo: ${repo.repo_url}`,
      format_basis: 'Single post for direct launch and link click measurement.',
      quality_basis: raw.why_this_should_work || null,
      quality_status: singleQuality.status,
      quality_reasons: singleQuality.reasons,
      publish_status: singleQuality.status,
      status: singleQuality.status === 'ready' ? 'ready' : 'needs_review'
    }).select('*').single();
    if (singleError) throw singleError;
    cards.push(singleCard);

    const { data: threadCard, error: threadError } = await supabase.from('content_production_cards').insert({
      production_type: 'thread',
      final_text: null,
      thread_items: threadItems,
      source_urls: [repo.repo_url],
      viral_mechanic: raw.viral_mechanic || 'problem-first repo launch thread',
      original_angle: raw.repo_value || 'show the practical repo value through a small builder story',
      audience_pain: raw.target_audience || 'builders need safe, testable automation pieces',
      algorithm_basis: 'Thread gives context, concrete files, and repo link for higher bookmark value.',
      source_basis: `Owned repo: ${repo.repo_url}`,
      format_basis: 'Thread for explaining why the repo exists and what is inside.',
      quality_basis: raw.why_this_should_work || null,
      quality_status: threadQuality.status,
      quality_reasons: threadQuality.reasons,
      publish_status: threadQuality.status,
      status: threadQuality.status === 'ready' ? 'ready' : 'needs_review'
    }).select('*').single();
    if (threadError) throw threadError;
    cards.push(threadCard);

    await supabase.from('repo_publication_events').insert({
      owned_repo_project_id: repo.id,
      platform: 'x',
      published_url: null,
      published_at: null,
      content_type: 'launch_content_prepared',
      content_summary: `Prepared launch content cards: ${cards.map((c) => c.id).join(', ')}`,
      source_content_card_id: cards.find((c) => c.quality_status === 'ready')?.id || cards[0]?.id || null,
      status: 'draft_ready'
    });

    await supabase.from('owned_repo_projects').update({
      content_links: [{ type: 'launch_cards', card_ids: cards.map((c) => c.id), created_at: new Date().toISOString() }],
      updated_at: new Date().toISOString()
    }).eq('id', repo.id);

    const log = await insertSessionLog({
      actions_completed: ['launch_content_from_repo', VERSION, repo.github_full_name, `cards:${cards.length}`],
      content_created: cards,
      db_updates: [{ table: 'content_production_cards', rows: cards.length }, { table: 'repo_publication_events', status: 'draft_ready' }],
      pending_tasks: cards.filter((c) => c.quality_status === 'ready').map((c) => `Manually publish ${c.production_type} for ${repo.github_full_name}`),
      next_recommendation: 'After manual X publish, record the published URL and later capture X/GitHub metrics.'
    });

    return Response.json({ ok: true, version: VERSION, inserted: { cards: cards.length, ready: cards.filter((c) => c.quality_status === 'ready').length }, repo, cards, raw, sessionLog: log });
  } catch (err: any) {
    return Response.json({ ok: false, version: VERSION, error: err.message }, { status: 500 });
  }
}
