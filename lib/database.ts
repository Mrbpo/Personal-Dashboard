import { createClient, type Client, type InValue } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

type RowObject = Record<string, unknown>;

const schema = [
  `CREATE TABLE IF NOT EXISTS tutor_memory (thread_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, through_count INTEGER NOT NULL, summary TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tutor_memory_vectors (message_id TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(message_id,model))`,
  `CREATE TABLE IF NOT EXISTS library_parse_pages (document_id TEXT NOT NULL, parser TEXT NOT NULL, page INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(document_id,parser,page))`,
  `CREATE TABLE IF NOT EXISTS mail_thread_summaries (account TEXT NOT NULL, thread_id TEXT NOT NULL, fingerprint TEXT NOT NULL, summary_json TEXT NOT NULL, PRIMARY KEY(account,thread_id))`,
  `CREATE TABLE IF NOT EXISTS service_leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS library_remote_versions (owner_id TEXT NOT NULL, origin_key TEXT NOT NULL, fingerprint TEXT NOT NULL, document_id TEXT NOT NULL, PRIMARY KEY(owner_id,origin_key))`,
  `CREATE TABLE IF NOT EXISTS library_source_failures (owner_id TEXT NOT NULL, origin TEXT NOT NULL, origin_key TEXT NOT NULL, course_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, error TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(owner_id,origin,origin_key))`,
  `CREATE TABLE IF NOT EXISTS library_documents (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, course_id TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL, origin_key TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', error TEXT, created_at TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(owner_id, origin, origin_key, hash))`,
  `CREATE TABLE IF NOT EXISTS library_chunks (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, position INTEGER NOT NULL, locator TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_library_chunks_doc ON library_chunks(document_id)`,
  `CREATE TABLE IF NOT EXISTS library_vectors (chunk_id TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(chunk_id, model))`,
  `CREATE TABLE IF NOT EXISTS background_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, error TEXT, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS worker_state (id TEXT PRIMARY KEY, heartbeat INTEGER NOT NULL, paused INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS ai_ledger (id TEXT PRIMARY KEY, month TEXT NOT NULL, kind TEXT NOT NULL, reserved REAL NOT NULL, charged REAL, status TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mail_messages (id TEXT PRIMARY KEY, account TEXT NOT NULL, thread_id TEXT NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL, body TEXT NOT NULL, received_at TEXT NOT NULL, category TEXT NOT NULL, attachments_json TEXT NOT NULL, analysis_json TEXT, hash TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS mail_sync (account TEXT PRIMARY KEY, history_id TEXT, page_token TEXT, since_epoch INTEGER NOT NULL, pending_history TEXT)`,
  `CREATE TABLE IF NOT EXISTS tutor_threads (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, course_id TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tutor_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, attachments_json TEXT NOT NULL DEFAULT '[]', meta_json TEXT NOT NULL DEFAULT '{}', starred INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tutor_messages_thread ON tutor_messages(thread_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS tutor_vocabulary_state (owner_id TEXT NOT NULL, course_id TEXT NOT NULL, term TEXT NOT NULL, mastered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id, course_id, term))`,
  `CREATE TABLE IF NOT EXISTS courses (id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL, term_name TEXT, enabled INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, synced_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS source_items (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', source_url TEXT, content_hash TEXT NOT NULL, remote_updated_at TEXT, dates_json TEXT NOT NULL DEFAULT '{}', analysis_json TEXT, analysis_status TEXT NOT NULL DEFAULT 'pending', extraction_version INTEGER NOT NULL DEFAULT 1, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, missing_at TEXT)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_source_course_type_remote ON source_items(course_id, source_type, source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_source_course_active ON source_items(course_id, is_active)`,
  `CREATE INDEX IF NOT EXISTS idx_source_hash ON source_items(content_hash)`,
  `CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', html_url TEXT, due_at TEXT, unlock_at TEXT, lock_at TEXT, points_possible REAL, submission_state TEXT, submitted_at TEXT, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_assignments_course_due ON assignments(course_id, due_at)`,
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, source_item_id TEXT NOT NULL, source_type TEXT NOT NULL, source_id TEXT NOT NULL, source_url TEXT, title TEXT NOT NULL, action TEXT NOT NULL, requirements_json TEXT NOT NULL DEFAULT '[]', start_at TEXT, due_at TEXT, unlock_at TEXT, lock_at TEXT, canvas_status TEXT NOT NULL, urgency TEXT NOT NULL, confidence TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', estimated_minutes INTEGER, points_possible REAL, prerequisite_blocked INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_course_due ON tasks(course_id, due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(canvas_status, due_at)`,
  `CREATE TABLE IF NOT EXISTS task_overrides (task_id TEXT PRIMARY KEY, local_status TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS course_summaries (course_id TEXT PRIMARY KEY, summary TEXT NOT NULL, priorities_json TEXT NOT NULL DEFAULT '[]', risks_json TEXT NOT NULL DEFAULT '[]', ai_available INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS daily_plans (date TEXT PRIMARY KEY, plan_json TEXT NOT NULL, source_version TEXT NOT NULL, ai_available INTEGER NOT NULL DEFAULT 0, generated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS schedule_events (id TEXT PRIMARY KEY, external_uid TEXT NOT NULL, source_name TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', start_at TEXT NOT NULL, end_at TEXT NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_source_uid ON schedule_events(source_name, external_uid)`,
  `CREATE INDEX IF NOT EXISTS idx_schedule_range ON schedule_events(start_at, end_at)`,
  `CREATE TABLE IF NOT EXISTS integration_connections (provider TEXT PRIMARY KEY, secret_encrypted TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, last_synced_at TEXT, updated_at TEXT NOT NULL, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS piazza_posts (id TEXT PRIMARY KEY, course_id TEXT NOT NULL, network_id TEXT NOT NULL, post_number TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', source_url TEXT, folders_json TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL, remote_updated_at TEXT, synced_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_piazza_network_post ON piazza_posts(network_id, post_number)`,
  `CREATE INDEX IF NOT EXISTS idx_piazza_course_updated ON piazza_posts(course_id, remote_updated_at)`,
  `CREATE TABLE IF NOT EXISTS piazza_post_versions (post_id TEXT NOT NULL, content_hash TEXT NOT NULL, course_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source_url TEXT, remote_updated_at TEXT, archived_at TEXT NOT NULL, PRIMARY KEY(post_id, content_hash))`,
  `INSERT OR IGNORE INTO piazza_post_versions SELECT id, content_hash, course_id, title, body, source_url, remote_updated_at, synced_at FROM piazza_posts`,
  `CREATE TABLE IF NOT EXISTS shortcuts (id TEXT PRIMARY KEY, title TEXT NOT NULL, url TEXT NOT NULL, icon_url TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_shortcuts_url ON shortcuts(url)`,
  `CREATE TABLE IF NOT EXISTS changes (id INTEGER PRIMARY KEY AUTOINCREMENT, course_id TEXT NOT NULL, source_item_id TEXT NOT NULL, change_type TEXT NOT NULL, title TEXT NOT NULL, before_json TEXT, after_json TEXT, detected_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_changes_detected ON changes(detected_at)`,
  `CREATE INDEX IF NOT EXISTS idx_changes_course ON changes(course_id)`,
  `CREATE TABLE IF NOT EXISTS sync_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, course_states_json TEXT NOT NULL DEFAULT '{}', error TEXT, started_at TEXT NOT NULL, finished_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS settings (owner_id TEXT PRIMARY KEY, timezone TEXT NOT NULL DEFAULT 'America/Toronto', daily_minutes INTEGER NOT NULL DEFAULT 150, updated_at TEXT NOT NULL)`,
  `PRAGMA optimize`,
];

