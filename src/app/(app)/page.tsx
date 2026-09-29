import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth';
import DashboardClient from './dashboard-client';

export const dynamic = 'force-dynamic';

/**
 * Root landing. With SIMPLE_UI_ENABLED on, a sales executive starts in the
 * phone-first flow; everyone else keeps the full dashboard.
 *
 * The gate lives here rather than in `(app)/layout.tsx` on purpose. It only
 * needs to steer the default landing - the API still enforces permissions, so
 * this is a default-screen switch, not a security boundary. Wrapping every
 * page in a role redirect would also break the retained notification bell,
 * which links to /followups, and would force this layout dynamic for the whole
 * manager app.
 */
export default async function HomePage() {
  const me = await getCurrentUser();
  if (!me) redirect('/login');
  if (process.env.SIMPLE_UI_ENABLED === 'true' && me.role === 'SALES_EXECUTIVE') redirect('/home');

  return <DashboardClient />;
}
