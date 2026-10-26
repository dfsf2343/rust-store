import type { AnyFunction, ArgumentTypes, DB, RunResult, Statement, Transaction } from '../db.js';

type SqlValue = ArrayBuffer | string | number | null;

interface SqlCursor {
  toArray(): Record<string, SqlValue>[];
  one(): Record<string, SqlValue>;
}

/** The parts of DurableObjectStorage this adapter needs. */
export interface SqlBackedStorage {
  sql: { exec(query: string, ...bindings: unknown[]): SqlCursor };
  transactionSync<T>(closure: () => T): T;
}

function bind(params: unknown[]): SqlValue[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (typeof p === 'bigint') return Number(p);
    if (typeof p === 'number' || typeof p === 'string' || p instanceof ArrayBuffer) return p;
    throw new TypeError(`Unsupported SQL parameter type: ${typeof p}`);
  });
}

/** Splits a migration script into statements. The schema has no semicolons inside literals. */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * better-sqlite3-compatible adapter over Durable Object SQLite storage. Statements run
 * synchronously, so the store's synchronous data layer works unchanged.
 */
export class DurableSqlDb implements DB {
  private depth = 0;

  constructor(private readonly storage: SqlBackedStorage) {}

  prepare(sql: string): Statement {
    const { storage } = this;
    return {
      get: (...params: unknown[]) => storage.sql.exec(sql, ...bind(params)).toArray()[0],
      all: (...params: unknown[]) => storage.sql.exec(sql, ...bind(params)).toArray(),
      run: (...params: unknown[]): RunResult => {
        storage.sql.exec(sql, ...bind(params)).toArray();
        const meta = storage.sql.exec('SELECT changes() AS changes, last_insert_rowid() AS id').one();
        return { changes: Number(meta['changes']), lastInsertRowid: Number(meta['id']) };
      },
    };
  }

  exec(sql: string): void {
    for (const statement of splitStatements(sql)) this.storage.sql.exec(statement).toArray();
  }

  /** Durable Objects reject BEGIN/COMMIT; transactionSync is the only way in. Nested calls join the outer transaction. */
  transaction<F extends AnyFunction>(fn: F): Transaction<F> {
    const run = (...args: ArgumentTypes<F>): ReturnType<F> => {
      if (this.depth > 0) return fn(...args) as ReturnType<F>;
      this.depth += 1;
      try {
        return this.storage.transactionSync(() => fn(...args) as ReturnType<F>);
      } finally {
        this.depth -= 1;
      }
    };
    return Object.assign(run, { immediate: run });
  }

  close(): void {}
}
