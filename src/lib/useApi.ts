'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetcher } from './fetcher';

export function useApi<T = unknown>(url: string | null, opts?: { deps?: unknown[]; refresh?: number }) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(Boolean(url));

  const load = useCallback(async () => {
    if (!url) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await fetcher<T>(url));
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, ...(opts?.deps ?? [])]);

  useEffect(() => {
    load();
    if (opts?.refresh) {
      const t = setInterval(load, opts.refresh);
      return () => clearInterval(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  return { data, error, loading, reload: load };
}