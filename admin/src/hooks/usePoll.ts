import { useCallback, useEffect, useRef, useState } from 'react';

interface PollState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
}

/**
 * Fetch on mount, then on an interval, with a manual `refresh` for use straight
 * after a mutation. Polling is how camera online-state stays current — the
 * Worker has no push channel to the browser.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  enabled = true,
): PollState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const [loading, setLoading] = useState(enabled);

  // Keep the latest fetcher without making it a dependency of the interval,
  // so an inline arrow function in a caller doesn't restart the timer.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs, refresh]);

  return { data, error, loading, refresh };
}
