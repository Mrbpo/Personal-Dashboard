import { env } from "cloudflare:workers";
import type { CanvasSource, ExtractedAnalysis, LearningTask } from "./domain";
import { classifyCanvasStatus, urgencyForStatus } from "./task-rules";

type D1Row = Record<string, any>;

export function getDatabase(): D1Database {
  if (!env.DB) throw new Error("DATABASE_NOT_CONFIGURED");
  return env.DB;
}

export async function hashSource(source: CanvasSource): Promise<string> {
  const payload = JSON.stringify({
    title: source.title,
    body: source.body,
    dueAt: source.dueAt,
    unlockAt: source.unlockAt,
    lockAt: source.lockAt,
    submissionState: source.submissionState,
    file: source.file ? { name: source.file.name, size: source.file.size } : null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getStoredSource(id: string) {
  return getDatabase().prepare("SELECT content_hash, analysis_json FROM source_items WHERE id=?").bind(id).first<{ content_hash: string; analysis_json: string | null }>();
}

export async function touchSource(id: string) {
  await getDatabase().prepare("UPDATE source_items SET last_seen_at=? WHERE id=?").bind(new Date().toISOString(), id).run();
}

export async function upsertCourses(items: D1Row[]) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const statements = items.map((course) => db.prepare(
    `INSERT INTO courses (id, name, code, term_name, enabled, updated_at)
     VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code,
       term_name=excluded.term_name, updated_at=excluded.updated_at`
  ).bind(String(course.id), course.name || course.course_code || "未命名课程", course.course_code || course.name || String(course.id), course.term?.name ?? null, now));
  if (statements.length) await db.batch(statements);
}

export async function startSyncRun(runId: string, courseIds: string[]) {
  const states = Object.fromEntries(courseIds.map((id) => [id, "pending"]));
  await getDatabase().prepare(
    "INSERT INTO sync_runs (id, status, course_states_json, started_at) VALUES (?, 'running', ?, ?)"
  ).bind(runId, JSON.stringify(states), new Date().toISOString()).run();
}

export async function updateSyncCourse(runId: string, courseId: string, state: "running" | "complete" | "failed", error?: string) {
  const db = getDatabase();
  const row = await db.prepare("SELECT course_states_json FROM sync_runs WHERE id=?").bind(runId).first<D1Row>();
  const states = row ? JSON.parse(row.course_states_json || "{}") : {};
  states[courseId] = error ? { state, error } : state;
  const values = Object.values(states);
  const complete = values.every((value: any) => value === "complete" || value?.state === "failed");
  await db.prepare(
    "UPDATE sync_runs SET course_states_json=?, status=?, finished_at=? WHERE id=?"
  ).bind(JSON.stringify(states), complete ? "complete" : "running", complete ? new Date().toISOString() : null, runId).run();
}

export async function getSyncRun(runId: string) {
  const row = await getDatabase().prepare("SELECT * FROM sync_runs WHERE id=?").bind(runId).first<D1Row>();
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    courses: JSON.parse(row.course_states_json || "{}"),
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export async function saveSource(source: CanvasSource, analysis: ExtractedAnalysis | null, hash: string) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const previous = await db.prepare(
    "SELECT content_hash, title, dates_json FROM source_items WHERE id=?"
  ).bind(source.id).first<D1Row>();
  const dates = JSON.stringify({ dueAt: source.dueAt, unlockAt: source.unlockAt, lockAt: source.lockAt });
  const changed = Boolean(previous && previous.content_hash !== hash);
  if (changed) {
    const before = JSON.stringify({ title: previous!.title, dates: JSON.parse(previous!.dates_json || "{}"), hash: previous!.content_hash });
    const after = JSON.stringify({ title: source.title, dates: JSON.parse(dates), hash });
    const oldDates = JSON.parse(previous!.dates_json || "{}");
    const newDates = JSON.parse(dates);
    const dateChanged = oldDates.dueAt !== newDates.dueAt || oldDates.unlockAt !== newDates.unlockAt || oldDates.lockAt !== newDates.lockAt;
    await db.prepare(
      "INSERT INTO changes (course_id, source_item_id, change_type, title, before_json, after_json, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(source.courseId, source.id, dateChanged ? "dates_updated" : "content_updated", source.title, before, after, now).run();
  }
  await db.prepare(
    `INSERT INTO source_items
      (id, course_id, source_type, source_id, title, body, source_url, content_hash, remote_updated_at, dates_json, analysis_json, analysis_status, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, source_url=excluded.source_url,
       content_hash=excluded.content_hash, remote_updated_at=excluded.remote_updated_at, dates_json=excluded.dates_json,
       analysis_json=COALESCE(excluded.analysis_json, source_items.analysis_json),
       analysis_status=excluded.analysis_status, last_seen_at=excluded.last_seen_at`
  ).bind(
    source.id, source.courseId, source.sourceType, source.sourceId, source.title, source.body,
    source.sourceUrl, hash, source.updatedAt, dates, analysis ? JSON.stringify(analysis) : null,
    analysis ? "complete" : "rule_only", now, now
  ).run();

  const actions = analysis?.actions?.length
    ? analysis.actions
    : source.sourceType === "assignment"
      ? [{ title: source.title, action: "完成并提交 " + source.title, requirements: [], inferredDueAt: null, confidence: "certain" as const, evidence: source.body.slice(0, 220), estimatedMinutes: null, possiblyCancelled: false }]
      : [];

  await db.prepare("DELETE FROM tasks WHERE source_item_id=?").bind(source.id).run();
  const taskStatements = actions.map((action, index) => {
    let status = classifyCanvasStatus(source);
    if (action.possiblyCancelled) status = "possibly_superseded";
    const taskId = source.id + ":" + index;
    return db.prepare(
      `INSERT INTO tasks
       (id, course_id, source_item_id, source_type, source_id, source_url, title, action, requirements_json,
        due_at, unlock_at, lock_at, canvas_status, urgency, confidence, evidence, estimated_minutes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      taskId, source.courseId, source.id, source.sourceType, source.sourceId, source.sourceUrl,
      action.title || source.title, action.action, JSON.stringify(action.requirements || []),
      source.dueAt || action.inferredDueAt, source.unlockAt, source.lockAt, status, urgencyForStatus(status),
      action.confidence, action.evidence || "", action.estimatedMinutes, now
    );
  });
  if (taskStatements.length) await db.batch(taskStatements);
  return { changed };
}

export async function saveAssignment(courseId: string, assignment: D1Row) {
  await getDatabase().prepare(
    `INSERT INTO assignments
     (id, course_id, name, description, html_url, due_at, unlock_at, lock_at, points_possible, submission_state, submitted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, html_url=excluded.html_url,
       due_at=excluded.due_at, unlock_at=excluded.unlock_at, lock_at=excluded.lock_at,
       points_possible=excluded.points_possible, submission_state=excluded.submission_state,
       submitted_at=excluded.submitted_at, updated_at=excluded.updated_at`
  ).bind(
    String(assignment.id), courseId, assignment.name || "未命名作业", assignment.description || "",
    assignment.html_url ?? null, assignment.due_at ?? null, assignment.unlock_at ?? null, assignment.lock_at ?? null,
    assignment.points_possible ?? null, assignment.submission?.workflow_state ?? null,
    assignment.submission?.submitted_at ?? null, assignment.updated_at || new Date().toISOString()
  ).run();
}

export async function markCourseSynced(courseId: string) {
  await getDatabase().prepare("UPDATE courses SET synced_at=? WHERE id=?").bind(new Date().toISOString(), courseId).run();
}

export async function saveCourseSummary(courseId: string, summary: string, priorities: string[], risks: string[], aiAvailable: boolean) {
  await getDatabase().prepare(
    `INSERT INTO course_summaries (course_id, summary, priorities_json, risks_json, ai_available, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(course_id) DO UPDATE SET summary=excluded.summary, priorities_json=excluded.priorities_json,
       risks_json=excluded.risks_json, ai_available=excluded.ai_available, updated_at=excluded.updated_at`
  ).bind(courseId, summary, JSON.stringify(priorities), JSON.stringify(risks), aiAvailable ? 1 : 0, new Date().toISOString()).run();
}

export async function listTasks(): Promise<LearningTask[]> {
  const result = await getDatabase().prepare(
    `SELECT t.*, c.code course_code, c.name course_name, COALESCE(o.local_status, 'active') local_status
     FROM tasks t JOIN courses c ON c.id=t.course_id
     LEFT JOIN task_overrides o ON o.task_id=t.id
     WHERE c.enabled=1 AND COALESCE(o.local_status, 'active') != 'ignored'
     ORDER BY CASE t.urgency WHEN 'urgent' THEN 1 WHEN 'soon' THEN 2 WHEN 'upcoming' THEN 3 ELSE 4 END,
       t.due_at IS NULL, t.due_at`
  ).all<D1Row>();
  return result.results.map(rowToTask);
}

function rowToTask(row: D1Row): LearningTask {
  const liveStatus = ["completed", "possibly_superseded"].includes(row.canvas_status)
    ? row.canvas_status
    : classifyCanvasStatus({
        id: row.source_item_id, courseId: row.course_id, sourceType: row.source_type,
        sourceId: row.source_id, title: row.title, body: "", sourceUrl: row.source_url,
        updatedAt: row.updated_at, dueAt: row.due_at, unlockAt: row.unlock_at, lockAt: row.lock_at,
      });
  return {
    id: row.id, courseId: row.course_id, courseCode: row.course_code, courseName: row.course_name,
    sourceType: row.source_type, sourceId: row.source_id, sourceUrl: row.source_url,
    title: row.title, action: row.action, requirements: JSON.parse(row.requirements_json || "[]"),
    dueAt: row.due_at, unlockAt: row.unlock_at, lockAt: row.lock_at,
    canvasStatus: liveStatus, localStatus: row.local_status,
    urgency: urgencyForStatus(liveStatus), confidence: row.confidence, evidence: row.evidence,
    estimatedMinutes: row.estimated_minutes, updatedAt: row.updated_at,
  };
}

export async function dashboardData(date: string) {
  const db = getDatabase();
  const [tasks, courseRows, changeRows, syncRow] = await Promise.all([
    listTasks(),
    db.prepare("SELECT * FROM courses WHERE enabled=1 ORDER BY code").all<D1Row>(),
    db.prepare(`SELECT ch.*, c.code course_code FROM changes ch JOIN courses c ON c.id=ch.course_id ORDER BY detected_at DESC LIMIT 8`).all<D1Row>(),
    db.prepare("SELECT * FROM sync_runs ORDER BY started_at DESC LIMIT 1").first<D1Row>(),
  ]);
  const plan = await db.prepare("SELECT * FROM daily_plans WHERE date=?").bind(date).first<D1Row>();
  return {
    date,
    tasks,
    courses: courseRows.results.map((row) => ({ id: row.id, code: row.code, name: row.name, syncedAt: row.synced_at })),
    changes: changeRows.results.map((row) => ({ id: row.id, courseId: row.course_id, courseCode: row.course_code, title: row.title, type: row.change_type, detectedAt: row.detected_at })),
    lastSync: syncRow ? { id: syncRow.id, status: syncRow.status, startedAt: syncRow.started_at, finishedAt: syncRow.finished_at } : null,
    plan: plan ? JSON.parse(plan.plan_json) : null,
    aiAvailable: plan ? Boolean(plan.ai_available) : null,
  };
}

export async function saveDailyPlan(date: string, tasks: LearningTask[], aiAvailable: boolean) {
  const sourceVersion = tasks.map((task) => task.id + ":" + task.updatedAt + ":" + task.localStatus).join("|");
  const now = new Date().toISOString();
  const plan = {
    mustDo: tasks.filter((task) => task.localStatus === "active" && ["urgent", "soon"].includes(task.urgency)).slice(0, 6),
    shouldDo: tasks.filter((task) => task.localStatus === "active" && task.urgency === "upcoming").slice(0, 6),
    review: tasks.filter((task) => task.localStatus === "active" && task.urgency === "review").slice(0, 6),
    generatedAt: now,
  };
  await getDatabase().prepare(
    `INSERT INTO daily_plans (date, plan_json, source_version, ai_available, generated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET plan_json=excluded.plan_json, source_version=excluded.source_version,
       ai_available=excluded.ai_available, generated_at=excluded.generated_at`
  ).bind(date, JSON.stringify(plan), sourceVersion, aiAvailable ? 1 : 0, now).run();
  return plan;
}

export async function ensureDailyPlan(date: string, aiAvailable: boolean) {
  const tasks = await listTasks();
  const sourceVersion = tasks.map((task) => task.id + ":" + task.updatedAt + ":" + task.localStatus).join("|");
  const cached = await getDatabase().prepare("SELECT source_version, plan_json FROM daily_plans WHERE date=?").bind(date).first<D1Row>();
  if (cached?.source_version === sourceVersion) return JSON.parse(cached.plan_json);
  return saveDailyPlan(date, tasks, aiAvailable);
}

export async function setTaskStatus(taskId: string, status: "active" | "completed" | "ignored") {
  await getDatabase().prepare(
    `INSERT INTO task_overrides (task_id, local_status, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET local_status=excluded.local_status, updated_at=excluded.updated_at`
  ).bind(taskId, status, new Date().toISOString()).run();
}

export async function getCourseDetail(courseId: string) {
  const db = getDatabase();
  const course = await db.prepare("SELECT * FROM courses WHERE id=? OR code=?").bind(courseId, courseId).first<D1Row>();
  if (!course) return null;
  const [taskRows, sourceRows, summary] = await Promise.all([
    db.prepare(`SELECT t.*, c.code course_code, c.name course_name, COALESCE(o.local_status, 'active') local_status
      FROM tasks t JOIN courses c ON c.id=t.course_id LEFT JOIN task_overrides o ON o.task_id=t.id WHERE t.course_id=? ORDER BY t.due_at IS NULL, t.due_at`).bind(course.id).all<D1Row>(),
    db.prepare("SELECT id, source_type, title, source_url, remote_updated_at, analysis_status FROM source_items WHERE course_id=? ORDER BY last_seen_at DESC LIMIT 100").bind(course.id).all<D1Row>(),
    db.prepare("SELECT * FROM course_summaries WHERE course_id=?").bind(course.id).first<D1Row>(),
  ]);
  return {
    course: { id: course.id, code: course.code, name: course.name, termName: course.term_name, syncedAt: course.synced_at },
    tasks: taskRows.results.map(rowToTask),
    sources: sourceRows.results.map((row) => ({ id: row.id, type: row.source_type, title: row.title, url: row.source_url, updatedAt: row.remote_updated_at, analysisStatus: row.analysis_status })),
    summary: summary ? { text: summary.summary, priorities: JSON.parse(summary.priorities_json), risks: JSON.parse(summary.risks_json), aiAvailable: Boolean(summary.ai_available), updatedAt: summary.updated_at } : null,
  };
}

export async function listChanges() {
  const result = await getDatabase().prepare(
    `SELECT ch.*, c.code course_code, c.name course_name FROM changes ch JOIN courses c ON c.id=ch.course_id ORDER BY detected_at DESC LIMIT 100`
  ).all<D1Row>();
  return result.results.map((row) => ({
    id: row.id, courseId: row.course_id, courseCode: row.course_code, courseName: row.course_name,
    title: row.title, type: row.change_type, before: row.before_json ? JSON.parse(row.before_json) : null,
    after: row.after_json ? JSON.parse(row.after_json) : null, detectedAt: row.detected_at,
  }));
}

export async function getSettings(ownerId: string) {
  const row = await getDatabase().prepare("SELECT * FROM settings WHERE owner_id=?").bind(ownerId).first<D1Row>();
  return row ? { timezone: row.timezone, dailyMinutes: row.daily_minutes } : { timezone: "America/Toronto", dailyMinutes: 150 };
}

export async function saveSettings(ownerId: string, timezone: string, dailyMinutes: number) {
  await getDatabase().prepare(
    `INSERT INTO settings (owner_id, timezone, daily_minutes, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET timezone=excluded.timezone, daily_minutes=excluded.daily_minutes, updated_at=excluded.updated_at`
  ).bind(ownerId, timezone, dailyMinutes, new Date().toISOString()).run();
}

export async function listCourseSettings() {
  const result = await getDatabase().prepare("SELECT id, code, name, enabled FROM courses ORDER BY code").all<D1Row>();
  return result.results.map((row) => ({ id: row.id, code: row.code, name: row.name, enabled: Boolean(row.enabled) }));
}

export async function setCourseEnabled(courseId: string, enabled: boolean) {
  await getDatabase().prepare("UPDATE courses SET enabled=?, updated_at=? WHERE id=?")
    .bind(enabled ? 1 : 0, new Date().toISOString(), courseId).run();
}
