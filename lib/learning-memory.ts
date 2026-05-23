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

function normalizeKey(value: string, max = 80) {
  return shortText(value, max).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, max);
}

function classifyMechanism(text: string) {
  const t = text.toLowerCase();
  if (/hook|viral|thread|reply|quote|bookmark|playbook|guide|checklist|engagement question|content format|post structure|tweet format/.test(t)) return {
    type: 'hook',
    key: 'portable_success_mechanic',
    name: 'Portable success mechanic',
    mechanism: 'Extract the success mechanic from any niche and adapt the mechanic, not the topic, to @30piq.',
    structure: ['winning mechanic', 'why it works', '30piq adaptation'],
    risk: 'Can become imitation if wording, topic, or creator framing is copied.'
  };
  if (/comparison|compare|alternatives|top \d+|best .* tools|vs\b/.test(t)) return {
    type: 'bookmark_trigger',
    key: 'decision_filter_comparison',
    name: 'Decision filter comparison',
    mechanism: 'Convert a crowded tool/category comparison into a short decision filter readers can save and reuse.',
    structure: ['category tension', 'selection criteria', 'decision filter'],
    risk: 'Can become listicle-style or shallow if it only names tools without explaining the selection mechanism.'
  };
  if (/github|open source|repo|repository|framework|template|starter|kit/.test(t)) return {
    type: 'structure',
    key: 'open_source_proof_asset',
    name: 'Open-source proof asset angle',
    mechanism: 'Use a real repo as proof for a workflow idea, then translate the repo into a practical operator lesson.',
    structure: ['real repo/source', 'workflow capability', 'operator lesson'],
    risk: 'Can become a raw repo mention if the output does not explain the workflow lesson.'
  };
  if (/mcp|model context protocol|context provider|integration/.test(t)) return {
    type: 'structure',
    key: 'mcp_integration_leverage',
    name: 'MCP integration leverage',
    mechanism: 'Frame MCP or integration tools as a bridge from isolated AI chat to reusable workflow context.',
    structure: ['fragmented tools problem', 'context/integration mechanism', 'workflow leverage'],
    risk: 'Can become jargon if MCP is explained without a concrete work scenario.'
  };
  if (/workflow|automation|agent|agents|operator|process/.test(t)) return {
    type: 'structure',
    key: 'workflow_mechanism_explainer',
    name: 'Workflow mechanism explainer',
    mechanism: 'Explain the workflow mechanism behind a tool or trend instead of praising the tool itself.',
    structure: ['work bottleneck', 'automation mechanism', 'human judgment checkpoint'],
    risk: 'Can sound generic if the bottleneck and checkpoint are not specific.'
  };
  if (/career|job|resume|interview|role|work/.test(t)) return {
    type: 'bookmark_trigger',
    key: 'career_leverage_filter',
    name: 'Career leverage filter',
    mechanism: 'Turn career or job-search AI into a filter for improving decisions, evidence, and repeatable preparation.',
    structure: ['career pain', 'AI-assisted leverage point', 'decision or prep filter'],
    risk: 'Can become generic career advice if it lacks a specific artifact or step.'
  };
  if (/research|study|mit|report|analysis|survey/.test(t)) return {
    type: 'structure',
    key: 'research_to_operator_rule',
    name: 'Research to operator rule',
    mechanism: 'Translate a credible research/source claim into one practical operating rule.',
    structure: ['source-backed observation', 'implication', 'operator rule'],
    risk: 'Can overclaim if the post states research conclusions beyond the source.'
  };
  return null;
}

function shouldLearnStyle(text: string) {
  return /hook|viral|thread|reply|quote|bookmark|checklist|framework|playbook|guide|quality|workflow|automation|agent|mcp|github|open source|career|job|research|tools|comparison|template|operator/i.test(text);
}

function isSourceOnlyPatternName(name: string, title: string) {
  const n = normalizeKey(name, 120);
  const t = normalizeKey(title, 120);
  if (!n || !t) return false;
  return n.includes(t.slice(0, 50)) || /github_com|www_|https_|structure_[a-z0-9]+_[a-z0-9]+/.test(n);
}

