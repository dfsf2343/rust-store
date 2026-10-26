import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Catalog, type Me, type ServerStatus, type Site } from './api';

interface StoreData {
  site: Site;
  catalog: Catalog;
  me: Me;
  refreshMe: () => Promise<void>;
}

const DataContext = createContext<StoreData | null>(null);

export function DataProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ site: Site; catalog: Catalog; me: Me } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([api<Site>('/site'), api<Catalog>('/catalog'), api<Me>('/me')])
      .then(([site, catalog, me]) => {
        if (alive) setState({ site, catalog, me });
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  const refreshMe = useCallback(async () => {
    const me = await api<Me>('/me');
    setState((s) => (s ? { ...s, me } : s));
  }, []);

  useEffect(() => {
    if (state) document.title = state.site.name;
  }, [state]);

  if (error) {
    return (
      <main className="boot boot--error">
        <p>The store could not load: {error}</p>
        <button className="button" onClick={() => window.location.reload()}>
          Try again
        </button>
      </main>
    );
  }
  if (!state) return <main className="boot" aria-busy="true" />;
  return <DataContext.Provider value={{ ...state, refreshMe }}>{children}</DataContext.Provider>;
}

export function useStore(): StoreData {
  const ctx = useContext(DataContext);
  if (!ctx) throw new Error('useStore outside DataProvider');
  return ctx;
}

/** Re-renders every `intervalMs` so countdowns stay current. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useServerStatus(pollMs = 30_000): ServerStatus | null {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<ServerStatus>('/status')
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    void load();
    const id = window.setInterval(load, pollMs);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [pollMs]);
  return status;
}

export interface Async<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function useApi<T>(path: string | null): Async<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [tick, setTick] = useState(0);
  const pathRef = useRef(path);
  pathRef.current = path;

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: controller.signal })
      .then((d) => {
        if (!controller.signal.aborted) setData(d);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [path, tick]);

  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}
