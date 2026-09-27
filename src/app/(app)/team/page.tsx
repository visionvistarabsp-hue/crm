'use client';

import { useApi } from '@/lib/useApi';
import { ApiErrorView } from '@/lib/fetcher';
import { Badge, EmptyState, PageHeader, Spinner, Table } from '@/components/ui';
import { ROLE_LABEL } from '@/lib/constants';

type Member = { id: string; name: string; email: string; role: string; title: string | null; phone: string | null; active: boolean; managerName: string | null; salesVolume?: string | null };

export default function TeamPage() {
  const { data, error, loading, reload } = useApi<{ items: Member[] }>('/api/team');

  return (
    <div>
      <PageHeader title="Team" subtitle="Everyone with access and their role" />
      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />
      <div className="card">
        <Table head={['Name', 'Email', 'Role', 'Title', 'Manager', 'Active']}>
          {data?.items?.map((m) => (
            <tr key={m.id}>
              <td className="td">
                <p className="font-medium text-ink">{m.name}</p>
                <p className="text-xs text-ink-faint">{m.id}</p>
              </td>
              <td className="td text-ink-muted">{m.email}</td>
              <td className="td">
                <Badge tone={m.role === 'SUPER_ADMIN' ? 'red' : m.role?.startsWith('SALES_MANAGER') ? 'purple' : m.role === 'TEAM_LEADER' ? 'amber' : 'blue'}>
                  {ROLE_LABEL[m.role as keyof typeof ROLE_LABEL] ?? m.role}
                </Badge>
              </td>
              <td className="td text-ink-muted">{m.title ?? '—'}</td>
              <td className="td text-ink-muted">{m.managerName ?? '—'}</td>
              <td className="td"><Badge tone={m.active ? 'green' : 'gray'}>{m.active ? 'Active' : 'Disabled'}</Badge></td>
            </tr>
          ))}
        </Table>
        {data && data.items.length === 0 && <EmptyState title="No team members" subtitle="Users sign themselves up, or ask an admin to add them." />}
      </div>
    </div>
  );
}