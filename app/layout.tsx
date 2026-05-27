import type { ReactNode } from 'react';

export const metadata = {
  title: 'X AI Content Factory Orchestrator',
  description: 'AI-powered X content orchestration system with manual publishing workflow.'
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body style={{ margin: 0, background: '#ffffff' }}>{children}</body>
    </html>
  );
}
