'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { fetcher } from '@/lib/fetcher';
import { MIN_PASSWORD_LENGTH, checkPasswordPolicy } from '@/lib/password-policy';
import type { CurrentUser } from '@/lib/auth';

const EMPTY = { name: '', email: '', password: '', confirm: '' };

export default function SignupForm() {
  const router = useRouter();
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set =
    (k: keyof typeof EMPTY) =>
    (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (form.password !== form.confirm) {
      setError('Passwords do not match');
      return;
    }

    // Same policy the server enforces, so the user finds out before submitting.
    const problem = checkPasswordPolicy(form.password);
    if (problem) {
      setError(problem);
      return;
    }

    setSubmitting(true);
    try {
      await fetcher<{ user: CurrentUser }>('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ name: form.name, email: form.email, password: form.password }),
      });
      // Signup signs the user in, so go straight to the app.
      router.replace('/');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent text-lg font-black text-primary-900">SP</div>
        <h1 className="text-xl font-bold text-white">Create your account</h1>
        <p className="text-sm text-white/60">Get access to the SalesPoint CRM</p>
      </div>

      <div className="card bg-surface p-6">
        <form onSubmit={submit} className="space-y-4">
          <Field label="Full name">
            <Input
              name="name"
              autoComplete="name"
              required
              autoFocus
              value={form.name}
              onChange={set('name')}
              placeholder="e.g. Ravi Kumar"
            />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              name="email"
              autoComplete="username"
              required
              value={form.email}
              onChange={set('email')}
              placeholder="you@company.com"
            />
          </Field>
          <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters, with a letter and a number`}>
            <Input
              type="password"
              name="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={form.password}
              onChange={set('password')}
              placeholder="••••••••"
            />
          </Field>
          <Field label="Confirm password">
            <Input
              type="password"
              name="confirm"
              autoComplete="new-password"
              required
              value={form.confirm}
              onChange={set('confirm')}
              placeholder="••••••••"
            />
          </Field>

          {error && (
            <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          <Button type="submit" loading={submitting} className="w-full">Create account</Button>
        </form>

        <p className="mt-5 text-center text-sm text-ink-muted">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary-700 underline">Sign in</Link>
        </p>
      </div>

      <p className="mt-6 text-center text-xs text-white/40">© {new Date().getFullYear()} SalesPoint · Internal tool</p>
    </div>
  );
}
