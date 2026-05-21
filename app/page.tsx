export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 880, margin: '48px auto', padding: 24, lineHeight: 1.6 }}>
      <p style={{ fontSize: 14, opacity: 0.7 }}>X AI Content Factory</p>
      <h1 style={{ fontSize: 40, margin: '8px 0 16px' }}>Orchestrator is deployed</h1>
      <p>
        This service is the backend execution layer for the X AI Content Factory experiment.
        It prepares daily content missions, checks account state, writes logs to Supabase,
        and creates GitHub supporting assets when needed.
      </p>
      <h2>Available API routes</h2>
      <ul>
        <li><code>/api/check-account?secret=YOUR_SECRET</code></li>
        <li><code>/api/daily-run?secret=YOUR_SECRET</code></li>
        <li><code>/api/weekly-review?secret=YOUR_SECRET</code></li>
        <li><code>/api/log-user-action</code> via POST</li>
        <li><code>/api/github-create-repo</code> via POST</li>
      </ul>
      <h2>Human role</h2>
      <p>You manually copy, post, reply, and quote on X. The system plans, logs, checks, and improves the workflow.</p>
      <p style={{ marginTop: 32, fontSize: 13, opacity: 0.65 }}>
        Do not expose secrets in public links. Use the secret only when calling protected API routes.
      </p>
    </main>
  );
}
