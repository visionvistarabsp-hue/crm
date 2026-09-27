'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Spinner, StatusBadge, Table, cn } from '@/components/ui';
import { PROJECT_STATUS } from '@/lib/constants';

type Unit = { id: string; unitNo: string; bhk: string; unitType: string; status: string; price: string | null; tower?: { id: string; name: string } | null };
type Project = {
  id: string; name: string; status: string; location: string | null; projectType: string | null;
  towerCount: number;
  unitStats: { total: number; available: number; booked: number; held: number; inventoryValue: string };
};

export default function ProjectsPage() {
  const { data, error, loading, reload } = useApi<{ items: Project[] }>('/api/projects');
  const [projectStatusFilter, setProjectStatusFilter] = useState('');
  const [open, setOpen] = useState(false);
  const [towerOpen, setTowerOpen] = useState<string | null>(null);
  const [unitsOpen, setUnitsOpen] = useState<string | null>(null);

  const filtered = data?.items?.filter((p) => !projectStatusFilter || p.status === projectStatusFilter);

  return (
    <div>
      <PageHeader title="Projects & units" subtitle="Towers, unit inventory and availability" action={<Button onClick={() => setOpen(true)}>New project</Button>} />

      <div className="mb-4 flex flex-wrap gap-2">
        {['', ...PROJECT_STATUS].map((s) => (
          <button key={s} onClick={() => setProjectStatusFilter(s)} className={cn(projectStatusFilter === s ? 'btn-primary !py-1.5 capitalize' : 'btn-secondary !py-1.5 capitalize')}>
            {s === '' ? 'All' : s.replace(/_/g, ' ').toLowerCase()}
          </button>
        ))}
      </div>

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />

      <div className="space-y-6">
        {filtered?.map((p) => (
          <Card key={p.id}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
              <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">{p.name}</h3>
                  <StatusBadge status={p.status} />
                </div>
                <p className="text-sm text-ink-muted">{[p.location, p.projectType].filter(Boolean).join(' · ') || '—'} · {p.towerCount} tower(s)</p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Badge tone="green">{p.unitStats.available} available</Badge>
                <Badge tone="amber">{p.unitStats.held} on hold</Badge>
                <Badge tone="blue">{p.unitStats.booked} booked</Badge>
                <Button variant="secondary" className="!py-1.5" onClick={() => setUnitsOpen(unitsOpen === p.id ? null : p.id)}>
                  {unitsOpen === p.id ? 'Hide units' : 'Units'}
                </Button>
                <Button variant="secondary" className="!py-1.5" onClick={() => setTowerOpen(p.id)}>Add tower</Button>
              </div>
            </div>
            {unitsOpen === p.id && <ProjectUnits projectId={p.id} />}
          </Card>
        ))}
        {data && data.items.length === 0 && <EmptyState title="No projects yet" action={<Button onClick={() => setOpen(true)}>Create the first project</Button>} />}
      </div>

      <ProjectDialog open={open} onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />
      {towerOpen && <TowerDialog open projectId={towerOpen} onClose={() => setTowerOpen(null)} onDone={() => { setTowerOpen(null); reload(); }} />}
    </div>
  );
}

function ProjectUnits({ projectId }: { projectId: string }) {
  const { data, error, loading } = useApi<{ items: Unit[] }>(`/api/units?projectId=${projectId}&pageSize=200`, { deps: [projectId] });
  if (loading) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (error) return <ApiErrorView error={error} />;
  return (
    <div className="mt-4">
      <Table head={['Unit', 'Type · BHK', 'Tower', 'Price', 'Status']}>
        {data?.items?.map((u) => (
          <tr key={u.id}>
            <td className="td font-medium text-ink">{u.unitNo}</td>
            <td className="td text-ink-muted">{[u.unitType, u.bhk ? `${u.bhk} BHK` : null].filter(Boolean).join(' · ')}</td>
            <td className="td text-ink-muted">{u.tower?.name ?? '—'}</td>
            <td className="td tabular-nums">{u.price ? `₹ ${Number(u.price).toLocaleString('en-IN')}` : '—'}</td>
            <td className="td"><StatusBadge status={u.status} /></td>
          </tr>
        ))}
      </Table>
      {data && data.items.length === 0 && <p className="py-4 text-sm text-ink-faint">No units for this project.</p>}
    </div>
  );
}

function ProjectDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', status: 'ACTIVE', location: '', projectType: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try { await fetcher('/api/projects', { method: 'POST', body: JSON.stringify(form) }); onDone(); }
    catch (err) { setError((err as Error).message); setSaving(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New project"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={saving}>Create</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Project name"><Input value={form.name} onChange={set('name')} required placeholder="e.g. Skyline Heights" /></Field>
        <Field label="Status"><Select value={form.status} onChange={set('status')}>{PROJECT_STATUS.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Location"><Input value={form.location} onChange={set('location')} placeholder="Area, city" /></Field>
        <Field label="Type"><Input value={form.projectType} onChange={set('projectType')} placeholder="Residential / commercial" /></Field>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Dialog>
  );
}

function TowerDialog({ open, projectId, onClose, onDone }: { open: boolean; projectId: string; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: '', floors: '10', unitsPerFloor: '4' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetcher<{ tower: { unitsCreated: number } }>(`/api/projects/${projectId}`, { method: 'PUT', body: JSON.stringify(form) });
      alert(`Tower created with ${res.tower.unitsCreated} units.`);
      onDone();
    } catch (err) { setError((err as Error).message); setSaving(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add tower"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={submit} loading={saving}>Generate</Button></>}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Tower name"><Input value={form.name} onChange={set('name')} required placeholder="e.g. Tower A" /></Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Floors"><Input type="number" min={1} value={form.floors} onChange={set('floors')} /></Field>
          <Field label="Units / floor"><Input type="number" min={1} value={form.unitsPerFloor} onChange={set('unitsPerFloor')} /></Field>
        </div>
        <p className="text-xs text-ink-faint">Units are created automatically per floor.</p>
        {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </form>
    </Dialog>
  );
}