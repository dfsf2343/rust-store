import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createNodeContext } from './context-node.js';
import { reconcilePending, housekeeping as runHousekeeping } from './maintenance.js';

const config = loadConfig();
const ctx = createNodeContext(config);
const { log } = ctx;

for (const warning of config.warnings) log.warn(warning);
log.info(
  {
    env: config.env,
    baseUrl: config.baseUrl,
    providers: [...ctx.providers.enabled],
    admins: config.adminSteamIds.size,
    web: config.webDistDir ?? 'not built',
  },
  'Starting store',
);
if (ctx.providers.enabled.size === 0) log.warn('No payment provider is configured: checkout is disabled.');

// GeoIP: load what is on disk now, then refresh in the background.
ctx.geo.loadFromDisk();
if (config.geo.autoUpdate) {
  void ctx.geo.updateIfStale(config.geo.baseUrl);
  setInterval(() => void ctx.geo.updateIfStale(config.geo.baseUrl), 6 * 3_600_000).unref();
}

function housekeeping() {
  try {
    runHousekeeping(ctx);
  } catch (err) {
    log.error({ err }, 'Housekeeping failed');
  }
  reconcilePending(ctx).catch((err: unknown) => log.error({ err }, 'Payment reconciliation failed'));
}
housekeeping();
setInterval(housekeeping, 10 * 60_000).unref();

const app = createApp(ctx);
const server = app.listen(config.port, config.host, () => {
  log.info({ port: config.port, host: config.host }, 'Store listening');
});

process.on('SIGHUP', () => {
  try {
    ctx.reloadContent();
  } catch (err) {
    log.error({ err: (err as Error).message }, 'Content reload failed; keeping the previous version');
  }
});

function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down');
  server.close(() => {
    ctx.db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
