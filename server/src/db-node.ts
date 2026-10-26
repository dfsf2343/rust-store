import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate, type DB } from './db.js';

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db, db.pragma('user_version', { simple: true }) as number);
  return db;
}
