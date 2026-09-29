'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Bell,
  CalendarCheck,
  IndianRupee,
  LogOut,
  UserPlus,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';

const TILES: Array<{ href: string; label: string; icon: LucideIcon }> = [
  { href: '/today', label: 'Today', icon: CalendarCheck },
  { href: '/new-lead', label: 'New Lead', icon: UserPlus },
  { href: '/my-leads', label: 'Leads', icon: UsersRound },
  { href: '/new-payment', label: 'Money', icon: IndianRupee },
];

type Me = { user: { id: string; name: string; email: string; role: string } };

export default function EasyShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [unread, setUnread] = useState(0);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    fetcher<Me>('/api/auth/me')
      .then((m) => {
        setMe(m);
        if (m.user.role !== 'SALES_EXECUTIVE') router.replace('/');
      })
      .catch(() => router.replace('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const tick = () =>
      fetcher<{ total: number }>('/api/notifications?unread=true&pageSize=1')
        .then((d) => setUnread(d.total))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 30000);
    return () => clearInterval(t);
  }, []);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await fetcher('/api/auth/logout', { method: 'POST' });
    } catch {
      /* cookie is gone either way */
    }
    router.replace('/login');
    router.refresh();
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="sticky top-0 z-20 flex items-center gap-3 bg-canvas/90 px-4 py-3 backdrop-blur">
        <Link href="/home" className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-500 font-black text-white shadow-clay-sm">
          SP
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold leading-tight text-ink">Hi, {me?.user?.name ?? '…'}</p>
          <p className="text-[11px] font-medium text-ink-faint">SalesPoint</p>
        </div>
        <Link href="/followups" className="chip-clay relative !rounded-xl !p-2.5" aria-label={`Follow-ups${unread ? `, ${unread} unread` : ''}`}>
          <Bell size={20} />
          {unread > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white shadow-clay-xs">
              {unread}
            </span>
          )}
        </Link>
        <button onClick={signOut} disabled={signingOut} className="chip-clay !rounded-xl !p-2.5" aria-label="Sign out">
          <LogOut size={20} />
        </button>
      </header>

      <main className="flex-1 px-4 pb-28 pt-2">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-black/5 bg-canvas/95 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 backdrop-blur">
        <ul className="grid grid-cols-4 gap-1">
          {TILES.map((t) => {
            const active = pathname === t.href || pathname.startsWith(t.href + '/');
            const Icon = t.icon;
            return (
              <li key={t.href}>
                <Link
                  href={t.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-2xl px-1 py-2 text-[11px] font-bold transition-all',
                    active ? 'bg-surface text-primary-700 shadow-clay-inset-sm' : 'text-ink-faint',
                  )}
                >
                  <Icon size={22} />
                  <span className="truncate">{t.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
