'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Lock, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, Card, CardHeader, Field, Input, PageHeader, Spinner } from '@/components/ui';
import { ApiErrorView, fetcher, useApi } from '@/lib/fetcher';

type Source = 'database' | 'environment' | 'none';

type Secret = {
  key: string;
  label: string;
  required: boolean;
  hasStoredKey: boolean;
  keyMask: string | null;
  source: Source;
};

type Item = {
  provider: string;
  label: string;
  secrets: Secret[];
  plain: Record<string, string | null>;
  plainLabels: { key: string; label: string }[];
  isActive: boolean;
  configured: boolean;
  source: Source;
};

type Payload = {
  encryptionConfigured: boolean;
  leadSources: readonly string[];
  items: Item[];
};

const SOURCE_LABEL: Record<Source, string> = {
  database: 'Database (encrypted)',
  environment: 'Environment fallback',
  none: 'Not configured',
};

type Drafts = Record<string, Record<string, string>>;

export default function SettingsKeysPage() {
  const { data, error, loading, reload } = useApi<Payload>('/api/settings/keys');
  const [drafts, setDrafts] = useState<Drafts>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // Seed the form from the server once, so a masked stored key shows as blank
  // rather than as the masked string the user would then resubmit.
  useEffect(() => {
    if (!data) return;
    setDrafts((prev) => {
      const next: Drafts = {};
      for (const item of data.items) {
        const existing = prev[item.provider] ?? {};
        const row: Record<string, string> = { ...existing };
        for (const field of item.plainLabels) {
          if (row[field.key] === undefined) row[field.key] = item.plain[field.key] ?? '';
        }
        for (const secret of item.secrets) {
          if (row[secret.key] === undefined) row[secret.key] = '';
        }
        next[item.provider] = row;
      }
      return next;
    });
  }, [data]);

  const draft = (provider: string) => drafts[provider] ?? {};

  const setField = (provider: string, key: string, value: string) => {
    setSaved((current) => (current === provider ? null : current));
    setDrafts((prev) => ({ ...prev, [provider]: { ...(prev[provider] ?? {}), [key]: value } }));
  };

  const save = async (item: Item) => {
    setFormError(null);
    setSaved(null);
    const values = draft(item.provider);
    const missing = item.secrets.filter((s) => s.required && !s.hasStoredKey && !(values[s.key] ?? '').trim());
    if (missing.length > 0) {
      setFormError(`${missing.map((s) => s.label).join(' and ')} must be entered the first time you save ${item.label}`);
      return;
    }
    setBusy(item.provider);
    try {
      const body: Record<string, unknown> = { provider: item.provider };
      for (const secret of item.secrets) {
        const value = (values[secret.key] ?? '').trim();
        if (value) body[secret.key] = value;
      }
      for (const field of item.plainLabels) {
        body[field.key] = values[field.key] ?? '';
      }
      if (item.provider === 'meta') {
        body.formSources = collectFormSources(values, data?.leadSources ?? []);
      }
      await fetcher('/api/settings/keys', { method: 'PUT', body: JSON.stringify(body) });
      setDrafts((prev) => ({ ...prev, [item.provider]: { ...(prev[item.provider] ?? {}), ...blankSecrets(item) } }));
      setSaved(item.provider);
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (item: Item) => {
    if (!confirm(`Remove the stored ${item.label} credentials? The provider falls back to environment values until you save a new key.`)) return;
    setRemoving(item.provider);
    setFormError(null);
    try {
      await fetcher('/api/settings/keys', { method: 'DELETE', body: JSON.stringify({ provider: item.provider }) });
      await reload();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Integration keys" subtitle="Encrypted credentials for email delivery and lead capture" />

      <ApiErrorView error={error} onRetry={reload} />

      {loading && !data && (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      )}

      {data && !data.encryptionConfigured && (
        <Card className="mb-4">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-rose-100 text-rose-700">
              <Lock size={20} />
            </span>
            <div>
              <p className="text-sm font-bold text-ink">Encryption key is not configured</p>
              <p className="mt-1 text-xs text-ink-muted">
                Set <code className="font-mono">SETTINGS_ENCRYPTION_KEY</code> to a 32-byte hex or base64 value, then redeploy. Keys
                are never stored in plain text.
              </p>
            </div>
          </div>
        </Card>
      )}

      {data?.items.map((item) => {
        const values = draft(item.provider);
        const isMeta = item.provider === 'meta';
        return (
          <Card key={item.provider} className="mb-4">
            <CardHeader
              title={item.label}
              subtitle={item.isActive ? `${item.label} is active` : `${item.label} is not active`}
              action={
                item.secrets.some((s) => s.hasStoredKey) ? (
                  <Button
                    variant="secondary"
                    className="!py-1"
                    loading={removing === item.provider}
                    onClick={() => remove(item)}
                  >
                    <Trash2 size={14} /> Remove
                  </Button>
                ) : undefined
              }
            />

            <dl className="space-y-2.5 text-sm">
              {item.secrets.map((secret) => (
                <div key={secret.key} className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">{secret.label}</dt>
                  <dd className="flex items-center gap-1.5 text-xs text-ink">
                    <span className="truncate font-mono">{secret.keyMask ?? 'none'}</span>
                    {secret.source === 'database' && <ShieldCheck size={14} className="shrink-0 text-primary-600" />}
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
                      {SOURCE_LABEL[secret.source]}
                    </span>
                  </dd>
                </div>
              ))}
              {item.plainLabels.map((field) => (
                <div key={field.key} className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-ink-faint">{field.label}</dt>
                  <dd className="truncate font-mono text-xs text-ink">{item.plain[field.key] || 'not set'}</dd>
                </div>
              ))}
            </dl>

            <form className="mt-4 space-y-4" onSubmit={(e) => { e.preventDefault(); void save(item); }}>
              {item.secrets.map((secret) => (
                <Field
                  key={secret.key}
                  label={secret.label}
                  hint={secret.hasStoredKey ? 'Stored — paste a new value only to rotate' : 'Encrypted before it is stored'}
                >
                  <Input
                    value={values[secret.key] ?? ''}
                    onChange={(e) => setField(item.provider, secret.key, e.target.value)}
                    placeholder={secret.hasStoredKey ? '•••••• (unchanged)' : 'paste value'}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
              ))}

              {item.plainLabels.map((field) => (
                <Field key={field.key} label={field.label} hint="Optional — used to classify incoming leads">
                  <Input
                    value={values[field.key] ?? ''}
                    onChange={(e) => setField(item.provider, field.key, e.target.value)}
                    placeholder="numeric id"
                    inputMode="numeric"
                    autoComplete="off"
                    className="font-mono"
                  />
                </Field>
              ))}

              {isMeta && (
                <FormSourcesEditor
                  rows={parseFormSources(values.__formSources ?? '')}
                  sources={data.leadSources}
                  onChange={(text) => setField(item.provider, '__formSources', text)}
                />
              )}

              {formError && (
                <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700" role="alert">
                  {formError}
                </p>
              )}
              {saved === item.provider && (
                <p className="rounded-xl bg-accent-100 px-3 py-2 text-sm font-medium text-primary-800" role="status">
                  {item.label} saved and encrypted.
                </p>
              )}

              <Button type="submit" loading={busy === item.provider} disabled={!data.encryptionConfigured} className="w-full">
                <KeyRound size={16} /> Save {item.label} credentials
              </Button>
            </form>
          </Card>
        );
      })}
    </div>
  );
}

function blankSecrets(item: Item): Record<string, string> {
  const out: Record<string, string> = {};
  for (const secret of item.secrets) out[secret.key] = '';
  return out;
}

/**
 * Form mappings are edited as one textarea rather than a dynamic row list
 * because the set of forms is defined in Meta, not here — there is no API that
 * enumerates a page's forms without extra scopes, and an admin editing this by
 * hand needs to paste an id anyway.
 */
function FormSourcesEditor({
  rows,
  sources,
  onChange,
}: {
  rows: { formId: string; source: string }[];
  sources: readonly string[];
  onChange: (text: string) => void;
}) {
  const [text, setText] = useState(() => serializeFormSources(rows));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!touched) setText(serializeFormSources(rows));
  }, [rows, touched]);

  return (
    <Field
      label="Form → source mapping"
      hint={`One "formId,SOURCE" per line. Known sources: ${sources.join(', ')}`}
    >
      <textarea
        value={text}
        onChange={(e) => {
          setTouched(true);
          setText(e.target.value);
          onChange(e.target.value);
        }}
        rows={3}
        placeholder={'1234567890,WHATSAPP\n0987654321,INSTAGRAM'}
        spellCheck={false}
        className="w-full rounded-xl border border-black/10 bg-white px-3 py-2 font-mono text-xs text-ink focus:border-primary-500 focus:outline-none"
      />
    </Field>
  );
}

function serializeFormSources(rows: { formId: string; source: string }[]): string {
  return rows.map((r) => `${r.formId},${r.source}`).join('\n');
}

function parseFormSources(text: string): { formId: string; source: string }[] {
  return text
    .split('\n')
    .map((line) => line.split(','))
    .map(([formId = '', source = '']) => ({ formId: formId.trim(), source: source.trim() }))
    .filter((r) => r.formId);
}

function collectFormSources(values: Record<string, string>, sources: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of parseFormSources(values.__formSources ?? '')) {
    const source = row.source.toUpperCase();
    if (!source) continue;
    if (!sources.includes(source)) throw new Error(`Unknown lead source "${source}" for form ${row.formId}`);
    out[row.formId] = source;
  }
  return out;
}
