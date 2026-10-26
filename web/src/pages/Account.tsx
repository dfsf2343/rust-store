import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError, type Account as AccountView, type OrderStatus } from '../api';
import { CopyButton, Notice, PageHeader, SteamSignIn, TierPlate } from '../components/bits';
import { logout } from '../components/Layout';
import { useApi, useNow, useStore } from '../data';
import { countdown, formatDate } from '../format';

const STATUS_TEXT: Record<OrderStatus, string> = {
  pending: 'Waiting for payment',
  paid: 'Delivered',
  failed: 'Failed',
  canceled: 'Canceled',
  expired: 'Not completed',
  refunded: 'Refunded',
  disputed: 'Disputed',
  review: 'In review',
};

function DevLogin() {
  const { refreshMe } = useStore();
  const [steamId, setSteamId] = useState('76561198000000002');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/auth/dev-login', { method: 'POST', body: { steamId } });
      await refreshMe();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Dev sign-in failed');
    }
  };
  return (
    <form className="dev-login" onSubmit={submit}>
      <p className="muted">Development mode: sign in as any SteamID64.</p>
      <input value={steamId} onChange={(e) => setSteamId(e.target.value)} aria-label="SteamID64" />
      <button className="button button--quiet" type="submit">
        Dev sign-in
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </form>
  );
}

export function Account() {
  const { me } = useStore();
  const account = useApi<AccountView>(me.user ? '/account' : null);
  const now = useNow(1000) / 1000;

  if (!me.user) {
    return (
      <div className="container page page--narrow">
        <PageHeader title="My kits" />
        <div className="gate">
          <p>Sign in through Steam to see your kits, cooldowns and orders.</p>
          <SteamSignIn returnTo="/account" />
        </div>
        {me.devLogin && <DevLogin />}
      </div>
    );
  }

  const data = account.data;
  return (
    <div className="container page">
      <div className="profile">
        {me.user.avatarUrl ? (
          <img className="profile__avatar" src={me.user.avatarUrl} alt="" width="64" height="64" />
        ) : (
          <span className="profile__avatar profile__avatar--blank" aria-hidden="true">
            {(me.user.name ?? 'P').slice(0, 1)}
          </span>
        )}
        <div className="profile__text">
          <h1 className="profile__name">{me.user.name ?? 'Your account'}</h1>
          <p className="muted">SteamID {me.user.steamId}</p>
        </div>
        <button type="button" className="button button--quiet" onClick={() => void logout()}>
          Sign out
        </button>
      </div>

      {me.user.banned && <Notice tone="error">This account is banned from the server and cannot use or buy kits.</Notice>}
      {account.error && <Notice tone="error">{account.error}</Notice>}

      <section className="section section--tight" aria-labelledby="my-kits">
        <h2 id="my-kits" className="subhead">
          Active kits
        </h2>
        {data && data.kits.length === 0 && (
          <div className="empty">
            <p>You have no active kits.</p>
            <Link className="button button--go" to="/store">
              Browse kits
            </Link>
          </div>
        )}
        {data && data.kits.length > 0 && (
          <ul className="owned">
            {data.kits.map((k) => {
              const wait = k.nextClaimAt ? k.nextClaimAt - now : 0;
              return (
                <li key={k.kitId} className="owned__row">
                  {k.tier !== null && <TierPlate tier={k.tier} size="sm" />}
                  <span className="owned__name">{k.kitName}</span>
                  <span className={wait > 0 ? 'owned__state' : 'owned__state is-ready'}>{wait > 0 ? `Ready in ${countdown(wait)}` : 'Ready to claim'}</span>
                  <span className="owned__expiry">{k.lifetime ? 'Lifetime access' : `Access until ${formatDate(k.expiresAt!)}`}</span>
                  <span className="owned__command">
                    <code>{k.command}</code>
                    <CopyButton text={k.command} label="Copy" className="button button--quiet button--small" />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="section section--tight" aria-labelledby="my-orders">
        <h2 id="my-orders" className="subhead">
          Orders
        </h2>
        {data && data.orders.length === 0 && <p className="muted">No orders yet.</p>}
        {data && data.orders.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Kit</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.orders.map((o) => (
                  <tr key={o.id}>
                    <td>{formatDate(o.createdAt)}</td>
                    <td>
                      <Link to={`/order/${o.id}`}>
                        {o.kit.name}, {o.duration.label}
                      </Link>
                    </td>
                    <td>{o.charge.display}</td>
                    <td>
                      <span className={`status status--${o.status}`}>{STATUS_TEXT[o.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
