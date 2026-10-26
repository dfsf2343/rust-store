/** Demo build only: the strip that labels the preview and lets a visitor try the store as different buyers. */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';
import { Spinner } from '../components/bits';
import { useStore } from '../data';
import { demoCountry, resetDemo, setDemoCountry } from './server';
import './demo.css';

const COUNTRIES = [
  { code: 'US', name: 'United States' },
  { code: 'CL', name: 'Chile' },
  { code: 'AR', name: 'Argentina' },
  { code: 'BR', name: 'Brazil' },
  { code: 'DE', name: 'Germany' },
  { code: 'GB', name: 'United Kingdom' },
];

/** Re-mounts the current page so it fetches again with the new demo settings. */
function useReloadPage() {
  const navigate = useNavigate();
  const location = useLocation();
  return (to?: string) => navigate(`/demo-refresh?to=${encodeURIComponent(to ?? `${location.pathname}${location.search}`)}`, { replace: true });
}

export function DemoBar() {
  const { me, refreshMe } = useStore();
  const navigate = useNavigate();
  const reloadPage = useReloadPage();
  const [country, setCountry] = useState(demoCountry);

  useEffect(() => {
    const onSignedOut = () => {
      void refreshMe().then(() => navigate('/'));
    };
    window.addEventListener('demo:signedout', onSignedOut);
    return () => window.removeEventListener('demo:signedout', onSignedOut);
  }, [navigate, refreshMe]);

  const changeCountry = (code: string) => {
    setDemoCountry(code);
    setCountry(code);
    reloadPage();
  };

  const switchRole = async () => {
    const role = me.user?.isAdmin ? 'player' : 'admin';
    await api('/auth/demo-login', { method: 'POST', body: { role } });
    await refreshMe();
    navigate(role === 'admin' ? '/admin' : '/account');
  };

  const reset = async () => {
    resetDemo();
    setCountry(demoCountry());
    await refreshMe();
    navigate('/');
  };

  return (
    <div className="demo-bar" role="region" aria-label="Demo controls">
      <div className="demo-bar__inner">
        <p className="demo-bar__note">
          <strong>Demo preview.</strong> Sample data and simulated payments. Nothing is charged.
        </p>
        <label className="demo-bar__field" htmlFor="demo-country">
          Buying from
          <select id="demo-country" value={country} onChange={(e) => changeCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="demo-bar__button" onClick={() => void switchRole()}>
          {me.user?.isAdmin ? 'View as a player' : 'View the admin panel'}
        </button>
        <button type="button" className="demo-bar__button demo-bar__button--quiet" onClick={() => void reset()}>
          Reset demo
        </button>
      </div>
    </div>
  );
}

/** Stands in for the Steam sign-in round trip. */
export function DemoLogin() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refreshMe } = useStore();
  useEffect(() => {
    const to = params.get('returnTo') ?? '/account';
    void api('/auth/demo-login', { method: 'POST', body: { role: 'player' } })
      .then(() => refreshMe())
      .then(() => navigate(to.startsWith('/') ? to : '/account', { replace: true }));
  }, [navigate, params, refreshMe]);
  return (
    <div className="container page page--narrow">
      <Spinner label="Signing you in" />
    </div>
  );
}

export function DemoRefresh() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  useEffect(() => {
    const to = params.get('to') ?? '/';
    navigate(to.startsWith('/') ? to : '/', { replace: true });
  }, [navigate, params]);
  return null;
}
