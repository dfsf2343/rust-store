import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useSearchParams } from 'react-router';
import { api } from '../api';
import { useStore } from '../data';
import { Notice, SteamSignIn } from './bits';

function Wordmark({ name }: { name: string }) {
  return (
    <Link to="/" className="wordmark" aria-label={`${name} home`}>
      <span className="wordmark__mark" aria-hidden="true">
        3x
      </span>
      <span className="wordmark__name">{name}</span>
    </Link>
  );
}

function AccountMenu() {
  const { me } = useStore();
  if (!me.user) return <SteamSignIn className="button button--steam button--small" />;
  return (
    <Link to="/account" className="account-chip">
      {me.user.avatarUrl ? <img src={me.user.avatarUrl} alt="" width="28" height="28" /> : <span className="account-chip__initial">{(me.user.name ?? 'P').slice(0, 1)}</span>}
      <span className="account-chip__name">{me.user.name ?? 'My account'}</span>
    </Link>
  );
}

// The server only sends these codes; anything else in the URL falls back to the generic text.
const LOGIN_ERRORS: Record<string, string> = {
  cancelled: 'Steam sign-in was cancelled.',
  expired: 'The sign-in took too long. Try again.',
  failed: 'Steam could not confirm your sign-in. Try again.',
};

export function Layout() {
  const { site, me } = useStore();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [menuOpen, setMenuOpen] = useState(false);
  const loginError = params.get('login_error');

  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <Wordmark name={site.name} />
          <button
            type="button"
            className="topbar__toggle"
            aria-expanded={menuOpen}
            aria-controls="primary-nav"
            onClick={() => setMenuOpen((v) => !v)}
          >
            Menu
          </button>
          <nav id="primary-nav" className={menuOpen ? 'nav is-open' : 'nav'} aria-label="Primary">
            <NavLink to="/store" className="nav__link">
              Store
            </NavLink>
            <NavLink to="/rules" className="nav__link">
              Rules
            </NavLink>
            <NavLink to="/faq" className="nav__link">
              FAQ
            </NavLink>
            {site.links.discord && (
              <a className="nav__link" href={site.links.discord} target="_blank" rel="noreferrer">
                Discord
              </a>
            )}
            {me.user?.isAdmin && (
              <NavLink to="/admin" className="nav__link">
                Admin
              </NavLink>
            )}
            <span className="nav__account">
              <AccountMenu />
            </span>
          </nav>
        </div>
      </header>

      <main id="main" className="main">
        {loginError && (
          <div className="container">
            <Notice tone="error">
              {Object.hasOwn(LOGIN_ERRORS, loginError) ? LOGIN_ERRORS[loginError] : LOGIN_ERRORS.failed}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  params.delete('login_error');
                  setParams(params, { replace: true });
                }}
              >
                Dismiss
              </button>
            </Notice>
          </div>
        )}
        <Outlet />
      </main>

      <footer className="footer">
        <div className="footer__inner">
          <div className="footer__brand">
            <Wordmark name={site.name} />
            <p className="footer__note">
              {site.name} is a community server and is not affiliated with or endorsed by Facepunch Studios.
            </p>
          </div>
          <nav className="footer__links" aria-label="Legal">
            <Link to="/terms">Terms of service</Link>
            <Link to="/refunds">Refund policy</Link>
            <Link to="/privacy">Privacy policy</Link>
            <a href={`mailto:${site.legal.contactEmail}`}>{site.legal.contactEmail}</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export async function logout() {
  await api('/auth/logout', { method: 'POST', body: {} });
  window.location.assign('/');
}
