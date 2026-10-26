export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

// Same shape as better-sqlite3's own Transaction type, so its Database satisfies DB.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFunction = (...args: any[]) => unknown;
export type ArgumentTypes<F extends AnyFunction> = F extends (...args: infer A) => unknown ? A : never;

export interface Transaction<F extends AnyFunction> {
  (...params: ArgumentTypes<F>): ReturnType<F>;
  immediate(...params: ArgumentTypes<F>): ReturnType<F>;
}

/**
 * The subset of the better-sqlite3 API the store uses. Node runs better-sqlite3 directly;
 * Cloudflare runs an adapter over Durable Object SQLite storage (worker/sql.ts).
 */
export interface DB {
  prepare(sql: string): Statement;
  exec(sql: string): unknown;
  transaction<F extends AnyFunction>(fn: F): Transaction<F>;
  close(): unknown;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    steam_id TEXT NOT NULL UNIQUE,
    name TEXT,
    avatar_url TEXT,
    is_banned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip TEXT,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expires ON sessions(expires_at);

  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    steam_id TEXT NOT NULL,
    kit_id TEXT NOT NULL,
    kit_name TEXT NOT NULL,
    duration_id TEXT NOT NULL,
    duration_label TEXT NOT NULL,
    duration_days INTEGER,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL,
    charge_amount INTEGER NOT NULL,
    charge_currency TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_ref TEXT,
    provider_payment_id TEXT,
    status TEXT NOT NULL,
    status_detail TEXT,
    country TEXT,
    ip TEXT,
    terms_accepted_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    paid_at INTEGER,
    paid_amount INTEGER,
    paid_currency TEXT
  );
  CREATE INDEX orders_user ON orders(user_id, created_at);
  CREATE INDEX orders_status ON orders(status, created_at);
  CREATE UNIQUE INDEX orders_provider_ref ON orders(provider, provider_ref) WHERE provider_ref IS NOT NULL;
  CREATE INDEX orders_provider_payment ON orders(provider, provider_payment_id);

  CREATE TABLE grants (
    id INTEGER PRIMARY KEY,
    steam_id TEXT NOT NULL,
    kit_id TEXT NOT NULL,
    days INTEGER,
    granted_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    order_id TEXT UNIQUE REFERENCES orders(id),
    note TEXT,
    created_by TEXT,
    revoked_at INTEGER,
    revoked_reason TEXT
  );
  CREATE INDEX grants_player_kit ON grants(steam_id, kit_id);

  CREATE TABLE entitlements (
    steam_id TEXT NOT NULL,
    kit_id TEXT NOT NULL,
    lifetime INTEGER NOT NULL,
    expires_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (steam_id, kit_id)
  );

  CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    steam_id TEXT NOT NULL,
    kit_id TEXT NOT NULL,
    claimed_at INTEGER NOT NULL,
    server_id TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );
  CREATE INDEX claims_player_kit ON claims(steam_id, kit_id, claimed_at);

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    steam_id TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
  );
  CREATE INDEX notifications_pending ON notifications(delivered_at, created_at);

  CREATE TABLE webhook_events (
    provider TEXT NOT NULL,
    event_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (provider, event_id)
  );

  CREATE TABLE server_status (
    server_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    subject TEXT,
    details TEXT
  );
  CREATE INDEX audit_at ON audit_log(at);
  `,
  // v2: when the background job last asked the payment provider about a pending order.
  `
  ALTER TABLE orders ADD COLUMN checked_at INTEGER;
  `,
];

const META_TABLE = 'CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)';

export function getMeta(db: DB, key: string): string | null {
  db.exec(META_TABLE);
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.exec(META_TABLE);
  db.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Applies pending migrations. `initialVersion` lets older Node databases (tracked with PRAGMA user_version) carry over. */
export function migrate(db: DB, initialVersion = 0): void {
  const stored = getMeta(db, 'schema_version');
  const current = Math.max(stored === null ? 0 : Number(stored), initialVersion);
  for (let v = current; v < MIGRATIONS.length; v++) {
    const sql = MIGRATIONS[v]!;
    db.transaction(() => {
      db.exec(sql);
      setMeta(db, 'schema_version', String(v + 1));
    })();
  }
  if (stored === null && current > 0) setMeta(db, 'schema_version', String(current));
}

export function audit(db: DB, actor: string, action: string, subject: string | null, details?: unknown, at = Math.floor(Date.now() / 1000)) {
  db.prepare('INSERT INTO audit_log (at, actor, action, subject, details) VALUES (?, ?, ?, ?, ?)').run(
    at,
    actor,
    action,
    subject,
    details === undefined ? null : JSON.stringify(details),
  );
}
