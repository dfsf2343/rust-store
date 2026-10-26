import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, ApiError, type AccountKit, type Order, type OrderStatus, type ServerStatus } from '../api';
import { Notice, PageHeader } from '../components/bits';
import { useApi, useStore } from '../data';
import { formatDateTime } from '../format';
import { NotFound } from './NotFound';

type AdminOrder = Order & { steamId: string; country?: string | null; providerRef?: string | null };

interface Overview {
  revenue: Record<'day' | 'week' | 'month' | 'all', { orders: number; cents: number; display: string }>;
  byKit: { kitId: string; kitName: string; orders: number; display: string }[];
  byProvider: { provider: string; orders: number; display: string }[];
  activeEntitlements: number;
  attention: AdminOrder[];
  recent: AdminOrder[];
  server: ServerStatus;
  system: {
    runtime: 'node' | 'cloudflare';
    providers: string[];
    stripeWebhooks: boolean;
    geoipReady: boolean;
    geoHeader: string | null;
    pluginConfigured: boolean;
    warnings: string[];
    catalogVersion: string;
  };
}

interface PlayerView {
  steamId: string;
  user: { name: string | null; banned: boolean; lastLoginAt: number } | null;
  kits: AccountKit[];
  grants: { id: number; kitId: string; days: number | null; grantedAt: number; source: string; orderId: string | null; note: string | null; createdBy: string | null; revokedAt: number | null; revokedReason: string | null }[];
  orders: Order[];
  claims: { kitId: string; claimedAt: number; serverId: string }[];
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

const STATUSES: OrderStatus[] = ['pending', 'paid', 'review', 'disputed', 'refunded', 'failed', 'canceled', 'expired'];

function useAction() {
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      setMessage({ tone: 'ok', text: ok });
      return true;
    } catch (err) {
      setMessage({ tone: 'error', text: err instanceof ApiError ? err.message : 'Request failed' });
      return false;
    }
  };
  return { message, run };
}

