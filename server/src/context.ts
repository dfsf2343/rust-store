import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { Content } from './content.js';
import type { DB } from './db.js';
import type { GeoLookup } from './geo/routing.js';
import { systemClock } from './lib/util.js';
import { createProviders, type ProviderOverrides, type Providers } from './payments/index.js';
import { OrderService } from './store/orders.js';

export interface AppContext {
  config: AppConfig;
  db: DB;
  content: () => Content;
  reloadContent: () => Content;
  orders: OrderService;
  providers: Providers;
  geo: GeoLookup;
  log: Logger;
  now: () => number;
  fetchFn: typeof fetch;
}

export interface ContextDeps extends ProviderOverrides {
  db: DB;
  logger: Logger;
  /** Reads and validates the config files. Called once at startup and again on reload. */
  loadContent: () => Content;
  geo: GeoLookup;
  now?: () => number;
}

/** Runtime-neutral wiring. context-node.ts and worker.ts supply the database, logger and content source. */
export function createContext(config: AppConfig, deps: ContextDeps): AppContext {
  const log = deps.logger;
  const now = deps.now ?? systemClock;
  const db = deps.db;
  let current = deps.loadContent();
  const content = () => current;
  const reloadContent = () => {
    current = deps.loadContent();
    log.info({ catalogVersion: current.catalogVersion }, 'Content reloaded');
    return current;
  };
  const orders = new OrderService(db, content, log.child({ module: 'orders' }), now);
  const providers = createProviders(config, content, orders, log, now, deps);
  return { config, db, content, reloadContent, orders, providers, geo: deps.geo, log, now, fetchFn: deps.fetchFn ?? fetch };
}
