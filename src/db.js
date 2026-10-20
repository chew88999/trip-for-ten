import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from './auth.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.DB_PATH ?? join(root, 'data', 'trip.db');
export const DEFAULT_PASSWORD = process.env.DEFAULT_PASSWORD ?? '1234';

export function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(readFileSync(join(root, 'db', 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}

// Bring databases created before login existed up to date.
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(members)').all().map(c => c.name);
  if (!cols.includes('password_hash')) db.exec('ALTER TABLE members ADD COLUMN password_hash TEXT');
  const setHash = db.prepare('UPDATE members SET password_hash = ? WHERE id = ?');
  for (const { id } of db.prepare('SELECT id FROM members WHERE password_hash IS NULL').all()) {
    setHash.run(hashPassword(DEFAULT_PASSWORD), id);
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