function OrdersTable({ orders, onRecheck, onApprove }: { orders: AdminOrder[]; onRecheck: (id: string) => void; onApprove: (id: string) => void }) {
  if (orders.length === 0) return <p className="muted">No orders.</p>;
  return (
    <div className="table-wrap">
      <table className="table table--dense">
        <thead>
          <tr>
            <th scope="col">Placed</th>
            <th scope="col">Order</th>
            <th scope="col">Player</th>
            <th scope="col">Kit</th>
            <th scope="col">Charge</th>
            <th scope="col">Provider</th>
            <th scope="col">Status</th>
            <th scope="col">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>{formatDateTime(o.createdAt)}</td>
              <td>
                <Link to={`/order/${o.id}`}>
                  <code>{o.id}</code>
                </Link>
              </td>
              <td>
                <code>{o.steamId}</code>
              </td>
              <td>
                {o.kit.name}, {o.duration.label}
              </td>
              <td>{o.charge.display}</td>
              <td>{o.provider}</td>
              <td>
                <span className={`status status--${o.status}`}>{o.status}</span>
                {o.statusDetail && <span className="muted table__detail">{o.statusDetail}</span>}
              </td>
              <td>
                {o.status === 'review' ? (
                  <button
                    type="button"
                    className="button button--quiet button--small"
                    title="Deliver the kit after checking the payment in the provider dashboard"
                    onClick={() => onApprove(o.id)}
                  >
                    Approve
                  </button>
                ) : (
                  o.status !== 'paid' &&
                  o.status !== 'refunded' && (
                    <button type="button" className="button button--quiet button--small" onClick={() => onRecheck(o.id)}>
                      Recheck
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GrantForm({ onDone, presetSteamId }: { onDone: () => void; presetSteamId?: string }) {
  const { catalog } = useStore();
  const [steamId, setSteamId] = useState(presetSteamId ?? '');
  const [kitId, setKitId] = useState(catalog.kits[0]?.id ?? '');
  const [durationId, setDurationId] = useState(catalog.durations.find((d) => d.default)?.id ?? catalog.durations[0]?.id ?? '');
  const [note, setNote] = useState('');
  const { message, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api('/admin/grants', { method: 'POST', body: { steamId: steamId.trim(), kitId, durationId, note: note || undefined } }), 'Kit granted. The player is notified in game.');
    if (ok) onDone();
  };
  return (
    <form className="admin-form" onSubmit={submit}>
      <label>
        SteamID64
        <input required pattern="7656119[0-9]{10}" value={steamId} onChange={(e) => setSteamId(e.target.value)} />
      </label>
      <label>
        Kit
        <select value={kitId} onChange={(e) => setKitId(e.target.value)}>
          {catalog.kits.map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Access
        <select value={durationId} onChange={(e) => setDurationId(e.target.value)}>
          {catalog.durations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Note
        <input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Giveaway winner" />
      </label>
      <button className="button button--go" type="submit">
        Grant kit
      </button>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
    </form>
  );
}

function PlayerLookup() {
  const [query, setQuery] = useState('');
  const [steamId, setSteamId] = useState<string | null>(null);
  const player = useApi<PlayerView>(steamId ? `/admin/players/${steamId}` : null);
  const { message, run } = useAction();
  const [revoking, setRevoking] = useState<{ id: number; reason: string } | null>(null);

  const revoke = async (e: FormEvent) => {
    e.preventDefault();
    if (!revoking || !revoking.reason.trim()) return;
    const { id, reason } = revoking;
    if (await run(() => api(`/admin/grants/${id}/revoke`, { method: 'POST', body: { reason: reason.trim() } }), 'Grant revoked.')) {
      setRevoking(null);
      player.reload();
    }
  };
  const setBan = async (banned: boolean) => {
    if (steamId && (await run(() => api(`/admin/players/${steamId}/ban`, { method: 'POST', body: { banned } }), banned ? 'Player banned from the store.' : 'Player unbanned.'))) player.reload();
  };

  return (
    <div>
      <form
        className="admin-form admin-form--inline"
        onSubmit={(e) => {
          e.preventDefault();
          setSteamId(query.trim());
        }}
      >
        <label>
          SteamID64
          <input required pattern="7656119[0-9]{10}" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <button className="button button--quiet" type="submit">
          Look up
        </button>
      </form>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {player.error && <Notice tone="error">{player.error}</Notice>}
      {player.data && (
        <div className="player">
          <p>
            <strong>{player.data.user?.name ?? 'Never signed in'}</strong> <code>{player.data.steamId}</code>{' '}
            {player.data.user?.banned ? <span className="status status--disputed">banned</span> : null}
          </p>
          <p>
            <button type="button" className="button button--quiet button--small" onClick={() => void setBan(!player.data?.user?.banned)}>
              {player.data.user?.banned ? 'Unban from store' : 'Ban from store'}
            </button>
          </p>
          <h3 className="subhead subhead--small">Active kits</h3>
          {player.data.kits.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul className="plain-list">
              {player.data.kits.map((k) => (
                <li key={k.kitId}>
                  {k.kitName}: {k.lifetime ? 'lifetime' : `until ${formatDateTime(k.expiresAt!)}`}
                  {k.lastClaimAt ? `, last claimed ${formatDateTime(k.lastClaimAt)}` : ', never claimed'}
                </li>
              ))}
            </ul>
          )}
          <h3 className="subhead subhead--small">Grants</h3>
          <ul className="plain-list">
            {player.data.grants.map((g) => (
              <li key={g.id}>
                #{g.id} {g.kitId}, {g.days === null ? 'lifetime' : `${g.days} days`} from {formatDateTime(g.grantedAt)} ({g.source}
                {g.note ? `: ${g.note}` : ''}){' '}
                {g.revokedAt ? (
                  <span className="muted">revoked: {g.revokedReason}</span>
                ) : revoking?.id === g.id ? (
                  <form className="revoke-form" onSubmit={(e) => void revoke(e)}>
                    <label>
                      <span className="visually-hidden">Reason for revoking grant {g.id}</span>
                      <input
                        id={`revoke-reason-${g.id}`}
                        required
                        maxLength={200}
                        placeholder="Reason, for example chargeback"
                        value={revoking.reason}
                        onChange={(e) => setRevoking({ id: g.id, reason: e.target.value })}
                      />
                    </label>
                    <button type="submit" className="button button--quiet button--small">
                      Revoke grant
                    </button>
                    <button type="button" className="link-button" onClick={() => setRevoking(null)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button type="button" className="link-button" onClick={() => setRevoking({ id: g.id, reason: '' })}>
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
          <h3 className="subhead subhead--small">Recent claims</h3>
          {player.data.claims.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <ul className="plain-list">
              {player.data.claims.map((c, i) => (
                <li key={i}>
                  {c.kitId} at {formatDateTime(c.claimedAt)} on {c.serverId}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export function Admin() {
  const { me } = useStore();
  const overview = useApi<Overview>(me.user?.isAdmin ? '/admin/overview' : null);
  const [filter, setFilter] = useState<{ status: string; q: string }>({ status: '', q: '' });
  const [search, setSearch] = useState('');
  const ordersPath = me.user?.isAdmin ? `/admin/orders?limit=50${filter.status ? `&status=${filter.status}` : ''}${filter.q ? `&q=${encodeURIComponent(filter.q)}` : ''}` : null;
  const orders = useApi<{ orders: AdminOrder[] }>(ordersPath);
  const { message, run } = useAction();

  if (!me.user?.isAdmin) return <NotFound />;
  const o = overview.data;

  const recheck = async (id: string) => {
    if (await run(() => api(`/admin/orders/${id}/refresh`, { method: 'POST', body: {} }), 'Order rechecked with the provider.')) {
      orders.reload();
      overview.reload();
    }
  };

  const approve = async (id: string) => {
    if (await run(() => api(`/admin/orders/${id}/approve`, { method: 'POST', body: {} }), 'Order approved and the kit delivered.')) {
      orders.reload();
      overview.reload();
    }
  };

  return (
    <div className="container page admin">
      <PageHeader title="Store admin" />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {overview.error && <Notice tone="error">{overview.error}</Notice>}
      {o && (
        <>
          {o.system.warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
          <dl className="stats">
            <div>
              <dt>Last 24 hours</dt>
              <dd>{o.revenue.day.display}</dd>
              <dd className="muted">{plural(o.revenue.day.orders, 'order')}</dd>
            </div>
            <div>
              <dt>Last 7 days</dt>
              <dd>{o.revenue.week.display}</dd>
              <dd className="muted">{plural(o.revenue.week.orders, 'order')}</dd>
            </div>
            <div>
              <dt>Last 30 days</dt>
              <dd>{o.revenue.month.display}</dd>
              <dd className="muted">{plural(o.revenue.month.orders, 'order')}</dd>
            </div>
            <div>
              <dt>All time</dt>
              <dd>{o.revenue.all.display}</dd>
              <dd className="muted">{plural(o.activeEntitlements, 'active kit pass', 'active kit passes')}</dd>
            </div>
          </dl>
          <div className="admin-grid">
            <section>
              <h2 className="subhead">System</h2>
              <ul className="plain-list">
                <li>Game server: {o.server.online ? `online, ${o.server.players} players` : 'no contact from the plugin in the last 90 seconds'}</li>
                <li>Payment providers: {o.system.providers.length ? o.system.providers.join(', ') : 'none configured'}</li>
                <li>Stripe webhooks: {o.system.stripeWebhooks ? 'on' : 'off'}</li>
                <li>
                  Location lookup:{' '}
                  {o.system.runtime === 'cloudflare'
                    ? 'Cloudflare edge country'
                    : o.system.geoHeader
                      ? `header ${o.system.geoHeader}`
                      : o.system.geoipReady
                        ? 'IP database loaded'
                        : 'IP database not loaded yet'}
                </li>
                <li>Plugin secret: {o.system.pluginConfigured ? 'set' : 'missing'}</li>
              </ul>
              {o.system.runtime === 'cloudflare' ? (
                <p className="muted">Kits, prices and texts live in the config folder of the GitHub repository. Edit them there and the site redeploys in about a minute.</p>
              ) : (
                <button
                  type="button"
                  className="button button--quiet button--small"
                  onClick={() => void run(() => api('/admin/reload', { method: 'POST', body: {} }), 'Config files reloaded. Refresh the page to see changes.')}
                >
                  Reload config files
                </button>
              )}
            </section>
            <section>
              <h2 className="subhead">Last 30 days by kit</h2>
              <ul className="plain-list">
                {o.byKit.length === 0 && <li className="muted">No sales yet.</li>}
                {o.byKit.map((k) => (
                  <li key={k.kitId}>
                    {k.kitName}: {k.display} ({k.orders})
                  </li>
                ))}
              </ul>
              <h2 className="subhead">By provider</h2>
              <ul className="plain-list">
                {o.byProvider.length === 0 && <li className="muted">No sales yet.</li>}
                {o.byProvider.map((p) => (
                  <li key={p.provider}>
                    {p.provider}: {p.display} ({p.orders})
                  </li>
                ))}
              </ul>
            </section>
          </div>
          {o.attention.length > 0 && (
            <section className="section section--tight">
              <h2 className="subhead">Needs attention</h2>
              <OrdersTable orders={o.attention} onRecheck={(id) => void recheck(id)} onApprove={(id) => void approve(id)} />
            </section>
          )}
        </>
      )}

      <section className="section section--tight">
        <h2 className="subhead">Orders</h2>
        <form
          className="admin-form admin-form--inline"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter((f) => ({ ...f, q: search.trim() }));
          }}
        >
          <label>
            Search
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order ID, SteamID or provider reference" />
          </label>
          <label>
            Status
            <select value={filter.status} onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}>
              <option value="">Any</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button className="button button--quiet" type="submit">
            Search
          </button>
        </form>
        {orders.error && <Notice tone="error">{orders.error}</Notice>}
        {orders.data && <OrdersTable orders={orders.data.orders} onRecheck={(id) => void recheck(id)} onApprove={(id) => void approve(id)} />}
      </section>

      <div className="admin-grid section section--tight">
        <section>
          <h2 className="subhead">Grant a kit</h2>
          <GrantForm
            onDone={() => {
              overview.reload();
            }}
          />
        </section>
        <section>
          <h2 className="subhead">Player lookup</h2>
          <PlayerLookup />
        </section>
      </div>
    </div>
  );
}
