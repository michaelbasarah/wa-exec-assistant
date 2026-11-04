/**
 * Per-user memory in one SQLite file (node:sqlite, built in). Every row is keyed by the sender's
 * WhatsApp id and every query is scoped by it. DB_PATH defaults to data/assistant.db; tests and the
 * demo use ":memory:".
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, wa_id TEXT NOT NULL, body TEXT NOT NULL,
    due TEXT, done INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, done_at TEXT);
  CREATE INDEX IF NOT EXISTS idx_notes ON notes(wa_id, id);
  CREATE INDEX IF NOT EXISTS idx_tasks ON tasks(wa_id, done, id);
  -- Reminder settings, one row per user. last_seen_at drives WhatsApp's 24h free-form window.
  CREATE TABLE IF NOT EXISTS reminder_prefs (
    wa_id TEXT PRIMARY KEY, last_seen_at TEXT,
    tasks_every_min INTEGER NOT NULL DEFAULT 0, tasks_last_sent TEXT,
    agenda_times TEXT NOT NULL DEFAULT '', agenda_last_key TEXT,
    event_lead_min INTEGER NOT NULL DEFAULT 0, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS event_nudges (wa_id TEXT NOT NULL, event_id TEXT NOT NULL, sent_at TEXT NOT NULL, PRIMARY KEY (wa_id, event_id));
  CREATE TABLE IF NOT EXISTS modes (wa_id TEXT PRIMARY KEY, name TEXT NOT NULL, updated_at TEXT NOT NULL);
  -- /@sales state between messages: { turns: [...], confirm?: {...} }
  CREATE TABLE IF NOT EXISTS sales_state (wa_id TEXT PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

let db;
function q(sql) {
  if (!db) {
    const path = process.env.DB_PATH || "data/assistant.db";
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    db = new DatabaseSync(path);
    db.exec(SCHEMA);
  }
  return db.prepare(sql);
}
const now = () => new Date().toISOString();
const trim = (s) => String(s ?? "").trim();
export const isPlainDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));

// --- Notes -------------------------------------------------------------------------------------
export function addNote(waId, body) {
  const b = trim(body);
  if (!b) return null;
  return { id: Number(q("INSERT INTO notes (wa_id, body, created_at) VALUES (?,?,?)").run(waId, b, now()).lastInsertRowid), body: b };
}
export const listNotes = (waId) => q("SELECT id, body FROM notes WHERE wa_id=? ORDER BY id").all(waId);
export const deleteNote = (waId, id) => q("DELETE FROM notes WHERE id=? AND wa_id=?").run(id, waId).changes > 0;
export function updateNote(waId, id, body) {
  const b = trim(body);
  if (!b) return null;
  return q("UPDATE notes SET body=? WHERE id=? AND wa_id=?").run(b, id, waId).changes ? { id: Number(id), body: b } : null;
}

// --- Tasks -------------------------------------------------------------------------------------
export function addTask(waId, body, due = "") {
  const b = trim(body);
  if (!b) return null;
  const d = isPlainDate(due) ? String(due) : null;
  return { id: Number(q("INSERT INTO tasks (wa_id, body, due, created_at) VALUES (?,?,?,?)").run(waId, b, d, now()).lastInsertRowid), body: b, due: d };
}
export const listTasks = (waId) => q("SELECT id, body, due FROM tasks WHERE wa_id=? AND done=0 ORDER BY id").all(waId);
export const completeTask = (waId, id) =>
  q("UPDATE tasks SET done=1, done_at=? WHERE id=? AND wa_id=? AND done=0").run(now(), id, waId).changes > 0;

/** Change body and/or due in place. A bad due is ignored (never clears); clearing needs clearDue. */
export function updateTask(waId, id, { body, due, clearDue } = {}) {
  const sets = [], vals = [];
  if (trim(body)) { sets.push("body=?"); vals.push(trim(body)); }
  if (clearDue) sets.push("due=NULL");
  else if (due != null && isPlainDate(due)) { sets.push("due=?"); vals.push(String(due)); }
  if (sets.length && !q(`UPDATE tasks SET ${sets.join(", ")} WHERE id=? AND wa_id=?`).run(...vals, id, waId).changes) return null;
  const row = q("SELECT id, body, due FROM tasks WHERE id=? AND wa_id=?").get(id, waId);
  return row ? { id: Number(row.id), body: row.body, due: row.due ?? null } : null;
}

// --- Reminder prefs ----------------------------------------------------------------------------
export function touchUser(waId, at = now()) {
  q(`INSERT INTO reminder_prefs (wa_id, last_seen_at, updated_at) VALUES (?,?,?)
     ON CONFLICT(wa_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(waId, at, at);
}
export const getPrefs = (waId) => q("SELECT * FROM reminder_prefs WHERE wa_id=?").get(waId) ?? null;
export function setPrefs(waId, patch) {
  const cols = ["tasks_every_min", "agenda_times", "event_lead_min"].filter((k) => k in patch);
  const all = ["wa_id", "updated_at", ...cols];
  q(`INSERT INTO reminder_prefs (${all}) VALUES (${all.map(() => "?")})
     ON CONFLICT(wa_id) DO UPDATE SET ${[...cols, "updated_at"].map((k) => `${k}=excluded.${k}`)}`)
    .run(waId, now(), ...cols.map((k) => patch[k]));
  return getPrefs(waId);
}
export const listReminderUsers = () =>
  q("SELECT * FROM reminder_prefs WHERE tasks_every_min>0 OR agenda_times<>'' OR event_lead_min>0").all();
export const markTasksSent = (waId, iso) => q("UPDATE reminder_prefs SET tasks_last_sent=? WHERE wa_id=?").run(iso, waId);
export const markAgendaSent = (waId, key) => q("UPDATE reminder_prefs SET agenda_last_key=? WHERE wa_id=?").run(key, waId);
export const wasNudged = (waId, eventId) => !!q("SELECT 1 FROM event_nudges WHERE wa_id=? AND event_id=?").get(waId, eventId);
export const recordNudge = (waId, eventId, iso) =>
  q("INSERT OR IGNORE INTO event_nudges (wa_id, event_id, sent_at) VALUES (?,?,?)").run(waId, eventId, iso);

// --- Console mode + sales state (survive restarts) ---------------------------------------------
export const saveMode = (waId, name) =>
  q("INSERT INTO modes (wa_id, name, updated_at) VALUES (?,?,?) ON CONFLICT(wa_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at")
    .run(waId, name, now());
export const loadMode = (waId) => q("SELECT name FROM modes WHERE wa_id=?").get(waId)?.name ?? null;
export const clearMode = (waId) => q("DELETE FROM modes WHERE wa_id=?").run(waId);

export function getSalesState(waId) {
  const r = q("SELECT state FROM sales_state WHERE wa_id=?").get(waId);
  return r ? JSON.parse(r.state) : { turns: [] };
}
export const setSalesState = (waId, state) =>
  q("INSERT INTO sales_state (wa_id, state, updated_at) VALUES (?,?,?) ON CONFLICT(wa_id) DO UPDATE SET state=excluded.state, updated_at=excluded.updated_at")
    .run(waId, JSON.stringify(state), now());
export const clearSalesState = (waId) => q("DELETE FROM sales_state WHERE wa_id=?").run(waId);

/** Offboarding: erase everything stored for one user. */
export function forgetUser(waId) {
  for (const t of ["notes", "tasks", "reminder_prefs", "event_nudges", "modes", "sales_state"]) q(`DELETE FROM ${t} WHERE wa_id=?`).run(waId);
}
