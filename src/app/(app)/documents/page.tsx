'use client';

import { useMemo, useState } from 'react';
import { useApi } from '@/lib/useApi';
import { ApiErrorView, fetcher } from '@/lib/fetcher';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Pagination, Select, Spinner, StatusBadge, Table } from '@/components/ui';
import { DOCUMENT_TYPES } from '@/lib/constants';

type Doc = {
  id: string; title: string; fileName: string; documentType: string; verificationStatus: string;
  size: number; createdAt: string; uploadedByName?: string | null;
};

export default function DocumentsPage() {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const url = useMemo(() => {
    const sp = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (type) sp.set('type', type);
    if (status) sp.set('status', status);
    return `/api/documents?${sp.toString()}`;
  }, [page, type, status]);
  const { data, error, loading, reload } = useApi<{ items: Doc[]; total: number }>(url, { deps: [page, type, status] });
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    fd.append('title', file.name.replace(/\.[^.]+$/, ''));
    setUploading(true);
    setUploadError(null);
    try {
      await fetcher('/api/documents', { method: 'POST', body: fd });
      await reload();
    } catch (err) {
      setUploadError((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const download = async (id: string) => {
    const res = await fetcher<{ url: string; expiresIn: number }>(`/api/documents/${id}?mode=url`);
    await fetcher(`/api/notifications/read`, { method: 'POST', body: JSON.stringify({ id }) }).catch(() => {});
    window.open(res.url, '_blank');
  };

  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle="Agreements, KYC, receipts — with verification states"
        action={
          <Button onClick={() => document.getElementById('doc-upload')?.click()} loading={uploading}>
            Upload document
          </Button>
        }
      />
      <input id="doc-upload" type="file" className="hidden" onChange={onUpload} />
      {uploadError && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{uploadError}</p>}

      <div className="card mb-4 flex flex-col gap-3 p-4 sm:flex-row">
        <Select className="!w-auto" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">All types</option>
          {DOCUMENT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
        </Select>
        <Select className="!w-auto" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All states</option>
          {['PENDING', 'VERIFIED', 'REJECTED'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
      </div>

      {loading && !data && <div className="flex justify-center p-10"><Spinner /></div>}
      <ApiErrorView error={error} onRetry={reload} />

      <div className="card">
        <Table head={['Document', 'Type', 'State', 'Size', 'Uploaded', '']}>
          {data?.items?.map((d) => (
            <tr key={d.id}>
              <td className="td">
                <p className="font-medium text-ink">{d.title}</p>
                <p className="text-xs text-ink-faint">{d.fileName}</p>
              </td>
              <td className="td"><Badge tone="purple">{d.documentType.replace(/_/g, ' ')}</Badge></td>
              <td className="td"><StatusBadge status={d.verificationStatus} /></td>
              <td className="td tabular-nums text-ink-muted">{(d.size / 1024).toFixed(0)} KB</td>
              <td className="td text-ink-faint">{new Date(d.createdAt).toLocaleDateString('en-IN')}</td>
              <td className="td">
                <Button variant="secondary" className="!py-1" onClick={() => download(d.id)}>Open</Button>
              </td>
            </tr>
          ))}
        </Table>
        {data && data.items.length === 0 && <EmptyState title="No documents" action={<Button onClick={() => document.getElementById('doc-upload')?.click()}>Upload first document</Button>} />}
        {data && <Pagination page={page} total={data.total} pageSize={25} onChange={setPage} />}
      </div>
    </div>
  );
}