import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, formatDistanceToNow, parseISO } from 'date-fns';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a number as Indian Rupee string. */
export function inr(value: number | string | null | undefined, compact = false): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (n === null || n === undefined || isNaN(Number(n))) return '—';
  const formatter = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
    notation: compact ? 'compact' : 'standard',
  });
  return formatter.format(Number(n));
}

export function num(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return isNaN(n) ? 0 : n;
}

export function pct(part: number | string, whole: number | string, digits = 1): string {
  const p = num(part);
  const w = num(whole);
  if (w === 0) return '0%';
  return `${((p / w) * 100).toFixed(digits)}%`;
}

/** Normalizes phone numbers: keeps 10/12 digit Indian format, strips formatting. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d]/g, '');
  if (d.startsWith('91') && d.length === 12) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length < 10 || d.length > 12) return null;
  return d;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  return e;
}

export function formatDate(d: string | Date | null | undefined, pattern = 'dd MMM yyyy'): string {
  if (!d) return '—';
  try {
    return format(typeof d === 'string' ? parseISO(d) : d, pattern);
  } catch {
    return '—';
  }
}

export function formatDateTime(d: string | Date | null | undefined): string {
  return formatDate(d, 'dd MMM yyyy, hh:mm a');
}

export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return '—';
  try {
    const dt = typeof d === 'string' ? parseISO(d) : d;
    return formatDistanceToNow(dt, { addSuffix: true });
  } catch {
    return '—';
  }
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)+/g, '');
}

/**
 * Render a `YYYY-MM` bucket key as a short axis label.
 *
 * The year is included because a six-month window routinely straddles New Year,
 * where a bare "Jan" is ambiguous. An unparseable key yields an em dash rather
 * than "Invalid Date" leaking into the UI.
 */
export function monthLabel(month: string | null | undefined): string {
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return '—';
  const d = parseISO(`${month}-01`);
  if (Number.isNaN(d.getTime())) return '—';
  return format(d, 'MMM yy');
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function toIsoLocal(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toISOString();
}

export function todayRange(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const end = new Date(start.getTime() + 86400000);
  return { start, end };
}

export function startOfDay(d: Date = new Date()): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}

export function endOfDay(d: Date = new Date()): Date {
  const e = new Date(d);
  e.setHours(23, 59, 59, 999);
  return e;
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/** Zero-pad sequence for business numbers */
export function pad(n: number, width = 4): string {
  return String(n).padStart(width, '0');
}