import { Link } from 'react-router';
import { CopyButton, TierPlate } from '../components/bits';
import { HighwaySign } from '../components/HighwaySign';
import { useServerStatus, useStore } from '../data';
import { hoursLabel } from '../format';

export function Home() {
  const { site, catalog } = useStore();
  const status = useServerStatus();
  const address = site.connect.address;
  const defaultDuration = catalog.durations.find((d) => d.default) ?? catalog.durations[0]!;

  return (
    <>
      <div className="container hero">
        <HighwaySign name={site.name} region={site.region} address={address} status={status} />
        <div className="connect">
          <div className="connect__address">
            <p className="connect__label">Server address</p>
            <code className="connect__code">{address}</code>
          </div>
          <div className="connect__actions">
            <CopyButton text={`client.connect ${address}`} label="Copy connect command" className="button button--go" />
            <CopyButton text={address} label="Copy address" />
          </div>
          <p className="connect__how">
            Open Rust, press F1 and run <code>client.connect {address}</code>
          </p>
        </div>
      </div>

      <section className="container section" aria-labelledby="about-heading">
        <div className="intro">
          <h2 id="about-heading" className="intro__title">
            {site.tagline}
          </h2>
          <p className="intro__text">{site.description}</p>
        </div>
        <dl className="facts">
          {site.highlights.map((h) => (
            <div key={h.label} className="facts__item">
              <dt>{h.label}</dt>
              <dd>{h.value}</dd>
            </div>
          ))}
          <div className="facts__item">
            <dt>Wipe schedule</dt>
            <dd>{site.wipe.label}</dd>
          </div>
        </dl>
        <div className="features">
          {site.features.map((f) => (
            <div key={f.title} className="feature">
              <h3 className="feature__title">{f.title}</h3>
              <p className="feature__body">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="container section" aria-labelledby="kits-heading">
        <div className="section__head">
          <h2 id="kits-heading" className="section__title">
            Kits
          </h2>
          <p className="section__lead">
            Pay once for {defaultDuration.label.toLowerCase()} or longer, then claim the kit in game every cooldown. Prices below are for {defaultDuration.label}.
          </p>
        </div>
        <ul className="kit-ladder">
          {catalog.kits.map((kit) => (
            <li key={kit.id}>
              <Link className="kit-ladder__row" to={`/store/${kit.id}`}>
                <TierPlate tier={kit.tier} size="sm" />
                <span className="kit-ladder__name">{kit.name}</span>
                <span className="kit-ladder__meta">{hoursLabel(kit.cooldownHours)}</span>
                <span className="kit-ladder__price">{kit.prices[defaultDuration.id]?.display}</span>
              </Link>
            </li>
          ))}
        </ul>
        <Link to="/store" className="button button--go">
          Open the store
        </Link>
      </section>

      {site.links.discord && (
        <section className="container section section--last" aria-labelledby="discord-heading">
          <div className="banner">
            <div>
              <h2 id="discord-heading" className="banner__title">
                Questions, reports and wipe announcements happen on Discord
              </h2>
              <p className="banner__text">Staff answer support tickets there, including anything about store orders.</p>
            </div>
            <a className="button button--light" href={site.links.discord} target="_blank" rel="noreferrer">
              Join the Discord
            </a>
          </div>
        </section>
      )}
    </>
  );
}
