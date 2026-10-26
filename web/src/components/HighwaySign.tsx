import type { ServerStatus } from '../api';
import { useNow } from '../data';
import { countdown, splitAddress } from '../format';

/**
 * The hero: the server as a highway guide sign. The game port doubles as the
 * exit number and the live rows read like distances to the next exits.
 */
export function HighwaySign({ name, region, address, status }: { name: string; region: string; address: string; status: ServerStatus | null }) {
  const now = useNow(1000);
  const { port } = splitAddress(address);
  const wipeIn = status?.nextWipeAt ? (status.nextWipeAt - now) / 1000 : null;
  const players = status
    ? status.online
      ? `${status.players}${status.maxPlayers ? ` / ${status.maxPlayers}` : ''}`
      : 'Offline'
    : '...';

  return (
    <section className="sign" aria-label={`${name} server`}>
      {port && (
        <div className="sign__tab" aria-hidden="true">
          Exit {port}
        </div>
      )}
      <div className="sign__panel">
        <div className="sign__face">
          <div className="sign__heading">
            <h1 className="sign__destination">{name}</h1>
            <svg className="sign__arrow" viewBox="0 0 48 48" aria-hidden="true">
              <path d="M12 36 34 14M17 13h18v18" fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="square" />
            </svg>
          </div>
          <p className="sign__region">{region}</p>
          <dl className="sign__rows">
            <div className="sign__row">
              <dt>Next wipe</dt>
              <dd>{wipeIn === null ? '...' : wipeIn <= 0 ? 'Now' : countdown(wipeIn)}</dd>
            </div>
            <div className="sign__row">
              <dt>{status?.online === false ? 'Server' : 'Online now'}</dt>
              <dd>
                {players}
                {status?.online && status.queued > 0 && <span className="sign__queue"> +{status.queued} in queue</span>}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
