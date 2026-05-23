export function shortText(value: any, max = 900) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function toArray(value: any) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'object') return Object.values(value);
  return [value];
}

function score(value: any, fallback = 7) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(10, Math.max(1, Math.round(n)));
}

async function insertIfMissing(supabase: any, table: string, where: Record<string, any>, payload: Record<string, any>) {
  let query = supabase.from(table).select('id').limit(1);
  for (const [key, val] of Object.entries(where)) query = val == null ? query.is(key, null) : query.eq(key, val);
  const existing = await query.maybeSingle();
  if (existing.data?.id) return false;
  const inserted = await supabase.from(table).insert(payload).select('id').single();
  if (inserted.error) throw inserted.error;
  return true;
}

function inferSource(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'unknown'; }
}

export async function learnFromCrawlerItems(supabase: any, input: { runType: string; source: string; items: any[]; mode?: string; }) {
  const mode = input.mode || 'trial';
  let algorithmRules = 0;
  let stylePatterns = 0;
  let mcpOpportunities = 0;
  const learnedItems: any[] = [];

  for (const item of input.items || []) {
    const title = shortText(item.title || item.topic || item.opportunity_area || 'untitled', 220);
    const url = shortText(item.url || item.source_url || toArray(item.source_urls)[0] || '', 600);
    const summary = shortText(item.summary || item.snippet || item.angle || item.notes || item.daily_run_brief || '', 1000);
    const text = `${title} ${summary}`.toLowerCase();
    const sourceHost = url ? inferSource(url) : input.source;
    const sourceUrl = url || `internal:${input.source}`;

    if (/x algo|algorithm|ranking|reply|bookmark|home mixer|candidate|network reach|shadowban|safety/i.test(text)) {
      const ruleType = /reply/.test(text) ? 'reply' : /bookmark/.test(text) ? 'bookmark' : /safety|shadowban/.test(text) ? 'safety' : /ranking|algorithm|home mixer|candidate/.test(text) ? 'ranking' : 'growth_signal';
      const rule = shortText(`When planning @30piq content from ${sourceHost}, convert the observed signal into a concrete mechanism before publishing: ${title}.`, 1000);
      const ok = await insertIfMissing(supabase, 'x_algorithm_learning_rules', { rule_type: ruleType, rule }, {
        rule_type: ruleType,
        rule,
        evidence: summary || `Learned from crawler item: ${title}`,
        source_type: input.runType,
        source_url: sourceUrl,
        applies_to: 'crawl_strategy,growth_daily_plan,content_score',
        confidence_score: score(item.confidence_score || item.relevance_score || item.content_potential_score, 7),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      });
      if (ok) algorithmRules++;
    }

    if (/hook|viral|thread|reply|quote|bookmark|checklist|framework|playbook|guide|quality|workflow/i.test(text)) {
      const patternType = /reply/.test(text) ? 'reply_trigger' : /quote/.test(text) ? 'quote_trigger' : /bookmark|checklist|framework|guide/.test(text) ? 'bookmark_trigger' : /hook/.test(text) ? 'hook' : 'structure';
      const patternName = shortText(`${patternType}: ${title}`.toLowerCase(), 150);
      const ok = await insertIfMissing(supabase, 'viral_style_patterns', { pattern_type: patternType, pattern_name: patternName }, {
        pattern_type: patternType,
        pattern_name: patternName,
        pattern_description: shortText(`Use this crawled item as a source-grounded pattern, then rewrite it as an original @30piq angle rather than copying the source: ${summary || title}`, 1200),
        example_structure: { source: input.source, source_host: sourceHost, title },
        why_it_works: 'It is grounded in a real crawled source and can become a specific mechanism, checklist, caveat, or workflow insight.',
        risks: 'Reject if the output becomes generic AI advice, copies source wording, or lacks a concrete mechanism.',
        adaptation_for_30piq: 'Turn into AI x productivity x career growth content with a clear audience pain, especially MCP and high-value knowledge-worker markets when relevant.',
        source_handles: [],
        source_tweet_urls: url ? [url] : [],
        confidence_score: score(item.confidence_score || item.content_potential_score || item.relevance_score, 7),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      });
      if (ok) stylePatterns++;
    }

    if (/mcp|model context protocol|agent|workflow|automation|tool|integration/i.test(text)) {
      const opportunityArea = /mcp|model context protocol/i.test(text) ? 'MCP workflow leverage' : 'AI workflow automation';
      const useCase = shortText(title, 240);
      const ok = await insertIfMissing(supabase, 'mcp_opportunity_map', { opportunity_area: opportunityArea, mcp_use_case: useCase }, {
        opportunity_area: opportunityArea,
        mcp_use_case: useCase,
        audience_segment: 'English-speaking high-value knowledge workers, operators, founders, consultants, and career-focused AI users',
        pain_point: summary || 'Fragmented tools and manual workflows create leverage opportunities for AI-assisted systems.',
        content_angles: [title, summary].filter(Boolean).slice(0, 2),
        repo_or_tool_ideas: [],
        monetization_notes: 'Evaluate for US/UK/Canada/Australia and other high-value English markets before turning into content or proof assets.',
        proof_required: url ? [url] : [],
        priority_score: score(item.priority_score || item.content_potential_score || item.relevance_score, 7),
        confidence_score: score(item.confidence_score || item.relevance_score, 7),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      });
      if (ok) mcpOpportunities++;
    }

    learnedItems.push({ title, url: sourceUrl, source_host: sourceHost });
  }

  const summary = `Crawler learning ${input.runType}: ${algorithmRules} algorithm rules, ${stylePatterns} style patterns, ${mcpOpportunities} MCP opportunities.`;
  const run = await supabase.from('growth_learning_runs').insert({
    run_type: input.runType,
    mode,
    summary,
    evidence: { source: input.source, learned_items: learnedItems.slice(0, 30), counts: { algorithmRules, stylePatterns, mcpOpportunities } },
    status: 'completed',
    test_run: mode !== 'production',
    updated_at: new Date().toISOString()
  }).select('*').single();
  if (run.error) throw run.error;
  return { run: run.data, algorithmRules, stylePatterns, mcpOpportunities };
}
