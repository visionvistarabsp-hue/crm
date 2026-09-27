'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';
import type { CurrentUser } from '@/lib/auth';

/** Only allow same-origin relative redirects back after login. */
function safeNext(raw: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

export default function LoginForm({ demoMode }: { demoMode: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await fetcher<{ user: CurrentUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      // Full navigation so every server-rendered layout picks up the new session.
      router.replace(safeNext(params.get('next')));
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-md">
      <div className="mb-8 flex flex-col items-center gap-4 text-center">
        <div className="flex h-20 w-20 items-center justify-center rounded-4xl bg-primary-500 text-2xl font-black text-white shadow-clay">
          SP
        </div>
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink">SalesPoint CRM</h1>
          <p className="mt-1.5 text-sm font-medium text-ink-muted">Real estate sales command center</p>
        </div>
      </div>

      <div className="card p-8">
        <h2 className="text-lg font-bold text-ink">Welcome back</h2>
        <p className="mb-6 mt-1 text-sm text-ink-muted">Sign in to access your pipeline, bookings and payouts.</p>

        {demoMode ? (
          <>
            <Link href="/" className="btn-primary w-full">Enter demo</Link>
            <p className="mt-5 rounded-xl bg-accent-100 px-4 py-3 text-xs font-medium text-amber-900 shadow-clay-inset-sm">
              Demo mode is active — authentication is bypassed and you are signed in automatically.
            </p>
          </>
        ) : (
          <form onSubmit={submit} className="space-y-5">
            <Field label="Email">
              <Input
                type="email"
                name="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>

            {error && (
              <p role="alert" className="rounded-xl bg-rose-100 px-4 py-3 text-sm font-medium text-rose-800 shadow-clay-inset-sm">
                {error}
              </p>
            )}

            <Button type="submit" loading={submitting} className="w-full">Sign in</Button>
          </form>
        )}

        {!demoMode && (
          <p className="mt-6 text-center text-sm text-ink-muted">
            No account yet?{' '}
            <Link href="/signup" className="font-bold text-primary-700 hover:underline">Create one</Link>
          </p>
        )}
      </div>

      <p className="mt-8 text-center text-xs font-medium text-ink-faint">
        © {new Date().getFullYear()} SalesPoint · Internal tool
      </p>
    </div>
  );
}
