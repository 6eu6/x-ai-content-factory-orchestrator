import { supabaseAdmin } from '../../../lib/supabase';

/**
 * Brain Viewer API — صفحة ويب تعرض محتويات العقل بتنسيق جميل
 *
 * بدل ما نرسل كل شيء في تلقرام (اللي يفشل بسبب الحد الأقصى للرسالة),
 * نرسل رابط لهالصفحة.
 *
 * GET /api/brain-viewer
 * GET /api/brain-viewer?format=json — بيانات خام JSON
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const format = url.searchParams.get('format');

    const supabase = supabaseAdmin();

    // ═══ جلب كل البيانات ═══

    // 1. القواعد الخوارزمية
    const { data: algoRules } = await supabase
      .from('x_algorithm_learning_rules')
      .select('*')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(100);

    // 2. أنماط الأسلوب
    const { data: stylePatterns } = await supabase
      .from('viral_style_patterns')
      .select('*')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(50);

    // 3. فرص MCP
    const { data: mcpOpps } = await supabase
      .from('mcp_opportunity_map')
      .select('*')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(20);

    // 4. قواعد النظام
    const { data: sysRules } = await supabase
      .from('system_learning_rules')
      .select('*')
      .eq('status', 'active')
      .order('confidence_score', { ascending: false })
      .limit(30);

    // 5. Working Memory
    const { data: workingMemory } = await supabase
      .from('working_memory')
      .select('*')
      .order('confidence_score', { ascending: false })
      .limit(20);

    // 6. Anti-patterns
    const { data: antiPatterns } = await supabase
      .from('x_algorithm_learning_rules')
      .select('*')
      .eq('status', 'anti_pattern')
      .order('confidence_score', { ascending: false })
      .limit(20);

    const data = {
      algorithm_rules: algoRules || [],
      style_patterns: stylePatterns || [],
      mcp_opportunities: mcpOpps || [],
      system_rules: sysRules || [],
      working_memory: workingMemory || [],
      anti_patterns: antiPatterns || [],
      generated_at: new Date().toISOString()
    };

    // ═══ JSON format ═══
    if (format === 'json') {
      return Response.json(data);
    }

    // ═══ HTML format — صفحة ويب جميلة ═══
    const html = buildBrainHtml(data);
    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8' }
    });
  } catch (err: any) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

// ═══ بناء صفحة HTML ═══

function buildBrainHtml(data: any): string {
  const algoRules: any[] = data.algorithm_rules;
  const stylePatterns: any[] = data.style_patterns;
  const mcpOpps: any[] = data.mcp_opportunities;
  const sysRules: any[] = data.system_rules;
  const workingMemory: any[] = data.working_memory;
  const antiPatterns: any[] = data.anti_patterns;

  // تجميع القواعد حسب النوع
  const byType: Record<string, any[]> = {};
  for (const r of algoRules) {
    const t = r.rule_type || 'unknown';
    if (!byType[t]) byType[t] = [];
    byType[t].push(r);
  }

  const typeLabels: Record<string, string> = {
    'precise_concept': '🎯 Precise Concepts',
    'psychological_trigger': '🧠 Psychological Triggers',
    'viral_pattern': '🔥 Viral Patterns',
    'media_impact': '🎬 Media Impact',
    'conversation_context': '💬 Conversation Context',
    'viral_concept': '⚡ Viral Concepts',
    'ranking': '📈 Ranking',
    'reply': '↩️ Reply',
    'bookmark': '🔖 Bookmark',
    'safety': '🛡️ Safety'
  };

  const typeColors: Record<string, string> = {
    'precise_concept': '#3b82f6',
    'psychological_trigger': '#8b5cf6',
    'viral_pattern': '#ef4444',
    'media_impact': '#f59e0b',
    'conversation_context': '#10b981',
    'viral_concept': '#ec4899',
    'ranking': '#6366f1',
    'reply': '#14b8a6',
    'bookmark': '#f97316',
    'safety': '#64748b'
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🧩 Brain Contents — X AI Content Factory</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a;
      color: #e2e8f0;
      line-height: 1.6;
      padding: 20px;
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 { font-size: 28px; margin-bottom: 8px; color: #f8fafc; }
    h2 { font-size: 22px; margin: 32px 0 16px; color: #f1f5f9; border-bottom: 2px solid #334155; padding-bottom: 8px; }
    h3 { font-size: 18px; margin: 20px 0 12px; color: #cbd5e1; }
    .meta { color: #94a3b8; font-size: 14px; margin-bottom: 24px; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 32px;
    }
    .stat-card {
      background: #1e293b;
      border-radius: 12px;
      padding: 16px;
      text-align: center;
      border: 1px solid #334155;
    }
    .stat-card .num { font-size: 32px; font-weight: 700; color: #60a5fa; }
    .stat-card .label { font-size: 13px; color: #94a3b8; margin-top: 4px; }
    .section-group { margin-bottom: 24px; }
    .type-header {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      padding: 10px 16px;
      background: #1e293b;
      border-radius: 8px;
      border-left: 4px solid var(--type-color, #3b82f6);
    }
    .type-header .count {
      background: #334155;
      padding: 2px 10px;
      border-radius: 12px;
      font-size: 13px;
      color: #cbd5e1;
    }
    .rule-card {
      background: #1e293b;
      border-radius: 10px;
      padding: 14px 18px;
      margin-bottom: 10px;
      border: 1px solid #334155;
      transition: border-color 0.2s;
    }
    .rule-card:hover { border-color: #475569; }
    .rule-card .rule-text { color: #f1f5f9; font-size: 15px; margin-bottom: 6px; }
    .rule-card .evidence { color: #94a3b8; font-size: 13px; font-style: italic; }
    .rule-card .meta-line { display: flex; gap: 16px; margin-top: 6px; font-size: 12px; color: #64748b; }
    .confidence-bar {
      display: inline-block;
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(90deg, #ef4444 0%, #f59e0b 50%, #10b981 100%);
      vertical-align: middle;
      margin-right: 6px;
    }
    .pattern-card {
      background: #1e293b;
      border-radius: 10px;
      padding: 14px 18px;
      margin-bottom: 10px;
      border: 1px solid #334155;
      border-left: 4px solid #8b5cf6;
    }
    .pattern-card .name { color: #c4b5fd; font-weight: 600; font-size: 15px; }
    .pattern-card .desc { color: #e2e8f0; font-size: 14px; margin-top: 4px; }
    .pattern-card .why { color: #86efac; font-size: 13px; margin-top: 4px; }
    .pattern-card .adaptation { color: #93c5fd; font-size: 13px; margin-top: 4px; }
    .anti-card {
      background: #1c1017;
      border-radius: 10px;
      padding: 14px 18px;
      margin-bottom: 10px;
      border: 1px solid #7f1d1d;
      border-left: 4px solid #ef4444;
    }
    .anti-card .rule-text { color: #fca5a5; }
    .empty { color: #64748b; text-align: center; padding: 40px; font-style: italic; }
    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-active { background: #065f46; color: #6ee7b7; }
    .badge-anti { background: #7f1d1d; color: #fca5a5; }
    .filter-bar {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .filter-btn {
      padding: 6px 14px;
      border-radius: 20px;
      border: 1px solid #475569;
      background: #1e293b;
      color: #cbd5e1;
      cursor: pointer;
      font-size: 13px;
      transition: all 0.2s;
    }
    .filter-btn:hover { background: #334155; }
    .filter-btn.active { background: #3b82f6; border-color: #3b82f6; color: white; }
    @media (max-width: 600px) {
      body { padding: 12px; }
      h1 { font-size: 22px; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <h1>🧩 Brain Contents</h1>
  <p class="meta">X AI Content Factory — Generated ${new Date(data.generated_at).toLocaleString()}</p>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="num">${algoRules.length}</div>
      <div class="label">Algorithm Rules</div>
    </div>
    <div class="stat-card">
      <div class="num">${stylePatterns.length}</div>
      <div class="label">Style Patterns</div>
    </div>
    <div class="stat-card">
      <div class="num">${sysRules.length}</div>
      <div class="label">System Rules</div>
    </div>
    <div class="stat-card">
      <div class="num">${mcpOpps.length}</div>
      <div class="label">MCP Opportunities</div>
    </div>
    <div class="stat-card">
      <div class="num">${workingMemory.length}</div>
      <div class="label">Working Memory</div>
    </div>
    <div class="stat-card">
      <div class="num">${antiPatterns.length}</div>
      <div class="label">Anti-Patterns</div>
    </div>
  </div>

  ${algoRules.length > 0 ? `
  <h2>📊 Algorithm Rules</h2>
  <div class="filter-bar">
    <button class="filter-btn active" onclick="filterRules('all')">All (${algoRules.length})</button>
    ${Object.entries(byType).map(([type, rules]) =>
      `<button class="filter-btn" onclick="filterRules('${type}')">${typeLabels[type] || type} (${rules.length})</button>`
    ).join('')}
  </div>
  <div id="rules-container">
    ${Object.entries(byType).map(([type, rules]) => `
    <div class="section-group" data-type="${type}">
      ${rules.map((r: any) => {
        const conf = Number(r.confidence_score || 0);
        const barWidth = Math.round(conf * 10);
        const barColor = conf >= 7 ? '#10b981' : conf >= 4 ? '#f59e0b' : '#ef4444';
        return `
      <div class="rule-card">
        <div class="rule-text">${esc(r.rule || '')}</div>
        ${r.evidence ? `<div class="evidence">→ ${esc(String(r.evidence).slice(0, 200))}</div>` : ''}
        <div class="meta-line">
          <span><span class="confidence-bar" style="width:${barWidth * 1.5}px;background:${barColor}"></span> ${conf.toFixed(1)}/10</span>
          <span>Applies to: ${esc(r.applies_to || 'general')}</span>
          <span>Source: ${esc(r.source_type || 'unknown')}</span>
        </div>
      </div>`;
      }).join('')}
    </div>
    `).join('')}
  </div>
  ` : '<div class="empty">No algorithm rules learned yet. Run 🧠 Full Pipeline to start learning.</div>'}

  ${stylePatterns.length > 0 ? `
  <h2>✍️ Style Patterns</h2>
  ${stylePatterns.map((p: any) => {
    const conf = Number(p.confidence_score || 0);
    const barWidth = Math.round(conf * 10);
    return `
  <div class="pattern-card">
    <div class="name">${esc(p.pattern_name || 'Unnamed Pattern')}</div>
    <div class="desc">${esc(p.pattern_description || '')}</div>
    ${p.why_it_works ? `<div class="why">💡 ${esc(String(p.why_it_works).slice(0, 200))}</div>` : ''}
    ${p.adaptation_for_30piq ? `<div class="adaptation">🎯 Adaptation: ${esc(String(p.adaptation_for_30piq).slice(0, 200))}</div>` : ''}
    <div class="meta-line">
      <span><span class="confidence-bar" style="width:${barWidth * 1.5}px;background:${conf >= 7 ? '#10b981' : conf >= 4 ? '#f59e0b' : '#ef4444'}"></span> ${conf.toFixed(1)}/10</span>
      <span>Type: ${esc(p.pattern_type || 'unknown')}</span>
    </div>
  </div>`;
  }).join('')}
  ` : ''}

  ${sysRules.length > 0 ? `
  <h2>⚙️ System Rules (Causal Learning)</h2>
  ${sysRules.map((s: any) => {
    const conf = Number(s.confidence_score || 0);
    return `
  <div class="rule-card" style="border-left: 4px solid #6366f1;">
    <div class="rule-text">${esc(s.rule || '')}</div>
    ${s.evidence ? `<div class="evidence">→ ${esc(String(s.evidence).slice(0, 200))}</div>` : ''}
    <div class="meta-line">
      <span><span class="confidence-bar" style="width:${Math.round(conf * 10) * 1.5}px;background:${conf >= 7 ? '#10b981' : conf >= 4 ? '#f59e0b' : '#ef4444'}"></span> ${conf.toFixed(1)}/10</span>
      <span>Type: ${esc(s.rule_type || 'unknown')}</span>
    </div>
  </div>`;
  }).join('')}
  ` : ''}

  ${mcpOpps.length > 0 ? `
  <h2>🛠️ MCP Opportunities</h2>
  ${mcpOpps.map((m: any) => `
  <div class="rule-card" style="border-left: 4px solid #f59e0b;">
    <div class="rule-text">${esc(m.opportunity_area || '')}</div>
    ${m.mcp_use_case ? `<div class="evidence">→ ${esc(String(m.mcp_use_case).slice(0, 200))}</div>` : ''}
    <div class="meta-line">
      <span>Confidence: ${Number(m.confidence_score || 0).toFixed(1)}/10</span>
    </div>
  </div>
  `).join('')}
  ` : ''}

  ${workingMemory.length > 0 ? `
  <h2>🧠 Working Memory (High Confidence Only)</h2>
  ${workingMemory.map((w: any) => `
  <div class="rule-card" style="border-left: 4px solid #06b6d4;">
    <div class="rule-text">${esc(w.memory_type || '')} — ${esc(w.source_table || '')}</div>
    ${w.content ? `<div class="evidence">→ ${esc(JSON.stringify(w.content).slice(0, 200))}</div>` : ''}
    <div class="meta-line">
      <span>Confidence: ${Number(w.confidence_score || 0).toFixed(1)}/10</span>
      <span>Last accessed: ${w.last_accessed_at ? new Date(w.last_accessed_at).toLocaleDateString() : 'N/A'}</span>
    </div>
  </div>
  `).join('')}
  ` : ''}

  ${antiPatterns.length > 0 ? `
  <h2>🚫 Anti-Patterns (Avoid)</h2>
  ${antiPatterns.map((a: any) => `
  <div class="anti-card">
    <div class="rule-text">${esc(a.rule || '')}</div>
    ${a.evidence ? `<div class="evidence" style="color:#fca5a5;">⚠ ${esc(String(a.evidence).slice(0, 200))}</div>` : ''}
    <div class="meta-line">
      <span class="badge badge-anti">ANTI-PATTERN</span>
      <span>Confidence: ${Number(a.confidence_score || 0).toFixed(1)}/10</span>
    </div>
  </div>
  `).join('')}
  ` : ''}

  <div style="margin-top:48px; padding:16px; background:#1e293b; border-radius:10px; border:1px solid #334155;">
    <h2 style="border:none; margin:0 0 12px; padding:0;">🤖 How AI Applies Brain Learning</h2>
    <div style="font-size:14px; color:#94a3b8; line-height:1.8;">
      <p><strong style="color:#e2e8f0;">When creating a Tweet:</strong> Takes top 5 algorithm rules + top 3 style patterns → injects them into the generation prompt with APPLICATION INSTRUCTIONS</p>
      <p><strong style="color:#e2e8f0;">When creating a Thread:</strong> Takes top 5 algorithm rules + top 5 style patterns → builds thread on learned foundation</p>
      <p><strong style="color:#e2e8f0;">When creating Reply/Quote:</strong> Takes top rules for engagement_crafting → crafts replies following proven mechanics</p>
      <p><strong style="color:#e2e8f0;">When analyzing performance:</strong> Links rules to actual outcomes → boosts confidence of winning rules → decays losing rules → extracts causal rules</p>
    </div>
  </div>

  <p style="text-align:center; color:#475569; font-size:12px; margin-top:32px;">
    X AI Content Factory — Brain Viewer v1.0
  </p>

  <script>
    function filterRules(type) {
      const groups = document.querySelectorAll('.section-group');
      const btns = document.querySelectorAll('.filter-btn');

      btns.forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');

      if (type === 'all') {
        groups.forEach(g => g.style.display = 'block');
      } else {
        groups.forEach(g => {
          g.style.display = g.dataset.type === type ? 'block' : 'none';
        });
      }
    }
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
