import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, ApiError, type CheckoutOptions, type ProviderId } from '../api';
import { Notice, PageHeader, TierPlate } from '../components/bits';
import { useApi, useStore } from '../data';
import { hoursLabel } from '../format';
import { NotFound } from './NotFound';

const PROVIDER_NAMES: Record<ProviderId, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
  mercadopago: 'Mercado Pago',
};

const STEAM_INPUT_RE = /^(?:7656119\d{10}|(?:https?:\/\/)?(?:www\.)?steamcommunity\.com\/(?:profiles\/7656119\d{10}|id\/[A-Za-z0-9_-]{2,32})\/?)$/i;

export function Checkout() {
  const { kitId } = useParams();
  const [params] = useSearchParams();
  const { catalog, me } = useStore();
  const navigate = useNavigate();
  const kit = catalog.kits.find((k) => k.id === kitId);
  const durationId = params.get('d') ?? (catalog.durations.find((d) => d.default) ?? catalog.durations[0]!).id;
  const duration = catalog.durations.find((d) => d.id === durationId);
  const options = useApi<CheckoutOptions>(kit && duration ? `/checkout/options?kitId=${kit.id}&durationId=${duration.id}` : null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [steamInput, setSteamInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const first = options.data?.providers[0];
    if (first && !options.data?.providers.some((p) => p.id === provider)) setProvider(first.id);
  }, [options.data, provider]);

  if (!kit || !duration) return <NotFound />;
  const price = kit.prices[duration.id];
  const selected = options.data?.providers.find((p) => p.id === provider) ?? null;
  const steamOk = STEAM_INPUT_RE.test(steamInput.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!selected || !accepted || (!me.user && !steamOk)) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await api<{ orderId: string; redirectUrl: string }>('/checkout', {
        method: 'POST',
        body: { kitId: kit.id, durationId: duration.id, provider: selected.id, acceptTerms: true, ...(me.user ? {} : { steamId: steamInput.trim() }) },
      });
      // The demo build has no payment page: its stand-in API returns an in-app path.
      if (import.meta.env.MODE === 'demo') navigate(res.redirectUrl);
      else window.location.assign(res.redirectUrl);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Checkout could not start. Check your connection and try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="container page page--narrow">
      <p className="crumbs">
        <Link to={`/store/${kit.id}?d=${duration.id}`}>Back to {kit.name}</Link>
      </p>
      <PageHeader title="Checkout" />

      <div className="summary">
        <TierPlate tier={kit.tier} size="md" />
        <div className="summary__body">
          <p className="summary__name">{kit.name} kit</p>
          <p className="summary__meta">
            {duration.label} of access, claimable {hoursLabel(kit.cooldownHours).toLowerCase()}
          </p>
        </div>
        <p className="summary__price">{price?.display}</p>
      </div>

      {me.user?.banned ? (
        <Notice tone="error">This Steam account cannot make purchases. Contact staff on Discord if you think this is a mistake.</Notice>
      ) : (
        <form className="pay" onSubmit={submit}>
          {me.user ? (
            <p className="pay__buyer">
              Delivering to <strong>{me.user.name ?? 'your account'}</strong> <span className="muted">(SteamID {me.user.steamId})</span>
            </p>
          ) : (
            <label className="field">
              <span className="field__label">Steam account that gets the kit</span>
              <input
                className="field__input"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                placeholder="76561198000000000 or steamcommunity.com/profiles/..."
                value={steamInput}
                onChange={(e) => setSteamInput(e.target.value)}
                aria-invalid={steamInput.trim() !== '' && !steamOk}
                required
              />
              <span className="fine-print">
                Paste your SteamID64 or your Steam profile link. Find it in Steam under your profile, then Copy page URL. Check it carefully: the kit goes to this account.
              </span>
            </label>
          )}

          {options.loading && <p className="muted">Loading payment options...</p>}
          {options.error && <Notice tone="error">{options.error}</Notice>}
          {options.data && options.data.providers.length === 0 && (
            <Notice tone="warn">Online checkout is not available right now. Contact staff on Discord to buy this kit.</Notice>
          )}

          {options.data && options.data.providers.length > 0 && (
            <fieldset className="methods">
              <legend className="methods__legend">
                Payment method
                <span className="methods__region">
                  {options.data.countryName ? `Options for ${options.data.countryName}` : 'Options for your location'}
                </span>
              </legend>
              {options.data.providers.map((p) => (
                <label key={p.id} className={p.id === provider ? 'method is-selected' : 'method'}>
                  <input type="radio" name="provider" value={p.id} checked={p.id === provider} onChange={() => setProvider(p.id)} />
                  <span className="method__text">
                    <span className="method__label">{p.label}</span>
                    <span className="method__desc">{p.description}</span>
                  </span>
                  {p.charge && <span className="method__charge">{p.charge.display}</span>}
                </label>
              ))}
              {selected?.charge && selected.charge.currency !== 'USD' && (
                <p className="fine-print">
                  Charged in {selected.charge.currency} at the store's exchange rate. Your bank may add its own conversion fees.
                </p>
              )}
            </fieldset>
          )}

          <label className="consent">
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
            <span>
              I agree to the <Link to="/terms">terms of service</Link> and the <Link to="/refunds">refund policy</Link>. I ask for the kit to be delivered right away and understand that all purchases are final, so I lose any right to cancel once it is delivered.
            </span>
          </label>

          {error && <Notice tone="error">{error}</Notice>}

          <button className="button button--go button--large button--block" type="submit" disabled={!selected || !accepted || submitting || (!me.user && !steamOk)}>
            {submitting
              ? 'Opening secure checkout...'
              : selected
                ? `Pay ${selected.charge?.display ?? price?.display} with ${PROVIDER_NAMES[selected.id]}`
                : 'Pay'}
          </button>
          <p className="fine-print">You will finish paying on {selected ? PROVIDER_NAMES[selected.id] : 'the payment provider'}'s secure page and come back here automatically.</p>
        </form>
      )}
    </div>
  );
}
