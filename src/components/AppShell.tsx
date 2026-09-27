'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  BarChart3,
  Bell,
  Building2,
  CalendarCheck,
  CalendarDays,
  FileText,
  Landmark,
  LayoutDashboard,
  Menu,
  Plug,
  ReceiptIndianRupee,
  Search,
  Settings,
  Target,
  UserRound,
  UsersRound,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/components/ui';
import AssistantPanel from '@/components/AssistantPanel';
import { fetcher } from '@/lib/fetcher';

const NAV: Array<{ section: string; items: Array<{ href: string; label: string; icon: LucideIcon }> }> = [
  {
    section: 'Workspace',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard },
      { href: '/leads', label: 'Leads', icon: UsersRound },
      { href: '/followups', label: 'Follow-ups', icon: CalendarCheck },
      { href: '/meetings', label: 'Meetings', icon: CalendarDays },
      { href: '/customers', label: 'Customers', icon: UserRound },
      { href: '/bookings', label: 'Bookings', icon: Building2 },
    ],
  },
  {
    section: 'Inventory & Payments',
    items: [
      { href: '/projects', label: 'Projects & Units', icon: Building2 },
      { href: '/commissions', label: 'Commissions', icon: Wallet },
      { href: '/payouts', label: 'Payouts', icon: Wallet },
    ],
  },
  {
    section: 'Sales Performance',
    items: [
      { href: '/targets', label: 'Targets & Forecast', icon: Target },
      { href: '/collections', label: 'Collections', icon: ReceiptIndianRupee },
      { href: '/loans', label: 'Loans', icon: Landmark },
    ],
  },
  {
    section: 'Operations',
    items: [
      { href: '/reports', label: 'Reports', icon: BarChart3 },
      { href: '/documents', label: 'Documents', icon: FileText },
      { href: '/search', label: 'Search', icon: Search },
      { href: '/team', label: 'Team', icon: UsersRound },
      { href: '/settings', label: 'Settings', icon: Settings },
      { href: '/integrations', label: 'Integrations', icon: Plug },
    ],
  },
];

type Me = { user: { id: string; name: string; email: string; role: string; title?: string | null } };

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    fetcher<Me>('/api/auth/me')
      .then((m) => setMe(m))
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

  const role = me?.user?.role?.replace(/_/g, ' ') ?? '';

  const signOut = async () => {
    setSigningOut(true);
    try {
      // The route destroys the DB session and clears the cookie; a full
      // navigation then rebuilds the tree with no session.
      await fetcher('/api/auth/logout', { method: 'POST' });
    } catch {
      // Clear the client view regardless — the cookie is gone either way.
    }
    router.replace('/login');
    router.refresh();
  };

  const initials = (me?.user?.name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');

  return (
    <div className="flex min-h-screen">
      {sidebarOpen && <div className="fixed inset-0 z-30 bg-ink/30 backdrop-blur-sm lg:hidden" onClick={() => setSidebarOpen(false)} />}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-72 flex-col bg-canvas transition-transform duration-300 lg:static lg:translate-x-0',
          'shadow-clay lg:mr-6 lg:shadow-none',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Brand — a raised clay block. */}
        <div className="flex items-center gap-3 px-6 pb-2 pt-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-500 text-base font-black text-white shadow-clay-sm">
            SP
          </div>
          <div className="min-w-0">
            <p className="truncate text-base font-bold leading-none text-ink">SalesPoint</p>
            <p className="mt-1 text-[11px] font-medium text-ink-faint">Real Estate CRM</p>
          </div>
        </div>

        <nav className="flex-1 space-y-6 overflow-y-auto px-5 py-6">
          {NAV.map((group) => (
            <div key={group.section}>
              <p className="section-label">{group.section}</p>
              <ul className="space-y-1.5">
                {group.items.map((item) => {
                  const active = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href + '/'));
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setSidebarOpen(false)}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-all duration-150',
                          active
                            ? 'bg-surface text-primary-700 shadow-clay-inset-sm'
                            : 'text-ink-muted hover:bg-clay-deep hover:text-ink',
                        )}
                      >
                        <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-lg', active ? 'text-primary-600' : 'text-ink-faint')}>
                          <Icon size={18} />
                        </span>
                        <span className="truncate">{item.label}</span>
                        {item.href === '/followups' && unread > 0 && (
                          <span className="ml-auto rounded-full bg-accent-300 px-2 py-0.5 text-[11px] font-bold text-primary-900 shadow-clay-xs">
                            {unread}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* Account — pressed into the surface. */}
        <div className="px-5 pb-6">
          <div className="flex items-center gap-3 rounded-2xl bg-clay-deep p-3 shadow-clay-inset-sm">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-300 text-sm font-bold text-primary-900 shadow-clay-xs">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-ink">{me?.user?.name ?? 'Loading…'}</p>
              <p className="truncate text-[11px] font-medium capitalize text-ink-faint">{role || '—'}</p>
            </div>
          </div>
          <button
            onClick={signOut}
            disabled={signingOut}
            className="mt-3 w-full rounded-xl bg-surface px-4 py-2.5 text-sm font-semibold text-ink-muted shadow-clay-sm transition-all hover:text-ink active:shadow-clay-inset-sm disabled:opacity-50"
          >
            {signingOut ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col px-4 pb-8 lg:px-6">
        <header className="sticky top-0 z-20 -mx-4 mb-6 flex h-20 items-center gap-3 bg-canvas/85 px-4 py-4 backdrop-blur lg:-mx-6 lg:px-6">
          <button
            className="chip-clay !rounded-xl !p-2.5 lg:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>

          <Link
            href="/search"
            className="flex min-w-0 max-w-md flex-1 items-center gap-3 rounded-xl bg-clay-deep px-4 py-3 text-sm text-ink-faint shadow-clay-inset-sm transition focus:ring-2 focus:ring-primary-500/60"
          >
            <Search size={18} className="shrink-0" />
            <span className="truncate">Search leads, customers, units…</span>
          </Link>

          <span className="ml-auto" />

          <Link href="/followups" className="chip-clay relative !rounded-xl !p-2.5" aria-label={`Follow-ups${unread ? `, ${unread} unread` : ''}`}>
            <Bell size={20} />
            {unread > 0 && (
              <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white shadow-clay-xs">
                {unread}
              </span>
            )}
          </Link>
          <Link href="/settings" className="chip-clay !rounded-xl !p-2.5" aria-label="Settings">
            <Settings size={20} />
          </Link>
        </header>

        <main className="flex-1">{children}</main>
      </div>

      <AssistantPanel />
    </div>
  );
}
