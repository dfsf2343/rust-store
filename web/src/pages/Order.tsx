import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { api, ApiError, type Order as OrderView } from '../api';
import { CopyButton, Notice, PageHeader, SteamSignIn, Spinner } from '../components/bits';
import { useStore } from '../data';
import { formatDateTime } from '../format';

const POLL_MS = 3000;
const MAX_POLLS = 60;

export function Order() {
  const { orderId } = useParams();
  const [params] = useSearchParams();
  const { me, site } = useStore();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const polls = useRef(0);

  useEffect(() => {
    if (!me.user || !orderId) return;
    let alive = true;
    let timer: number | undefined;
    // Mercado Pago appends payment_id (or collection_id) when it sends the buyer back.
    const paymentId = params.get('payment_id') ?? params.get('collection_id');

    const tick = async (refresh: boolean) => {
      try {
        const next = refresh
          ? await api<OrderView>(`/orders/${orderId}/refresh`, { method: 'POST', body: paymentId && /^\d+$/.test(paymentId) ? { paymentId } : {} })
          : await api<OrderView>(`/orders/${orderId}`);
        if (!alive) return;
        setOrder(next);
        if (next.status === 'pending') {
          polls.current += 1;
          if (polls.current >= MAX_POLLS) {
            setGaveUp(true);
            return;
          }
          // Ask the provider directly every fifth poll in case a webhook is slow.
          timer = window.setTimeout(() => void tick(polls.current % 5 === 0), POLL_MS);
        }
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err.message : 'Could not load this order.');
      }
    };
    void tick(true);
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [me.user, orderId, params]);

  if (!me.user) {
    return (
      <div className="container page page--narrow">
        <PageHeader title="Order" />
        <div className="gate">
          <p>Sign in through Steam to see this order.</p>
          <SteamSignIn />
        </div>
      </div>
    );
  }

  return (
    <div className="container page page--narrow">
      <PageHeader title={order ? `${order.kit.name} kit, ${order.duration.label}` : 'Order'} />
      {params.get('error') === 'capture' && <Notice tone="error">PayPal approved the payment but we could not confirm it yet. Refresh this page in a minute.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {!order && !error && <Spinner label="Loading your order" />}
      {order && <OrderState order={order} gaveUp={gaveUp} discord={site.links.discord} />}
      {order && (
        <dl className="details">
          <div>
            <dt>Order</dt>
            <dd>
              <code>{order.id}</code>
            </dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>
              {order.charge.display}
              {order.charge.currency !== order.amount.currency && <span className="muted"> ({order.amount.display})</span>}
            </dd>
          </div>
          <div>
            <dt>Placed</dt>
            <dd>{formatDateTime(order.createdAt)}</dd>
          </div>
          {order.paidAt && (
            <div>
              <dt>Paid</dt>
              <dd>{formatDateTime(order.paidAt)}</dd>
            </div>
          )}
        </dl>
      )}
      <p className="crumbs">
        <Link to="/account">Go to my kits</Link>
      </p>
    </div>
  );
}

function OrderState({ order, gaveUp, discord }: { order: OrderView; gaveUp: boolean; discord: string | null }) {
  switch (order.status) {
    case 'paid':
      return (
        <div className="result result--ok">
          <h2 className="result__title">Kit delivered</h2>
          <p>Join the server and type this in chat to claim it:</p>
          <div className="command">
            <code>{order.command}</code>
            <CopyButton text={order.command} label="Copy" />
          </div>
          <p className="muted">If you are already in game, the kit is usable right now.</p>
        </div>
      );
    case 'pending':
      return (
        <div className="result">
          {gaveUp ? (
            <>
              <h2 className="result__title">Still waiting for the payment</h2>
              <p>
                Some payment methods take longer to clear. The kit is delivered automatically once it does, even if you close this page.
                {discord && (
                  <>
                    {' '}
                    If it takes more than an hour, <a href={discord}>open a ticket on Discord</a> with your order ID.
                  </>
                )}
              </p>
            </>
          ) : (
            <>
              <Spinner label="Waiting for the payment to confirm" />
              <p className="muted">This usually takes a few seconds. You can close this page: the kit is delivered as soon as the payment clears.</p>
            </>
          )}
        </div>
      );
    case 'review':
      return (
        <div className="result result--warn">
          <h2 className="result__title">Payment received, waiting for review</h2>
          <p>The paid amount did not match the order, so staff will check it by hand. You do not need to pay again.</p>
        </div>
      );
    case 'refunded':
      return (
        <div className="result result--stop">
          <h2 className="result__title">Refunded</h2>
          <p>This order was refunded and the kit access was removed.</p>
        </div>
      );
    case 'disputed':
      return (
        <div className="result result--stop">
          <h2 className="result__title">Payment disputed</h2>
          <p>A dispute was opened with the payment provider, so the kit access is paused until it is resolved.</p>
        </div>
      );
    default:
      return (
        <div className="result result--stop">
          <h2 className="result__title">The payment did not go through</h2>
          <p>Nothing was charged for this order. {order.statusDetail ? `Reason: ${order.statusDetail}.` : ''}</p>
          <Link className="button button--go" to={`/checkout/${order.kit.id}?d=${order.duration.id}`}>
            Try again
          </Link>
        </div>
      );
  }
}
