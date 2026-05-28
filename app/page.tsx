export default function Home() {
  const routes = [
    { path: '/api/health', method: 'GET', desc: 'System health check (public, no secret required)', public: true },
    { path: '/api/db-setup', method: 'GET', desc: 'Check/create database tables' },
    { path: '/api/check-account', method: 'GET', desc: 'Check @30piq account status' },
    { path: '/api/daily-run', method: 'GET/POST', desc: 'Main daily orchestrator' },
    { path: '/api/model-router', method: 'GET/POST/DELETE', desc: 'Manage model routing rules' },
    { path: '/api/shield-check', method: 'POST', desc: 'Content protection check (11 checks)' },
    { path: '/api/format-decision', method: 'GET/POST', desc: 'Select optimal content format' },
    { path: '/api/production-cycle', method: 'GET/POST', desc: 'Generate production cards' },
    { path: '/api/generate-media', method: 'POST', desc: 'Generate media (images, carousel)' },
    { path: '/api/publish-pack', method: 'POST', desc: 'Prepare and deliver content pack' },
    { path: '/api/account-performance-scan', method: 'GET', desc: 'Account performance scan with causal learning' },
    { path: '/api/learning-cycle', method: 'GET/POST', desc: 'Smart learning cycle (research + viral)' },
    { path: '/api/weekly-review', method: 'GET', desc: 'Weekly review' },
    { path: '/api/viral-account-scan', method: 'GET/POST', desc: 'Deep viral account analysis' },
    { path: '/api/viral-discovery-run', method: 'GET/POST', desc: 'Automatic viral discovery' },
    { path: '/api/research-intel-v4', method: 'GET', desc: 'Advanced source-based research' },
    { path: '/api/research-intel-run', method: 'GET/POST', desc: 'Run source-based research' },
    { path: '/api/discovery-run', method: 'GET', desc: 'GitHub + web discovery' },
    { path: '/api/memory-maintenance-run', method: 'GET', desc: 'Educational memory maintenance' },
    { path: '/api/growth-learning-run', method: 'GET/POST', desc: 'Growth learning' },
    { path: '/api/learning-reflection-run', method: 'GET/POST', desc: 'Self-reflection' },
    { path: '/api/log-user-action', method: 'POST', desc: 'Log user actions' },
    { path: '/api/github-create-repo', method: 'POST', desc: 'Create GitHub repository' },
    { path: '/api/debug-twitterapi', method: 'GET', desc: 'Diagnose TwitterAPI' },
    { path: '/api/system-cleanup', method: 'POST', desc: 'Clean up experimental data' },
  ];

  const repoRoutes = [
    { path: '/api/repo-ingest', method: 'GET/POST', desc: 'Ingest GitHub repository' },
    { path: '/api/repo-deep-learn', method: 'GET/POST', desc: 'Deep learn from repository' },
    { path: '/api/repo-deep-learn-excerpt', method: 'GET/POST', desc: 'Deep learn from excerpts' },
    { path: '/api/repo-style-learn', method: 'GET/POST', desc: 'Learn repository style' },
    { path: '/api/repo-build-planner', method: 'GET/POST', desc: 'Repository build planner' },
    { path: '/api/repo-artifact-writer', method: 'GET/POST', desc: 'Write repository files' },
    { path: '/api/repo-artifact-repair', method: 'GET/POST', desc: 'Repair repository files' },
    { path: '/api/repo-validation-run', method: 'GET', desc: 'Validate repository' },
    { path: '/api/repo-post-push-validation', method: 'GET', desc: 'Post-push validation' },
    { path: '/api/repo-create-and-push', method: 'POST', desc: 'Create and push repository' },
    { path: '/api/repo-investment-run', method: 'GET', desc: 'Evaluate repository investment' },
    { path: '/api/launch-content-from-repo', method: 'GET/POST', desc: 'Launch content from repository' },
    { path: '/api/launch-content-repair', method: 'GET/POST', desc: 'Repair launch content' },
    { path: '/api/launch-content-repair-strict', method: 'GET/POST', desc: 'Strict repair' },
    { path: '/api/launch-content-repair-v2', method: 'GET/POST', desc: 'Repair v2' },
  ];

  const telegramRoutes = [
    { path: '/api/telegram/webhook', method: 'POST', desc: 'Bot command handler (12+ Arabic commands)' },
    { path: '/api/telegram/setup', method: 'GET', desc: 'Setup Telegram Webhook' },
  ];

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '32px auto', padding: 24, lineHeight: 1.7, color: '#1a1a1a' }}>
      <div style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 13, opacity: 0.6, margin: 0 }}>X AI Content Factory</p>
        <h1 style={{ fontSize: 36, margin: '4px 0 12px', fontWeight: 700 }}>Orchestrator</h1>
        <p style={{ fontSize: 16, opacity: 0.85, maxWidth: 640 }}>
          Automated system for growing the @30piq Twitter account in the AI x Productivity x Career Growth niche.
          Content is delivered via Telegram — publishing is always manual.
        </p>
      </div>

      <h2 style={{ fontSize: 20, borderBottom: '2px solid #e5e7eb', paddingBottom: 8 }}>API Routes — {routes.length + repoRoutes.length + telegramRoutes.length} endpoints</h2>

      <h3 style={{ fontSize: 16, marginTop: 24, color: '#0369a1' }}>Core Routes</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '6px 12px' }}>Method</th>
            <th style={{ padding: '6px 12px' }}>Path</th>
            <th style={{ padding: '6px 12px' }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((r) => (
            <tr key={r.path} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '6px 12px' }}><code style={{ fontSize: 12, background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>{r.method}</code></td>
              <td style={{ padding: '6px 12px' }}><code style={{ fontSize: 13, color: '#7c3aed' }}>{r.path}</code>{r.public && <span style={{ fontSize: 11, background: '#dcfce7', color: '#166534', padding: '1px 6px', borderRadius: 4, marginLeft: 6 }}>public</span>}</td>
              <td style={{ padding: '6px 12px', color: '#555' }}>{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ fontSize: 16, marginTop: 24, color: '#0369a1' }}>Repo Pipeline</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '6px 12px' }}>Method</th>
            <th style={{ padding: '6px 12px' }}>Path</th>
            <th style={{ padding: '6px 12px' }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {repoRoutes.map((r) => (
            <tr key={r.path} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '6px 12px' }}><code style={{ fontSize: 12, background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>{r.method}</code></td>
              <td style={{ padding: '6px 12px' }}><code style={{ fontSize: 13, color: '#7c3aed' }}>{r.path}</code></td>
              <td style={{ padding: '6px 12px', color: '#555' }}>{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ fontSize: 16, marginTop: 24, color: '#0369a1' }}>Telegram Bot</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #e5e7eb', textAlign: 'left' }}>
            <th style={{ padding: '6px 12px' }}>Method</th>
            <th style={{ padding: '6px 12px' }}>Path</th>
            <th style={{ padding: '6px 12px' }}>Description</th>
          </tr>
        </thead>
        <tbody>
          {telegramRoutes.map((r) => (
            <tr key={r.path} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <td style={{ padding: '6px 12px' }}><code style={{ fontSize: 12, background: '#f1f5f9', padding: '2px 6px', borderRadius: 4 }}>{r.method}</code></td>
              <td style={{ padding: '6px 12px' }}><code style={{ fontSize: 13, color: '#7c3aed' }}>{r.path}</code></td>
              <td style={{ padding: '6px 12px', color: '#555' }}>{r.desc}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 40, padding: 20, background: '#fefce8', borderRadius: 8, fontSize: 13 }}>
        <strong>Authentication:</strong> Most endpoints require <code>?secret=YOUR_ORCHESTRATOR_SECRET</code> except <code>/api/health</code> which is public.
      </div>
    </main>
  );
}
