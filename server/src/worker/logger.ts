import type { Logger } from 'pino';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Number.POSITIVE_INFINITY } as const;
export type LogLevel = keyof typeof LEVELS;

function serialize(value: unknown): unknown {
  if (value instanceof Error) return { type: value.name, message: value.message, stack: value.stack };
  return value;
}

/**
 * pino-compatible logger that writes one JSON line per entry to the console,
 * which Workers Logs captures. Only the methods the store uses are implemented.
 */
export function consoleLogger(level: LogLevel, bindings: Record<string, unknown> = {}): Logger {
  const min = LEVELS[level];
  const write =
    (name: Exclude<LogLevel, 'silent'>, sink: 'log' | 'warn' | 'error') =>
    (objOrMsg?: unknown, msg?: string): void => {
      if (LEVELS[name] < min) return;
      const fields: Record<string, unknown> = {};
      if (typeof objOrMsg === 'object' && objOrMsg !== null) {
        for (const [k, v] of Object.entries(objOrMsg)) fields[k] = serialize(v);
      }
      const message = typeof objOrMsg === 'string' ? objOrMsg : msg;
      let line: string;
      try {
        line = JSON.stringify({ level: name, ...bindings, ...fields, msg: message });
      } catch {
        line = JSON.stringify({ level: name, ...bindings, msg: message, note: 'fields not serializable' });
      }
      console[sink](line);
    };
  const logger = {
    level,
    trace: write('trace', 'log'),
    debug: write('debug', 'log'),
    info: write('info', 'log'),
    warn: write('warn', 'warn'),
    error: write('error', 'error'),
    fatal: write('fatal', 'error'),
    child: (extra: Record<string, unknown>) => consoleLogger(level, { ...bindings, ...extra }),
  };
  return logger as unknown as Logger;
}
