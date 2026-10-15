// Node database adapter built on the built-in node:sqlite module (no native build step).
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './core/schema.js';

export function openDatabase(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  let depth = 0;
  const db = {
    kind: 'node',
    all: (sql, params = []) => stmt(sql).all(...params),
    get: (sql, params = []) => stmt(sql).get(...params),
    run: (sql, params = []) => {
      const r = stmt(sql).run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    exec: (sql) => raw.exec(sql),
    tx(fn) {
      if (depth > 0) return fn();
      depth++;
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      } finally {
        depth--;
      }
    },
    backupTo(path) {
      raw.prepare('VACUUM INTO ?').run(path);
    },
    close: () => raw.close(),
  };
  migrate(db);
  return db;
}

export { migrate };