export async function learnFromCrawlerItems(supabase: any, input: { runType: string; source: string; items: any[]; mode?: string; }) {
  const mode = input.mode || 'trial';
  let algorithmRules = 0;
  let stylePatterns = 0;
  let mcpOpportunities = 0;
  let rejectedLowQuality = 0;
  const learnedItems: any[] = [];

  for (const item of input.items || []) {
    const title = shortText(item.title || item.topic || item.opportunity_area || 'untitled', 220);
    const url = shortText(item.url || item.source_url || toArray(item.source_urls)[0] || '', 600);
    const summary = shortText(item.summary || item.snippet || item.angle || item.notes || item.daily_run_brief || '', 1000);
    const text = `${title} ${summary}`.toLowerCase();
    const sourceHost = url ? inferSource(url) : input.source;
    const sourceUrl = url || `internal:${input.source}`;
    const mechanism = classifyMechanism(`${title} ${summary}`);

    if (/x algo|algorithm|ranking|reply|bookmark|home mixer|candidate|network reach|shadowban|safety/i.test(text)) {
      const ruleType = /reply/.test(text) ? 'reply' : /bookmark/.test(text) ? 'bookmark' : /safety|shadowban/.test(text) ? 'safety' : /ranking|algorithm|home mixer|candidate/.test(text) ? 'ranking' : 'growth_signal';
      const rule = shortText(`When ${ruleType} signals appear in crawled evidence, convert them into a testable planning or scoring rule before publishing. Source signal: ${mechanism?.mechanism || title}.`, 1000);
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

    if (shouldLearnStyle(text)) {
      if (!mechanism) {
        rejectedLowQuality++;
      } else {
        const patternType = mechanism.type;
        const patternName = mechanism.name;
        if (isSourceOnlyPatternName(patternName, title)) {
          rejectedLowQuality++;
        } else {
          const ok = await insertIfMissing(supabase, 'viral_style_patterns', { pattern_type: patternType, pattern_name: patternName }, {
            pattern_type: patternType,
            pattern_name: patternName,
            pattern_description: mechanism.mechanism,
            example_structure: {
              mechanism_key: mechanism.key,
              structure: mechanism.structure,
              source: input.source,
              source_host: sourceHost,
              source_title: title,
              source_url: sourceUrl,
              transferable_across_niches: true,
              adaptation_rule: 'Learn the success mechanism, not the original niche topic.'
            },
            why_it_works: 'It stores the reusable success mechanism extracted from real crawled evidence, so future content can be original and source-grounded instead of AI-generic.',
            risks: mechanism.risk,
            adaptation_for_30piq: 'Adapt this mechanism to AI x productivity x career growth, MCP workflows, high-value knowledge-worker markets, or proof-asset content. Do not copy the source topic unless it fits the account strategy.',
            source_handles: [],
            source_tweet_urls: url ? [url] : [],
            confidence_score: score(item.confidence_score || item.content_potential_score || item.relevance_score, 7),
            status: 'active',
            test_run: mode !== 'production',
            updated_at: new Date().toISOString()
          });
          if (ok) stylePatterns++;
        }
      }
    }

    if (/mcp|model context protocol|agent|workflow|automation|tool|integration/i.test(text)) {
      const opportunityArea = /mcp|model context protocol/i.test(text) ? 'MCP workflow leverage' : 'AI workflow automation';
      const useCase = mechanism ? `${mechanism.name}: ${title}` : title;
      const ok = await insertIfMissing(supabase, 'mcp_opportunity_map', { opportunity_area: opportunityArea, mcp_use_case: shortText(useCase, 240) }, {
        opportunity_area: opportunityArea,
        mcp_use_case: shortText(useCase, 240),
        audience_segment: 'English-speaking high-value knowledge workers, operators, founders, consultants, and career-focused AI users',
        pain_point: summary || 'Fragmented tools and manual workflows create leverage opportunities for AI-assisted systems.',
        content_angles: [mechanism?.mechanism, title, summary].filter(Boolean).slice(0, 3),
        repo_or_tool_ideas: [],
        monetization_notes: 'Evaluate for US/UK/Canada/Australia and other high-value English markets before turning into content or proof assets. Use the mechanism, not only the source title.',
        proof_required: url ? [url] : [],
        priority_score: score(item.priority_score || item.content_potential_score || item.relevance_score, 7),
        confidence_score: score(item.confidence_score || item.relevance_score, 7),
        status: 'active',
        test_run: mode !== 'production',
        updated_at: new Date().toISOString()
      });
      if (ok) mcpOpportunities++;
    }

    learnedItems.push({ title, url: sourceUrl, source_host: sourceHost, mechanism: mechanism?.key || null });
  }

  const summary = `Crawler learning ${input.runType}: ${algorithmRules} algorithm rules, ${stylePatterns} style patterns, ${mcpOpportunities} MCP opportunities, ${rejectedLowQuality} rejected low-quality memories.`;
  const run = await supabase.from('growth_learning_runs').insert({
    run_type: input.runType,
    mode,
    summary,
    evidence: { source: input.source, learned_items: learnedItems.slice(0, 30), counts: { algorithmRules, stylePatterns, mcpOpportunities, rejectedLowQuality }, memory_rule: 'Store mechanisms, not raw source titles. Learn success mechanics across niches, then adapt them to @30piq.' },
    status: 'completed',
    test_run: mode !== 'production',
    updated_at: new Date().toISOString()
  }).select('*').single();
  if (run.error) throw run.error;
  return { run: run.data, algorithmRules, stylePatterns, mcpOpportunities, rejectedLowQuality };
}
