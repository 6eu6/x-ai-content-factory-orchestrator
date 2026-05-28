export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '64px auto', padding: 24, lineHeight: 1.7, color: '#1a1a1a' }}>
      <p style={{ fontSize: 13, opacity: 0.6, margin: 0 }}>X AI Content Factory</p>
      <h1 style={{ fontSize: 36, margin: '4px 0 16px', fontWeight: 700 }}>Orchestrator</h1>
      <p style={{ fontSize: 16, opacity: 0.85, maxWidth: 560 }}>
        Automated system for growing the @30piq X account in the AI x Productivity x Career Growth niche.
        Content is delivered via Telegram — publishing is always manual.
      </p>
      <p style={{ fontSize: 14, marginTop: 24, padding: 16, background: '#f8fafc', borderRadius: 8 }}>
        <strong>Health:</strong> <code style={{ fontSize: 13, color: '#7c3aed' }}>/api/health</code> (public)
      </p>
    </main>
  );
}
