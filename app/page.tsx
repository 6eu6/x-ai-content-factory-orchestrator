export default function Home() {
  const routes = [
    { path: '/api/health', method: 'GET', desc: 'فحص حالة النظام (عام، بدون سر)', public: true },
    { path: '/api/db-setup', method: 'GET', desc: 'فحص/إنشاء جداول قاعدة البيانات' },
    { path: '/api/check-account', method: 'GET', desc: 'فحص حالة حساب @30piq' },
    { path: '/api/daily-run', method: 'GET/POST', desc: 'المنسّق الرئيسي اليومي' },
    { path: '/api/model-router', method: 'GET/POST/DELETE', desc: 'إدارة قواعد توجيه النماذج' },
    { path: '/api/shield-check', method: 'POST', desc: 'فحص حماية المحتوى (11 فحص)' },
    { path: '/api/format-decision', method: 'GET/POST', desc: 'اختيار صيغة المحتوى المثلى' },
    { path: '/api/production-cycle', method: 'GET/POST', desc: 'توليد بطاقات الإنتاج' },
    { path: '/api/generate-media', method: 'POST', desc: 'توليد وسائط (صور، كاروسيل)' },
    { path: '/api/publish-pack', method: 'POST', desc: 'تجهيز وتسليم حزمة المحتوى' },
    { path: '/api/account-performance-scan', method: 'GET', desc: 'مسح أداء الحساب مع تعلّم سببي' },
    { path: '/api/learning-cycle', method: 'GET/POST', desc: 'دورة تعلّم ذكية (بحث + فيروسي)' },
    { path: '/api/weekly-review', method: 'GET', desc: 'مراجعة أسبوعية' },
    { path: '/api/viral-account-scan', method: 'GET/POST', desc: 'تحليل حسابات فيروسية عميق' },
    { path: '/api/viral-discovery-run', method: 'GET/POST', desc: 'اكتشاف فيروسي تلقائي' },
    { path: '/api/research-intel-v4', method: 'GET', desc: 'بحث مصدري متقدم' },
    { path: '/api/research-intel-run', method: 'GET/POST', desc: 'تشغيل بحث مصدري' },
    { path: '/api/discovery-run', method: 'GET', desc: 'اكتشاف GitHub + ويب' },
    { path: '/api/memory-maintenance-run', method: 'GET', desc: 'صيانة الذاكرة التعليمية' },
    { path: '/api/growth-learning-run', method: 'GET/POST', desc: 'تعلّم النمو' },
    { path: '/api/learning-reflection-run', method: 'GET/POST', desc: 'تأمل ذاتي' },
    { path: '/api/log-user-action', method: 'POST', desc: 'تسجيل إجراءات المستخدم' },
    { path: '/api/github-create-repo', method: 'POST', desc: 'إنشاء مستودع GitHub' },
    { path: '/api/debug-twitterapi', method: 'GET', desc: 'تشخيص TwitterAPI' },
    { path: '/api/system-cleanup', method: 'POST', desc: 'تنظيف بيانات تجريبية' },
  ];

  const repoRoutes = [
    { path: '/api/repo-ingest', method: 'GET/POST', desc: 'استيعاب مستودع GitHub' },
    { path: '/api/repo-deep-learn', method: 'GET/POST', desc: 'تعلم عميق من المستودع' },
    { path: '/api/repo-deep-learn-excerpt', method: 'GET/POST', desc: 'تعلم عميق من مقتطفات' },
    { path: '/api/repo-style-learn', method: 'GET/POST', desc: 'تعلم أسلوب المستودع' },
    { path: '/api/repo-build-planner', method: 'GET/POST', desc: 'تخطيط بناء المستودع' },
    { path: '/api/repo-artifact-writer', method: 'GET/POST', desc: 'كتابة ملفات المستودع' },
    { path: '/api/repo-artifact-repair', method: 'GET/POST', desc: 'إصلاح ملفات المستودع' },
    { path: '/api/repo-validation-run', method: 'GET', desc: 'التحقق من المستودع' },
    { path: '/api/repo-post-push-validation', method: 'GET', desc: 'تحقق بعد الدفع' },
    { path: '/api/repo-create-and-push', method: 'POST', desc: 'إنشاء ودفع المستودع' },
    { path: '/api/repo-investment-run', method: 'GET', desc: 'تقييم استثمار المستودع' },
    { path: '/api/launch-content-from-repo', method: 'GET/POST', desc: 'محتوى إطلاق من المستودع' },
    { path: '/api/launch-content-repair', method: 'GET/POST', desc: 'إصلاح محتوى الإطلاق' },
    { path: '/api/launch-content-repair-strict', method: 'GET/POST', desc: 'إصلاح صارم' },
    { path: '/api/launch-content-repair-v2', method: 'GET/POST', desc: 'إصلاح v2' },
  ];

  const telegramRoutes = [
    { path: '/api/telegram/webhook', method: 'POST', desc: 'معالج أوامر البوت (12+ أمر عربي)' },
    { path: '/api/telegram/setup', method: 'GET', desc: 'إعداد Telegram Webhook' },
  ];

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '32px auto', padding: 24, lineHeight: 1.7, color: '#1a1a1a' }}>
      <div style={{ marginBottom: 32 }}>
        <p style={{ fontSize: 13, opacity: 0.6, margin: 0 }}>X AI Content Factory</p>
        <h1 style={{ fontSize: 36, margin: '4px 0 12px', fontWeight: 700 }}>Orchestrator</h1>
        <p style={{ fontSize: 16, opacity: 0.85, maxWidth: 640 }}>
          نظام آلي متكامل لزراعة حساب تويتر @30piq في مجال AI × الإنتاجية × النمو المهني.
          المحتوى يُسلّم عبر تليغرام — والنشر يدوي دائمًا.
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
