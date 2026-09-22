import { createHash } from "node:crypto";
import { database as db } from "./database.ts";

type Row = { id: string; course_id: string; course_code: string; title: string; body: string; answer: string; kind: string; source_url: string | null; created_at: string | null; remote_updated_at: string | null; synced_at: string; content_hash: string };

export function piazzaLocalDate(value: string | null, timezone: string) {
  if (!value) return "";
  const numeric = Number(value);
  const parsed = /^\d{10,13}$/.test(value) ? new Date(numeric * (value.length === 10 ? 1000 : 1)) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString("en-CA", { timeZone: timezone });
}

export function piazzaDate(now = new Date(), timezone = "America/Toronto") {
  return now.toLocaleDateString("en-CA", { timeZone: timezone });
}

export async function piazzaTimezone() {
  const row = await db.prepare("SELECT timezone FROM settings WHERE owner_id='local-owner'").first<{ timezone: string }>();
  try { new Intl.DateTimeFormat("en-CA", { timeZone: row?.timezone || "America/Toronto" }); return row?.timezone || "America/Toronto"; }
  catch { return "America/Toronto"; }
}

function view(row: Row) {
  return { id: row.id, courseId: row.course_id, courseCode: row.course_code, title: row.title,
    body: row.body, answer: row.answer, kind: row.kind, url: row.source_url,
    createdAt: row.created_at, updatedAt: row.remote_updated_at || row.created_at || row.synced_at };
}

export async function getPiazzaDailySummary(date: string, timezone = "America/Toronto") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new Error("日期无效");
  const rows = (await db.prepare(`SELECT p.*, c.code course_code FROM piazza_posts p JOIN courses c ON c.id=p.course_id
    WHERE p.is_active=1 ORDER BY COALESCE(p.remote_updated_at,p.created_at,p.synced_at) DESC,p.id DESC`).all<Row>()).results;
  const recentDates = [...new Set(rows.map(row => piazzaLocalDate(row.remote_updated_at || row.created_at || row.synced_at, timezone)).filter(Boolean))].sort().reverse().slice(0, 20);
  const dailyRows = rows.filter(row => piazzaLocalDate(row.remote_updated_at || row.created_at || row.synced_at, timezone) === date);
  const hash = createHash("sha256").update(JSON.stringify(["v2", timezone, recentDates, ...dailyRows.map(row => [row.id, row.content_hash])])).digest("hex");
  const cached = await db.prepare("SELECT summary_json,source_hash FROM piazza_daily_summaries WHERE date=? AND timezone=?").bind(date, timezone).first<{ summary_json: string; source_hash: string }>();
  if (cached?.source_hash === hash) return JSON.parse(cached.summary_json);
  const posts = dailyRows.map(view);
  const courses = [...new Set(posts.map(post => post.courseCode))].map(code => {
    const items = posts.filter(post => post.courseCode === code);
    return { code, total: items.length, answered: items.filter(post => Boolean(post.answer)).length,
      notes: items.filter(post => post.kind === "note").length,
      headlines: items.map(post => ({ id: post.id, title: post.title, excerpt: post.body.slice(0, 240), answer: post.answer ? post.answer.slice(0, 240) : "", kind: post.kind })) };
  });
  const summary = { date, timezone, total: posts.length, answered: posts.filter(post => Boolean(post.answer)).length,
    courses, posts, recentDates, generatedAt: new Date().toISOString() };
  await db.prepare(`INSERT INTO piazza_daily_summaries (date,timezone,summary_json,source_hash,generated_at) VALUES (?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET timezone=excluded.timezone,summary_json=excluded.summary_json,source_hash=excluded.source_hash,generated_at=excluded.generated_at`)
    .bind(date, timezone, JSON.stringify(summary), hash, summary.generatedAt).run();
  return summary;
}

export async function searchConfirmedPiazzaAnswers(query: string, courseId = "", offset = 0, limit = 30) {
  const safeQuery = query.trim().slice(0, 200);
  const safeOffset = Math.max(0, Math.min(100000, Math.floor(offset)));
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const conditions = ["p.is_active=1", "p.kind='question'", "p.answer<>''"];
  const args: string[] = [];
  if (courseId) { conditions.push("p.course_id=?"); args.push(courseId); }
  if (safeQuery) {
    conditions.push("(p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\' OR p.answer LIKE ? ESCAPE '\\')");
    const pattern = `%${safeQuery.replace(/[\\%_]/g, "\\$&")}%`;
    args.push(pattern, pattern, pattern);
  }
  const where = conditions.join(" AND ");
  const count = await db.prepare(`SELECT COUNT(*) count FROM piazza_posts p WHERE ${where}`).bind(...args).first<{ count: number }>();
  const rows = (await db.prepare(`SELECT p.*,c.code course_code FROM piazza_posts p JOIN courses c ON c.id=p.course_id
    WHERE ${where} ORDER BY COALESCE(p.remote_updated_at,p.created_at,p.synced_at) DESC,p.id DESC LIMIT ? OFFSET ?`)
    .bind(...args, safeLimit, safeOffset).all<Row>()).results;
  return { total: Number(count?.count || 0), items: rows.map(view), nextOffset: safeOffset + rows.length < Number(count?.count || 0) ? safeOffset + rows.length : null };
}