let client: Client | null = null;
let initialized: Promise<void> | null = null;

function getClient() {
  if (client) return client;
  const url = process.env.DATABASE_URL || "file:./data/course-radar-v2.db";
  if (url.startsWith("file:")) mkdirSync(dirname(resolve(url.slice(5))), { recursive: true });
  client = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN || undefined });
  return client;
}

async function ready() {
  if (!initialized) initialized = (async () => {
    // The web and worker are separate processes sharing one SQLite file.
    // Wait briefly for startup migrations/writes instead of surfacing a transient lock as an API error.
    await getClient().execute("PRAGMA busy_timeout=10000");
    await getClient().batch(schema.map((sql) => ({ sql })), "write");
    const columns = await getClient().execute("PRAGMA table_info(source_items)");
    if (!columns.rows.some((row) => row.name === "extraction_version")) {
      await getClient().execute("ALTER TABLE source_items ADD COLUMN extraction_version INTEGER NOT NULL DEFAULT 1");
    }
    const taskColumns = await getClient().execute("PRAGMA table_info(tasks)");
    const settingsColumns = await getClient().execute("PRAGMA table_info(settings)");
    if (!settingsColumns.rows.some((row) => row.name === "display_name")) {
      await getClient().execute("ALTER TABLE settings ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
    }
    if (!taskColumns.rows.some((row) => row.name === "start_at")) {
      await getClient().execute("ALTER TABLE tasks ADD COLUMN start_at TEXT");
    }
  })();
  await initialized;
}

class Statement {
  args: InValue[] = [];
  sql: string;
  constructor(sql: string) { this.sql = sql; }
  bind(...args: InValue[]) { this.args = args; return this; }
  async run() { await ready(); return getClient().execute({ sql: this.sql, args: this.args }); }
  async first<T extends RowObject>() { await ready(); const result = await getClient().execute({ sql: this.sql, args: this.args }); return (result.rows[0] as unknown as T | undefined) ?? null; }
  async all<T extends RowObject>() { await ready(); const result = await getClient().execute({ sql: this.sql, args: this.args }); return { results: result.rows as unknown as T[] }; }
}

export const database = {
  prepare(sql: string) { return new Statement(sql); },
  async batch(statements: Statement[]) { await ready(); return getClient().batch(statements.map((statement) => ({ sql: statement.sql, args: statement.args })), "write"); },
};
