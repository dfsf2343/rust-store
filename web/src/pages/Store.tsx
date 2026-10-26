import { Link, useParams, useSearchParams } from 'react-router';
import type { Account, AccountKit, Catalog, Kit } from '../api';
import { DurationPicker, Notice, PageHeader, TierPlate } from '../components/bits';
import { Inventory } from '../components/Inventory';
import { useApi, useStore } from '../data';
import { formatDate, hoursLabel } from '../format';
import { NotFound } from './NotFound';

function useDuration(catalog: Catalog): [string, (id: string) => void] {
  const [params, setParams] = useSearchParams();
  const fallback = (catalog.durations.find((d) => d.default) ?? catalog.durations[0]!).id;
  const requested = params.get('d');
  const value = requested && catalog.durations.some((d) => d.id === requested) ? requested : fallback;
  const set = (id: string) => {
    const next = new URLSearchParams(params);
    next.set('d', id);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  return [value, set];
}

function useOwnership() {
  const { me } = useStore();
  const account = useApi<Account>(me.user ? '/account' : null);
  return new Map((account.data?.kits ?? []).map((k) => [k.kitId, k]));
}

function OwnedNote({ owned }: { owned: AccountKit | undefined }) {
  if (!owned) return null;
  return (
    <p className="kit__owned">
      {owned.lifetime ? 'You own this kit for life.' : `Active until ${formatDate(owned.expiresAt!)}. Buying again adds time.`}
    </p>
  );
}

function KitPanel({ kit, durationId, durationLabel, iconUrl, owned }: { kit: Kit; durationId: string; durationLabel: string; iconUrl: string | null; owned: AccountKit | undefined }) {
  const price = kit.prices[durationId];
  return (
    <article className="kit" aria-labelledby={`kit-${kit.id}`}>
      <div className="kit__plate">
        <TierPlate tier={kit.tier} size="lg" />
      </div>
      <div className="kit__body">
        <h2 id={`kit-${kit.id}`} className="kit__name">
          <Link to={`/store/${kit.id}?d=${durationId}`}>{kit.name}</Link>
        </h2>
        <p className="kit__tagline">{kit.tagline}</p>
        <p className="kit__meta">Claim in game {hoursLabel(kit.cooldownHours).toLowerCase()}</p>
        <Inventory items={kit.items} iconUrl={iconUrl} compact />
      </div>
      <div className="kit__buy">
        <p className="kit__price">
          <span className="kit__amount">{price?.display}</span>
          <span className="kit__per">for {durationLabel.toLowerCase()}</span>
        </p>
        <Link className="button button--go" to={`/checkout/${kit.id}?d=${durationId}`}>
          Buy {kit.name}
        </Link>
        <OwnedNote owned={owned} />
      </div>
    </article>
  );
}

export function Store() {
  const { site, catalog } = useStore();
  const [durationId, setDuration] = useDuration(catalog);
  const [params] = useSearchParams();
  const duration = catalog.durations.find((d) => d.id === durationId)!;
  const owned = useOwnership();

  return (
    <div className="container page">
      <PageHeader title="Kits">
        <p>
          Every kit is claimed in game on a cooldown for as long as your access lasts. Pick how long you want access, then the kit.
        </p>
      </PageHeader>

      {params.get('canceled') && <Notice tone="warn">Checkout was canceled. Nothing was charged.</Notice>}

      <ol className="steps" aria-label="How delivery works">
        <li className="steps__item">
          <span className="steps__title">Pay on this site</span>
          <span className="steps__text">Sign in through Steam so the kit lands on the right account.</span>
        </li>
        <li className="steps__item">
          <span className="steps__title">Join the server</span>
          <span className="steps__text">Access is usually active within 30 seconds of paying.</span>
        </li>
        <li className="steps__item">
          <span className="steps__title">
            Type <code>/{site.store.inGameCommand}</code> in chat
          </span>
          <span className="steps__text">Your kits and cooldowns are listed there.</span>
        </li>
      </ol>

      <div className="store-bar">
        <DurationPicker durations={catalog.durations} value={durationId} onChange={setDuration} label="Access length" />
      </div>

      <div className="kit-list">
        {catalog.kits.map((kit) => (
          <KitPanel key={kit.id} kit={kit} durationId={durationId} durationLabel={duration.label} iconUrl={site.store.itemIconUrl} owned={owned.get(kit.id)} />
        ))}
      </div>

      <p className="fine-print">
        Prices are in US dollars. Buyers in South America pay in local currency through Mercado Pago. Kits contain only base-game items with default skins. See the{' '}
        <Link to="/refunds">refund policy</Link> before buying.
      </p>
    </div>
  );
}

export function KitPage() {
  const { kitId } = useParams();
  const { site, catalog } = useStore();
  const [durationId, setDuration] = useDuration(catalog);
  const owned = useOwnership();
  const kit = catalog.kits.find((k) => k.id === kitId);
  if (!kit) return <NotFound />;
  const duration = catalog.durations.find((d) => d.id === durationId)!;
  const price = kit.prices[durationId];

  return (
    <div className="container page">
      <p className="crumbs">
        <Link to={`/store?d=${durationId}`}>All kits</Link>
      </p>
      <div className="kit-detail">
        <TierPlate tier={kit.tier} size="lg" />
        <div className="kit-detail__head">
          <h1 className="kit-detail__name">{kit.name}</h1>
          <p className="kit-detail__tagline">{kit.tagline}</p>
          <p className="kit__meta">
            Claim in game {hoursLabel(kit.cooldownHours).toLowerCase()} with <code>/{site.store.inGameCommand} {kit.id}</code>
          </p>
        </div>
      </div>

      <h2 className="subhead">What you get each claim</h2>
      <Inventory items={kit.items} iconUrl={site.store.itemIconUrl} />

      <div className="kit-detail__buy">
        <DurationPicker durations={catalog.durations} value={durationId} onChange={setDuration} kit={kit} label="Access length" />
        <div className="kit-detail__cta">
          <p className="kit__price">
            <span className="kit__amount">{price?.display}</span>
            <span className="kit__per">for {duration.label.toLowerCase()}</span>
          </p>
          <Link className="button button--go button--large" to={`/checkout/${kit.id}?d=${durationId}`}>
            Continue to checkout
          </Link>
          <OwnedNote owned={owned.get(kit.id)} />
        </div>
      </div>
    </div>
  );
}
