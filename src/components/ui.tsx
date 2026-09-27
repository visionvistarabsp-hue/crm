'use client';

import { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, X } from 'lucide-react';

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn('inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)} />;
}

export function Button({ variant = 'primary', loading, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean }) {
  const styles = { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger', ghost: 'btn-ghost' }[variant];
  return (
    <button className={cn(styles, className)} disabled={loading || rest.disabled} {...rest}>
      {loading && <Spinner />}
      {children}
    </button>
  );
}

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('card p-6', className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, action }: { title: React.ReactNode; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div>
        <h3 className="text-lg font-bold text-ink">{title}</h3>
        {subtitle && <p className="mt-0.5 text-sm text-ink-faint">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-ink-muted">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn('input', props.className)} />;
}

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn('input min-h-[104px] leading-relaxed', className)} />;
}

export function Select({ className, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cn('input cursor-pointer appearance-none pr-10', className)}>
      {children}
    </select>
  );
}

const TONES: Record<string, string> = {
  blue: 'bg-sky-100 text-sky-800 shadow-[4px_4px_9px_rgba(120,150,180,0.35),-4px_-4px_9px_rgba(255,255,255,0.7)]',
  green: 'bg-emerald-100 text-emerald-800 shadow-[4px_4px_9px_rgba(110,160,140,0.35),-4px_-4px_9px_rgba(255,255,255,0.7)]',
  amber: 'bg-amber-100 text-amber-800 shadow-[4px_4px_9px_rgba(190,160,110,0.35),-4px_-4px_9px_rgba(255,255,255,0.7)]',
  red: 'bg-rose-100 text-rose-800 shadow-[4px_4px_9px_rgba(190,130,140,0.35),-4px_-4px_9px_rgba(255,255,255,0.7)]',
  gray: 'bg-slate-200/70 text-slate-700 shadow-[4px_4px_9px_rgba(150,155,175,0.35),-4px_-4px_9px_rgba(255,255,255,0.7)]',
  purple: 'bg-primary-100 text-primary-800 shadow-[4px_4px_9px_rgba(160,145,195,0.35),-4px_-4px_9px_rgba(255,255,255,0.7)]',
  yellow: 'bg-accent-100 text-amber-900 shadow-[4px_4px_9px_rgba(195,180,110,0.35),-4px_-4px_9px_rgba(255,255,255,0.7)]',
};

export function Badge({ tone = 'gray', children, className }: { tone?: keyof typeof TONES; children: React.ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-bold', TONES[tone], className)}>{children}</span>;
}

const STATUS_TONES: Record<string, keyof typeof TONES> = {
  NEW: 'blue',
  CONTACTED: 'amber',
  FOLLOW_UP: 'yellow',
  VISIT_SCHEDULED: 'purple',
  NEGOTIATION: 'amber',
  DEAL_COMPLETED: 'green',
  CANCELLED: 'red',
  DUPLICATE: 'gray',
  ARCHIVED: 'gray',
  AVAILABLE: 'green',
  HOLD: 'amber',
  BOOKED: 'blue',
  BLOCKED: 'red',
  DRAFT: 'gray',
  PROCESSED: 'blue',
  PAID: 'green',
  PENDING: 'yellow',
  PAYABLE: 'amber',
  APPROVED: 'blue',
  REVERSED: 'red',
  COMPLETED: 'green',
  SCHEDULED: 'purple',
  CANCELLATION_REQUESTED: 'amber',
  MISSED: 'red',
  OVERDUE: 'red',
  DONE: 'green',
};

export function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <Badge tone="gray">—</Badge>;
  const pretty = status.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  const tone = STATUS_TONES[status] ?? (status.toUpperCase().includes('CANCEL') ? 'red' : 'gray');
  return <Badge tone={tone}>{pretty}</Badge>;
}

export function Money({ value, decimals = 0 }: { value?: string | number | null; decimals?: number }) {
  const n = Number(value ?? 0);
  const formatted = isNaN(n) ? '—' : n.toLocaleString('en-IN', { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
  return <span className="tabular-nums">{formatted}</span>;
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-3">{action}</div>}
    </div>
  );
}

export function Table({ head, children }: { head: React.ReactNode[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse">
        <thead>
          <tr>{head.map((h, i) => <th key={i} className="th">{h}</th>)}</tr>
        </thead>
        <tbody className="[&>tr]:shadow-[0_1px_0_rgba(163,177,198,0.28)] [&>tr:last-child]:shadow-none">{children}</tbody>
      </table>
    </div>
  );
}

export function EmptyState({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-20 text-center">
      <div className="mb-2 flex h-16 w-16 items-center justify-center rounded-2xl bg-surface text-2xl shadow-clay-inset-sm">
        🗂️
      </div>
      <p className="text-base font-bold text-ink">{title}</p>
      {subtitle && <p className="max-w-sm text-sm text-ink-faint">{subtitle}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Pagination({ page, total, pageSize, onChange }: { page: number; total: number; pageSize: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between gap-3 px-5 py-4 text-sm">
      <span className="text-ink-faint">
        {total.toLocaleString('en-IN')} results · page {page}/{pages}
      </span>
      <div className="flex items-center gap-2">
        <Button variant="secondary" className="!px-4 !py-1.5" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Prev
        </Button>
        <Button variant="secondary" className="!px-4 !py-1.5" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export function Dialog({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }) {
  const [show, setShow] = useState(open);
  useEffect(() => {
    if (open) setTimeout(() => setShow(true), 10);
    else setShow(false);
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-ink/40 backdrop-blur-sm" onClick={onClose} />
      <div className={cn('relative z-10 w-full max-w-lg rounded-3xl bg-canvas p-6 shadow-pop transition-all', show ? 'animate-pop-in' : 'opacity-0')}>
        <div className="mb-5 flex items-center justify-between">
          <h3 className="text-lg font-bold text-ink">{title}</h3>
          <button className="chip-clay !rounded-full !p-2" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
        {footer && <div className="mt-6 flex justify-end gap-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: string }) {
  return (
    <div className={cn('card p-6', tone)}>
      <p className="text-xs font-bold uppercase tracking-wider text-ink-faint">{label}</p>
      <p className="mt-2 text-3xl font-bold tabular-nums text-ink">{value}</p>
      {hint && <p className="mt-1.5 text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

export function Menu({ items }: { items: Array<{ key: string; label: string; danger?: boolean; onClick: () => void }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);
  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" className="!px-3 !py-2" onClick={() => setOpen((o) => !o)} aria-label="More actions">
        <MoreHorizontal size={18} />
      </Button>
      {open && (
        <div className="absolute right-0 z-20 mt-2 min-w-[180px] rounded-2xl bg-canvas p-2 shadow-pop animate-pop-in">
          {items.map((i) => (
            <button
              key={i.key}
              className={cn('block w-full rounded-xl px-4 py-2.5 text-left text-sm font-medium text-ink transition hover:bg-clay-deep', i.danger && 'text-rose-600 hover:bg-rose-100')}
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
