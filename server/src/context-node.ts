import path from 'node:path';
import pino, { type Logger } from 'pino';
import type { AppConfig } from './config.js';
import { loadContent } from './content.js';
import { createContext, type AppContext } from './context.js';
import { openDatabase } from './db-node.js';
import { GeoIp } from './geo/geoip.js';
import type { ProviderOverrides } from './payments/index.js';

export interface NodeContextOptions extends ProviderOverrides {
  dbFile?: string;
  logger?: Logger;
  now?: () => number;
}

export type NodeAppContext = AppContext & { geo: GeoIp };

export function createNodeContext(config: AppConfig, opts: NodeContextOptions = {}): NodeAppContext {
  const log = opts.logger ?? pino({ level: config.logLevel, base: undefined });
  const db = openDatabase(opts.dbFile ?? path.join(config.dataDir, 'store.sqlite'));
  const geo = new GeoIp(path.join(config.dataDir, 'geoip'), log.child({ module: 'geoip' }));
  const ctx = createContext(config, { ...opts, db, logger: log, loadContent: () => loadContent(config.configDir), geo });
  return { ...ctx, geo };
}
