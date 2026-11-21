// Mémoire persistante d'OMNIA : SQLite embarqué (module natif de Node, aucune dépendance).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'entreprise', sector TEXT NOT NULL DEFAULT 'general',
  goals TEXT NOT NULL DEFAULT '[]', modules TEXT NOT NULL DEFAULT '[]',
  autonomy TEXT NOT NULL DEFAULT 'assiste', currency TEXT NOT NULL DEFAULT 'EUR',
  profile_source TEXT NOT NULL DEFAULT 'local', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'actif',
  deadline TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, project_id INTEGER,
  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'a_faire',
  priority INTEGER NOT NULL DEFAULT 2, due_date TEXT, origin TEXT NOT NULL DEFAULT 'utilisateur',
  created_at TEXT NOT NULL, done_at TEXT
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, date TEXT NOT NULL,
  amount REAL NOT NULL, category TEXT NOT NULL DEFAULT 'divers', label TEXT NOT NULL DEFAULT '',
  counterparty TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note', content TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'utilisateur', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, rule TEXT NOT NULL,
  fingerprint TEXT NOT NULL, kind TEXT NOT NULL, severity INTEGER NOT NULL,
  title TEXT NOT NULL, detail TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'ouvert', created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
  resolved_at TEXT, UNIQUE(workspace_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS recommendations (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, insight_id INTEGER NOT NULL,
  title TEXT NOT NULL, rationale TEXT NOT NULL, options TEXT NOT NULL,
  best_option INTEGER NOT NULL DEFAULT 0, chosen_option INTEGER, priority REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposee', outcome TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, recommendation_id INTEGER,
  automation_id INTEGER, type TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
  sensitivity TEXT NOT NULL, status TEXT NOT NULL, requested_by TEXT NOT NULL,
  result TEXT, error TEXT, created_at TEXT NOT NULL, decided_at TEXT, executed_at TEXT
);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL, name TEXT NOT NULL,
  every_minutes INTEGER NOT NULL, action_type TEXT NOT NULL, params TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, preauthorized INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT, last_status TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_weights (
  workspace_id INTEGER NOT NULL, rule TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0, resolved INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, rule)
);
CREATE TABLE IF NOT EXISTS metrics (
  workspace_id INTEGER NOT NULL, day TEXT NOT NULL, key TEXT NOT NULL, value REAL NOT NULL,
  PRIMARY KEY (workspace_id, day, key)
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, workspace_id INTEGER, ts TEXT NOT NULL, actor TEXT NOT NULL,
  event TEXT NOT NULL, entity TEXT NOT NULL DEFAULT '', entity_id INTEGER,
  detail TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id INTEGER NOT NULL, user_id INTEGER NOT NULL, role TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_ws ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tx_ws ON transactions(workspace_id, date);
CREATE INDEX IF NOT EXISTS idx_actions_ws ON actions(workspace_id, status);
`;

export function openDb(dbPath) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  raw.exec(SCHEMA);
  return {
    raw,
    all: (sql, ...p) => raw.prepare(sql).all(...p).map((r) => ({ ...r })),
    get: (sql, ...p) => { const r = raw.prepare(sql).get(...p); return r ? { ...r } : undefined; },
    run: (sql, ...p) => raw.prepare(sql).run(...p),
    insert: (sql, ...p) => Number(raw.prepare(sql).run(...p).lastInsertRowid),
    tx(fn) {
      raw.exec('BEGIN');
      try { const out = fn(); raw.exec('COMMIT'); return out; } catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
    close: () => raw.close(),
  };
}

export const now = () => new Date().toISOString();
export const today = (d = new Date()) => d.toISOString().slice(0, 10);
export const daysAgo = (n, from = new Date()) => today(new Date(from.getTime() - n * 86400000));
export const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
