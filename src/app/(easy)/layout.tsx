import { redirect } from 'next/navigation';
import EasyShell from '@/components/EasyShell';
import { getCurrentUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function EasyLayout({ children }: { children: React.ReactNode }) {
  if (process.env.SIMPLE_UI_ENABLED !== 'true') redirect('/');

  const me = await getCurrentUser();
  if (!me) redirect('/login');
  if (me.role !== 'SALES_EXECUTIVE') redirect('/');

  return <EasyShell>{children}</EasyShell>;
}
