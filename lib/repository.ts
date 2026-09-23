import type { CanvasSource, ExtractedAnalysis, LearningTask } from "./domain.ts";
import { classifyCanvasStatus, priorityScore, statusLabels, urgencyForStatus, urgencyForTask } from "./task-rules.ts";
import { database, searchIndexAvailable } from "./database.ts";
import { activitySearchAliases, ftsMatchTerms } from "./search-vocabulary.ts";

type D1Row = Record<string, any>;
const EXTRACTION_VERSION = 5;

export function getDatabase() { return database; }

export async function hashSource(source: CanvasSource): Promise<string> {
  const payload = JSON.stringify({
    title: source.title,
    body: source.body,
    dueAt: source.dueAt,
    unlockAt: source.unlockAt,
    lockAt: source.lockAt,
    submissionState: source.submissionState,
    pointsPossible: source.pointsPossible,
    prerequisiteBlocked: source.prerequisiteBlocked,
    file: source.file ? { name: source.file.name, size: source.file.size } : null,
    folderPath: source.folderPath ?? null,
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getStoredSource(id: string) {
  return getDatabase().prepare("SELECT content_hash, analysis_json, analysis_status, extraction_version, is_active FROM source_items WHERE id=?").bind(id).first<{ content_hash: string; analysis_json: string | null; analysis_status: string; extraction_version: number; is_active: number }>();
}

export async function touchSource(id: string) {
  await getDatabase().prepare("UPDATE source_items SET last_seen_at=?, is_active=1, missing_at=NULL WHERE id=?").bind(new Date().toISOString(), id).run();
}

export async function upsertCourses(items: D1Row[]) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const statements = items.map((course) => db.prepare(
    `INSERT INTO courses (id, name, code, term_name, start_at, end_at, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, code=excluded.code,
       term_name=excluded.term_name, start_at=excluded.start_at, end_at=excluded.end_at, updated_at=excluded.updated_at`
  ).bind(String(course.id), course.name || course.course_code || "未命名课程", course.course_code || course.name || String(course.id), course.term?.name ?? null, course.start_at ?? course.term?.start_at ?? null, course.end_at ?? course.term?.end_at ?? null, now));
  if (statements.length) await db.batch(statements);
}

export async function startSyncRun(runId: string, courseIds: string[]) {
  const states = Object.fromEntries(courseIds.map((id) => [id, "pending"]));
  await getDatabase().prepare(
    "INSERT INTO sync_runs (id, status, course_states_json, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(runId, courseIds.length ? "running" : "complete", JSON.stringify(states), new Date().toISOString(), courseIds.length ? null : new Date().toISOString()).run();
}

export async function updateSyncCourse(runId: string, courseId: string, state: "running" | "complete" | "failed", error?: string) {
  const db = getDatabase();
  const row = await db.prepare("SELECT course_states_json FROM sync_runs WHERE id=?").bind(runId).first<D1Row>();
  const states = row ? JSON.parse(row.course_states_json || "{}") : {};
  states[courseId] = error ? { state, error } : state;
  const values = Object.values(states);
  const complete = values.every((value: any) => value === "complete" || value?.state === "failed");
  const anyFailed = values.some((value: any) => value?.state === "failed");
  await db.prepare(
    "UPDATE sync_runs SET course_states_json=?, status=?, finished_at=? WHERE id=?"
  ).bind(JSON.stringify(states), complete ? (anyFailed ? "partial" : "complete") : "running", complete ? new Date().toISOString() : null, runId).run();
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

export async function saveSource(source: CanvasSource, analysis: ExtractedAnalysis | null, hash: string, analysisStatus = analysis ? "complete" : "rule_only") {
  const db = getDatabase();
  const now = new Date().toISOString();
  const previous = await db.prepare(
    "SELECT content_hash, title, dates_json, is_active FROM source_items WHERE id=?"
  ).bind(source.id).first<D1Row>();
  const dates = JSON.stringify({ dueAt: source.dueAt, unlockAt: source.unlockAt, lockAt: source.lockAt, submissionState: source.submissionState ?? null, pointsPossible: source.pointsPossible ?? null, prerequisiteBlocked: Boolean(source.prerequisiteBlocked), file: source.file ? { name: source.file.name, size: source.file.size } : null });
  const changed = Boolean(previous && previous.content_hash !== hash);
  if (changed) {
    const before = JSON.stringify({ title: previous!.title, dates: JSON.parse(previous!.dates_json || "{}"), hash: previous!.content_hash });
    const after = JSON.stringify({ title: source.title, dates: JSON.parse(dates), hash });
    const oldDates = JSON.parse(previous!.dates_json || "{}");
    const newDates = JSON.parse(dates);
    const dateChanged = oldDates.dueAt !== newDates.dueAt || oldDates.unlockAt !== newDates.unlockAt || oldDates.lockAt !== newDates.lockAt;
    const submissionChanged = Object.hasOwn(oldDates, "submissionState") && oldDates.submissionState !== newDates.submissionState;
    const attachmentChanged = Object.hasOwn(oldDates, "file") && JSON.stringify(oldDates.file) !== JSON.stringify(newDates.file);
    const prerequisiteChanged = Object.hasOwn(oldDates, "prerequisiteBlocked") && oldDates.prerequisiteBlocked !== newDates.prerequisiteBlocked;
    const changeType = dateChanged ? "dates_updated" : submissionChanged ? "submission_updated" : attachmentChanged ? "attachment_updated" : prerequisiteChanged ? "prerequisite_updated" : "content_updated";
    await db.prepare(
      "INSERT INTO changes (course_id, source_item_id, change_type, title, before_json, after_json, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(source.courseId, source.id, changeType, source.title, before, after, now).run();
  }
  if (previous && !previous.is_active) {
    await db.prepare("INSERT INTO changes (course_id, source_item_id, change_type, title, before_json, after_json, detected_at) VALUES (?, ?, 'restored', ?, ?, ?, ?)")
      .bind(source.courseId, source.id, source.title, JSON.stringify({ missing: true }), JSON.stringify({ restored: true }), now).run();
  }
  await db.prepare(
    `INSERT INTO source_items
      (id, course_id, source_type, source_id, title, body, source_url, content_hash, remote_updated_at, dates_json, analysis_json, analysis_status, extraction_version, first_seen_at, last_seen_at, is_active, missing_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, source_url=excluded.source_url,
       content_hash=excluded.content_hash, remote_updated_at=excluded.remote_updated_at, dates_json=excluded.dates_json,
       analysis_json=COALESCE(excluded.analysis_json, source_items.analysis_json),
       analysis_status=excluded.analysis_status, extraction_version=excluded.extraction_version, last_seen_at=excluded.last_seen_at, is_active=1, missing_at=NULL`
  ).bind(
    source.id, source.courseId, source.sourceType, source.sourceId, source.title, source.body,
    source.sourceUrl, hash, source.updatedAt, dates, analysis ? JSON.stringify(analysis) : null,
    analysisStatus, EXTRACTION_VERSION, now, now
  ).run();

  const snippets = source.body.split(/\n+|(?<=[.!?。！？])\s+/).map((item) => item.trim()).filter((item) => item.length >= 12).slice(0, 3);
  const looksActionable = ["announcement", "page", "discussion"].includes(source.sourceType) && /\b(due|submit|complete|read|quiz|test|exam|deadline|required|before next class)\b|截止|提交|完成|阅读|测验|考试|必须|课前/i.test(source.title + " " + source.body);
  const looksCancelled = /\b(cancelled|canceled|replaced|no longer required|postponed)\b|取消|作废|替代|延期/i.test(source.title + " " + source.body);
  const actions = analysis?.actions?.length
    ? analysis.actions
    : source.sourceType === "assignment" || Boolean(source.dueAt) || looksActionable
      ? [{ title: source.title, action: source.sourceType === "assignment" ? "完成并提交 " + source.title : "查看并处理：" + source.title, requirements: snippets, recommendedStartAt: null, inferredDueAt: null, confidence: (source.dueAt || source.sourceType === "assignment" ? "certain" : "inferred") as "certain" | "inferred", evidence: source.body.slice(0, 220), estimatedMinutes: null, possiblyCancelled: looksCancelled }]
      : [];

  await db.prepare("DELETE FROM tasks WHERE source_item_id=?").bind(source.id).run();
  const taskStatements = actions.map((action, index) => {
    let status = classifyCanvasStatus(source);
    if (action.possiblyCancelled) status = "possibly_superseded";
    const taskId = source.id + ":" + index;
    return db.prepare(
      `INSERT INTO tasks
       (id, course_id, source_item_id, source_type, source_id, source_url, title, action, requirements_json,
        start_at, due_at, unlock_at, lock_at, canvas_status, urgency, confidence, evidence, estimated_minutes, points_possible, prerequisite_blocked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      taskId, source.courseId, source.id, source.sourceType, source.sourceId, source.sourceUrl,
      action.title || source.title, action.action, JSON.stringify(action.requirements || []),
      action.recommendedStartAt || null, source.dueAt || action.inferredDueAt, source.unlockAt, source.lockAt, status, urgencyForStatus(status),
      action.confidence, action.evidence || "", action.estimatedMinutes, source.pointsPossible ?? null, source.prerequisiteBlocked ? 1 : 0, now
    );
  });
  if (taskStatements.length) await db.batch(taskStatements);
  return { changed };
}

export async function reconcileCourseSources(courseId: string, seenIds: string[]) {
  const db = getDatabase();
  const current = await db.prepare("SELECT id, title FROM source_items WHERE course_id=? AND is_active=1").bind(courseId).all<D1Row>();
  const seen = new Set(seenIds);
  const missing = current.results.filter((row) => !seen.has(String(row.id)));
  const now = new Date().toISOString();
  for (const row of missing) {
    await db.batch([
      db.prepare("UPDATE source_items SET is_active=0, missing_at=? WHERE id=?").bind(now, row.id),
      db.prepare("UPDATE tasks SET canvas_status='possibly_superseded', urgency='review', updated_at=? WHERE source_item_id=?").bind(now, row.id),
      db.prepare("INSERT INTO changes (course_id, source_item_id, change_type, title, before_json, after_json, detected_at) VALUES (?, ?, 'source_missing', ?, ?, ?, ?)")
        .bind(courseId, row.id, row.title, JSON.stringify({ active: true }), JSON.stringify({ active: false }), now),
    ]);
  }
  return missing.length;
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

export async function rebuildCourseSummary(courseId: string) {
  const sources = await getDatabase().prepare("SELECT analysis_json FROM source_items WHERE course_id=? AND is_active=1 AND analysis_json IS NOT NULL ORDER BY last_seen_at DESC").bind(courseId).all<D1Row>();
  const analyses = sources.results.map((row) => { try { return JSON.parse(row.analysis_json); } catch { return null; } }).filter(Boolean);
  const courseTasks = (await listTasks()).filter((task) => task.courseId === courseId && task.localStatus === "active");
  const priorities = courseTasks.slice(0, 5).map((task) => task.action);
  const risks = courseTasks.filter((task) => ["locked", "overdue_open", "needs_review", "possibly_superseded"].includes(task.canvasStatus)).slice(0, 5).map((task) => task.title + "：" + statusLabels[task.canvasStatus]);
  const summary = analyses.map((analysis) => analysis.summary).filter(Boolean).slice(0, 8).join(" ") || `已读取 ${courseTasks.length} 项待办；当前使用 Canvas 确定字段生成课程状态。`;
  await saveCourseSummary(courseId, summary, priorities, risks, analyses.length > 0);
  return { summary, priorities, risks, aiAvailable: analyses.length > 0 };
}

export async function listTasks(): Promise<LearningTask[]> {
  const result = await getDatabase().prepare(
    `SELECT t.*, c.code course_code, c.name course_name, s.analysis_status, COALESCE(o.local_status, 'active') local_status
     FROM tasks t JOIN courses c ON c.id=t.course_id
     JOIN source_items s ON s.id=t.source_item_id
     LEFT JOIN task_overrides o ON o.task_id=t.id
     WHERE c.enabled=1 AND COALESCE(o.local_status, 'active') != 'ignored'
     ORDER BY CASE t.urgency WHEN 'urgent' THEN 1 WHEN 'soon' THEN 2 WHEN 'upcoming' THEN 3 ELSE 4 END,
       t.due_at IS NULL, t.due_at`
  ).all<D1Row>();
  return deduplicateTasks(result.results.map(rowToTask)).sort((a, b) => b.priorityScore - a.priorityScore);
}

function deduplicateTasks(tasks: LearningTask[]) {
  const canvasMirrors = new Set(["assignment", "quiz", "planner"]);
  const sourceRank: Record<string, number> = { assignment: 0, quiz: 1, planner: 2 };
  const selected = new Map<string, LearningTask>();
  const passthrough: LearningTask[] = [];
  for (const task of tasks) {
    if (!canvasMirrors.has(task.sourceType)) {
      passthrough.push(task);
      continue;
    }
    const normalizedTitle = task.title.toLocaleLowerCase().replace(/\s+/g, " ").trim();
    const key = `${task.courseId}|${normalizedTitle}|${task.dueAt || "no-date"}`;
    const current = selected.get(key);
    if (!current || (sourceRank[task.sourceType] ?? 99) < (sourceRank[current.sourceType] ?? 99)) selected.set(key, task);
  }
  return [...passthrough, ...selected.values()];
}

function rowToTask(row: D1Row): LearningTask {
  const liveStatus = ["completed", "possibly_superseded"].includes(row.canvas_status)
    ? row.canvas_status
    : classifyCanvasStatus({
        id: row.source_item_id, courseId: row.course_id, sourceType: row.source_type,
        sourceId: row.source_id, title: row.title, body: "", sourceUrl: row.source_url,
        updatedAt: row.updated_at, dueAt: row.due_at, unlockAt: row.unlock_at, lockAt: row.lock_at,
        pointsPossible: row.points_possible, prerequisiteBlocked: Boolean(row.prerequisite_blocked),
      });
  const score = priorityScore({ canvasStatus: liveStatus, dueAt: row.due_at, lockAt: row.lock_at, pointsPossible: row.points_possible, prerequisiteBlocked: Boolean(row.prerequisite_blocked) });
  return {
    id: row.id, courseId: row.course_id, courseCode: row.course_code, courseName: row.course_name,
    sourceType: row.source_type, sourceId: row.source_id, sourceUrl: row.source_url,
    title: row.title, action: row.action, requirements: JSON.parse(row.requirements_json || "[]"),
    startAt: row.start_at, dueAt: row.due_at, unlockAt: row.unlock_at, lockAt: row.lock_at,
    canvasStatus: liveStatus, localStatus: row.local_status,
    urgency: urgencyForTask(liveStatus, row.due_at), confidence: row.confidence, analysisStatus: row.analysis_status, evidence: row.evidence,
    estimatedMinutes: row.estimated_minutes, pointsPossible: row.points_possible,
    prerequisiteBlocked: Boolean(row.prerequisite_blocked), priorityScore: score, updatedAt: row.updated_at,
  };
}

export async function dashboardData(date: string) {
  const db = getDatabase();
  const [tasks, courseRows, changeRows, syncRow] = await Promise.all([
    listTasks(),
    db.prepare("SELECT * FROM courses WHERE enabled=1 ORDER BY code").all<D1Row>(),
    db.prepare(`SELECT ch.*, c.code course_code FROM changes ch JOIN courses c ON c.id=ch.course_id
      WHERE ch.change_type IN ('dates_updated', 'source_missing', 'restored', 'attachment_updated', 'prerequisite_updated')
      ORDER BY detected_at DESC LIMIT 8`).all<D1Row>(),
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

export async function saveDailyPlan(date: string, tasks: LearningTask[], aiAvailable: boolean, dailyMinutes = 150) {
  const sourceVersion = "v3|" + dailyMinutes + "|" + tasks.map((task) => task.id + ":" + task.updatedAt + ":" + task.localStatus).join("|");
  const now = new Date().toISOString();
  let remaining = dailyMinutes;
  const uniqueTasks = deduplicateTasks(tasks);
  const actionable = uniqueTasks.filter((task) => task.localStatus === "active" && task.urgency !== "review" && !["completed", "locked", "not_open", "possibly_superseded"].includes(task.canvasStatus));
  const scheduled: LearningTask[] = [];
  for (const task of actionable) {
    const estimate = task.estimatedMinutes || 45;
    const oldOverdue = task.canvasStatus === "overdue_open" && task.dueAt && (Date.now() - new Date(task.dueAt).getTime()) > 14 * 86400000;
    if (!oldOverdue && scheduled.length < 8 && estimate <= remaining) { scheduled.push(task); remaining -= estimate; }
  }
  const plan = {
    mustDo: scheduled.filter((task) => ["urgent", "soon"].includes(task.urgency)),
    shouldDo: scheduled.filter((task) => task.urgency === "upcoming"),
    review: uniqueTasks.filter((task) => task.localStatus === "active" && task.urgency === "review").slice(0, 8),
    capacityMinutes: dailyMinutes,
    scheduledMinutes: scheduled.reduce((sum, task) => sum + (task.estimatedMinutes || 45), 0),
    backlogCount: Math.max(0, actionable.length - scheduled.length),
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

export async function ensureDailyPlan(date: string, aiAvailable: boolean, dailyMinutes = 150) {
  const tasks = await listTasks();
  const sourceVersion = "v3|" + dailyMinutes + "|" + tasks.map((task) => task.id + ":" + task.updatedAt + ":" + task.localStatus).join("|");
  const cached = await getDatabase().prepare("SELECT source_version, plan_json FROM daily_plans WHERE date=?").bind(date).first<D1Row>();
  if (cached?.source_version === sourceVersion) return JSON.parse(cached.plan_json);
  return saveDailyPlan(date, tasks, aiAvailable, dailyMinutes);
}

export async function setTaskStatus(taskId: string, status: "active" | "completed" | "ignored") {
  await getDatabase().prepare(
    `INSERT INTO task_overrides (task_id, local_status, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET local_status=excluded.local_status, updated_at=excluded.updated_at`
  ).bind(taskId, status, new Date().toISOString()).run();
}

export async function getTaskCanvasTarget(taskId: string) {
  return getDatabase().prepare("SELECT source_type, source_id FROM tasks WHERE id=?").bind(taskId).first<{ source_type: string; source_id: string }>();
}

export async function getCourseDetail(courseId: string) {
  const db = getDatabase();
  const course = await db.prepare("SELECT * FROM courses WHERE id=? OR code=?").bind(courseId, courseId).first<D1Row>();
  if (!course) return null;
  const [taskRows, sourceRows, piazzaRows, summary] = await Promise.all([
    db.prepare(`SELECT t.*, c.code course_code, c.name course_name, s.analysis_status, COALESCE(o.local_status, 'active') local_status
      FROM tasks t JOIN courses c ON c.id=t.course_id JOIN source_items s ON s.id=t.source_item_id LEFT JOIN task_overrides o ON o.task_id=t.id WHERE t.course_id=? ORDER BY t.due_at IS NULL, t.due_at`).bind(course.id).all<D1Row>(),
    db.prepare("SELECT id, source_type, title, body, source_url, remote_updated_at, analysis_status, dates_json, is_active, missing_at FROM source_items WHERE course_id=? ORDER BY is_active DESC, CASE source_type WHEN 'announcement' THEN 1 WHEN 'assignment' THEN 2 WHEN 'module' THEN 3 WHEN 'page' THEN 4 WHEN 'quiz' THEN 5 WHEN 'discussion' THEN 6 WHEN 'file' THEN 7 ELSE 8 END, last_seen_at DESC LIMIT 500").bind(course.id).all<D1Row>(),
    db.prepare("SELECT id, title, body, source_url, remote_updated_at, is_active FROM piazza_posts WHERE course_id=? ORDER BY remote_updated_at DESC LIMIT 200").bind(course.id).all<D1Row>(),
    db.prepare("SELECT * FROM course_summaries WHERE course_id=?").bind(course.id).first<D1Row>(),
  ]);
  return {
    course: { id: course.id, code: course.code, name: course.name, termName: course.term_name, syncedAt: course.synced_at },
    tasks: deduplicateTasks(taskRows.results.map(rowToTask)).sort((a, b) => b.priorityScore - a.priorityScore),
    sources: [
      ...piazzaRows.results.map((row) => ({ id: row.id, type: "piazza", title: row.title, body: String(row.body || ""), excerpt: String(row.body || "").slice(0, 420), url: row.source_url, updatedAt: row.remote_updated_at, analysisStatus: "imported", dates: {}, active: Boolean(row.is_active), missingAt: null })),
      ...sourceRows.results.map((row) => ({ id: row.id, type: row.source_type, title: row.title, body: String(row.body || ""), excerpt: String(row.body || "").slice(0, 420), url: row.source_url, updatedAt: row.remote_updated_at, analysisStatus: row.analysis_status, dates: JSON.parse(row.dates_json || "{}"), active: Boolean(row.is_active), missingAt: row.missing_at })),
    ],
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
  return row ? { timezone: row.timezone, dailyMinutes: row.daily_minutes, displayName: String(row.display_name || "") } : { timezone: "America/Toronto", dailyMinutes: 150, displayName: "" };
}

export async function saveSettings(ownerId: string, timezone: string, dailyMinutes: number, displayName?: string) {
  const name = displayName ?? (await getSettings(ownerId)).displayName;
  await getDatabase().prepare(
    `INSERT INTO settings (owner_id, timezone, daily_minutes, updated_at, display_name) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id) DO UPDATE SET timezone=excluded.timezone, daily_minutes=excluded.daily_minutes, updated_at=excluded.updated_at, display_name=excluded.display_name`
  ).bind(ownerId, timezone, dailyMinutes, new Date().toISOString(), name).run();
}

export async function listCourseSettings() {
  const result = await getDatabase().prepare("SELECT id, code, name, enabled FROM courses ORDER BY code").all<D1Row>();
  return result.results.map((row) => ({ id: row.id, code: row.code, name: row.name, enabled: Boolean(row.enabled) }));
}

export async function setCourseEnabled(courseId: string, enabled: boolean) {
  await getDatabase().prepare("UPDATE courses SET enabled=?, updated_at=? WHERE id=?")
    .bind(enabled ? 1 : 0, new Date().toISOString(), courseId).run();
}

export type ImportedScheduleEvent = {
  uid: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
};

export async function saveScheduleEvents(sourceName: string, events: ImportedScheduleEvent[]) {
  const db = getDatabase();
  const now = new Date().toISOString();
  const statements = events.map((event) => db.prepare(
    `INSERT INTO schedule_events (id, external_uid, source_name, title, description, start_at, end_at, all_day, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_name, external_uid) DO UPDATE SET title=excluded.title, description=excluded.description,
       start_at=excluded.start_at, end_at=excluded.end_at, all_day=excluded.all_day, updated_at=excluded.updated_at`
  ).bind(`${sourceName}:${event.uid}`, event.uid, sourceName, event.title, event.description, event.startAt, event.endAt, event.allDay ? 1 : 0, now));
  if (statements.length) await db.batch(statements);
  return events.length;
}

export async function listScheduleEvents(startAt: string, endAt: string) {
  const result = await getDatabase().prepare(
    "SELECT * FROM schedule_events WHERE end_at>=? AND start_at<=? ORDER BY start_at, end_at"
  ).bind(startAt, endAt).all<D1Row>();
  return result.results.map((row) => ({
    id: row.id,
    uid: row.external_uid,
    sourceName: row.source_name,
    title: row.title,
    description: row.description,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: Boolean(row.all_day),
  }));
}

export type CourseSearchResult = {
  ref: string;
  sourceId: string;
  courseId: string;
  courseCode: string;
  sourceType: string;
  title: string;
  excerpt: string;
  body: string;
  sourceUrl: string | null;
  updatedAt: string | null;
  confirmedAnswer?: boolean;
  unconfirmedDiscussion?: boolean;
};

function searchTerms(question: string) {
  const normalized = question.toLocaleLowerCase();
  const terms = new Set(normalized.match(/[a-z0-9][a-z0-9#_-]{1,}|[\u3400-\u9fff]{2,}/gu) || []);
  if (/第一(?:节|次)?|lab\s*#?0?1\b/i.test(question)) ["lab 1", "lab #1", "lab 01"].forEach((term) => terms.add(term));
  activitySearchAliases(question).forEach((term) => terms.add(term));
  if (/怎么|要求|如何|what|how/i.test(question)) ["requirement", "instruction", "complete", "submit"].forEach((term) => terms.add(term));
  return [...terms].filter((term) => !["我的", "这个", "什么", "怎么做", "课程内容"].includes(term));
}

export async function searchCourseContent(question: string, courseId?: string, limit = 8): Promise<CourseSearchResult[]> {
  const requestedCodes = question.toUpperCase().match(/[A-Z]{2,}\s*\d{2,}(?:H\d)?/g)?.map((code) => code.replace(/\s/g, "").replace(/H\d$/, "")) || [];
  const piazzaOnly = /piazza/i.test(question);
  const summary = /总结|汇总|概览|概括|summari[sz]|summary|overview/i.test(question);
  const terms = searchTerms(question);
  if (!terms.length) return [];
  const db = getDatabase();
  const indexed = await searchIndexAvailable();
  const match = ftsMatchTerms(terms);
  const broadSummary = summary && Boolean(requestedCodes.length || courseId || piazzaOnly);
  const useIndex = indexed && Boolean(match) && !broadSummary;
  const fallbackTerms = terms.filter((term) => term.length >= 2).slice(0, 12);
  const likeFilter = (alias: string, columns: string[]) => fallbackTerms.map(() => `(${columns.map((column) => `lower(${alias}.${column}) LIKE ?`).join(' OR ')})`).join(' OR ');
  const likeArgs = (columns: number) => fallbackTerms.flatMap((term) => Array(columns).fill(`%${term.toLocaleLowerCase()}%`));
  const candidateLimit = Math.min(1800, Math.max(600, limit * 12));
  const canvasRows = piazzaOnly ? { results: [] as D1Row[] } : await db.prepare(
    `SELECT s.id, s.course_id, c.code course_code, s.source_type, s.title, s.body, s.source_url,
      s.remote_updated_at, s.analysis_json, '' answer, '' kind
     FROM source_items s JOIN courses c ON c.id=s.course_id ${useIndex ? 'JOIN source_items_fts ON source_items_fts.rowid=s.rowid' : ''}
     WHERE s.is_active=1 AND c.enabled=1 ${courseId ? "AND (s.course_id=? OR c.code=?)" : ""}
     ${useIndex ? 'AND source_items_fts MATCH ?' : !broadSummary ? `AND (${likeFilter('s',['title','body','analysis_json'])})` : ''}
     ORDER BY ${useIndex ? 'bm25(source_items_fts,10.0,2.0,1.0)' : 's.last_seen_at DESC'} LIMIT ?`
  ).bind(...(courseId ? [courseId, courseId] : []),...(useIndex ? [match] : broadSummary ? [] : likeArgs(3)),candidateLimit).all<D1Row>();
  const piazzaRows = await db.prepare(
    `SELECT p.id, p.course_id, c.code course_code, 'piazza' source_type, p.title, p.body, p.source_url,
      p.remote_updated_at, NULL analysis_json, p.answer, p.kind
     FROM piazza_posts p JOIN courses c ON c.id=p.course_id ${useIndex ? 'JOIN piazza_posts_fts ON piazza_posts_fts.rowid=p.rowid' : ''}
     WHERE p.is_active=1 AND c.enabled=1 ${courseId ? "AND (p.course_id=? OR c.code=?)" : ""}
     ${useIndex ? 'AND piazza_posts_fts MATCH ?' : !broadSummary ? `AND (${likeFilter('p',['title','body','answer'])})` : ''}
     ORDER BY ${useIndex ? 'bm25(piazza_posts_fts,10.0,1.0,6.0)' : 'p.remote_updated_at DESC'} LIMIT ?`
  ).bind(...(courseId ? [courseId, courseId] : []),...(useIndex ? [match] : broadSummary ? [] : likeArgs(3)),candidateLimit).all<D1Row>();
  const scheduleRows = courseId ? { results: [] as D1Row[] } : await db.prepare(
    `SELECT id, 'schedule' course_id, '个人日程' course_code, 'schedule' source_type, title,
      (description || '\n开始：' || start_at || '\n结束：' || end_at) body, NULL source_url,
      updated_at remote_updated_at, NULL analysis_json, '' answer, '' kind
     FROM schedule_events ORDER BY start_at DESC LIMIT 1000`
  ).all<D1Row>();
  const rows = { results: [...canvasRows.results, ...piazzaRows.results, ...scheduleRows.results].filter((row) => {
    const code = String(row.course_code).toUpperCase().replace(/\s/g, "").match(/[A-Z]{2,}\d+/)?.[0];
    return (!requestedCodes.length || requestedCodes.includes(code || "")) && (!piazzaOnly || row.source_type === "piazza");
  }) };

  const ranked = rows.results.map((row) => {
    const title = String(row.title || "");
    const body = String(row.body || "");
    const answer = String(row.answer || "");
    const analysis = String(row.analysis_json || "");
    const titleText = title.toLocaleLowerCase();
    const bodyText = (body + " " + analysis).toLocaleLowerCase();
    const answerText = answer.toLocaleLowerCase();
    let score = 0;
    for (const term of terms) {
      if (titleText.includes(term)) score += 9;
      if (bodyText.includes(term)) score += 2;
      if (answerText.includes(term)) score += 5;
    }
    if (summary && (requestedCodes.length || courseId || piazzaOnly)) score += 1;
    return { row, title, body, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);

  // Preserve a small number of authoritative results before the global limit.
  // Otherwise numerous high-scoring Canvas file titles can hide a teacher's
  // Piazza answer before the archive merger ever sees it.
  const prioritized = [
    ...ranked.filter((item) => item.row.source_type === 'piazza' && item.row.kind === 'question' && Boolean(item.row.answer)).slice(0, Math.min(2, limit)),
    ...ranked.filter((item) => ['assignment', 'quiz', 'page'].includes(String(item.row.source_type))).slice(0, Math.min(2, limit)),
    ...ranked,
  ];
  const seen = new Set<string>();
  const selected: typeof ranked = [];
  for (const item of prioritized) {
    if (seen.has(String(item.row.id))) continue;
    seen.add(String(item.row.id));
    selected.push(item);
    if (selected.length >= limit) break;
  }

  return selected.map((item, index) => {
    const lower = item.body.toLocaleLowerCase();
    const firstMatch = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, firstMatch - 220);
    const confirmedAnswer = item.row.source_type === 'piazza' && item.row.kind === 'question' && Boolean(item.row.answer);
    const unconfirmedDiscussion = item.row.source_type === 'piazza' && (item.row.kind === 'unknown' || item.row.kind === 'question' && !confirmedAnswer);
    const piazzaBody = item.row.source_type !== 'piazza' ? item.body : confirmedAnswer
      ? `教师明确回答：${String(item.row.answer)}\n\n讨论背景（含未经确认的学生发言）：${item.body}`
      : item.row.kind === 'question'
        ? `此问答帖尚无教师明确回答。以下讨论不可当作已确认课程要求：${item.body}`
        : item.row.kind === 'unknown'
          ? `旧 Piazza 归档，发帖身份未核实。以下内容不可当作教师确认：${item.body}`
          : `Piazza 帖子正文：${item.body}`;
    const excerpt = piazzaBody.slice(item.row.source_type === 'piazza' ? 0 : start, (item.row.source_type === 'piazza' ? 0 : start) + 1400).trim();
    return {
      ref: `S${index + 1}`,
      sourceId: String(item.row.id),
      courseId: String(item.row.course_id),
      courseCode: String(item.row.course_code),
      sourceType: String(item.row.source_type),
      title: item.title,
      excerpt,
      body: piazzaBody.slice(0, 12000),
      sourceUrl: item.row.source_url ? String(item.row.source_url) : null,
      updatedAt: item.row.remote_updated_at ? String(item.row.remote_updated_at) : null,
      confirmedAnswer,
      unconfirmedDiscussion,
    };
  });
}

export async function saveIntegrationConnection(provider: string, encryptedSecret: string, metadata: Record<string, unknown>, status = "connected") {
  await getDatabase().prepare(
    `INSERT INTO integration_connections (provider, secret_encrypted, metadata_json, status, last_synced_at, updated_at, error)
     VALUES (?, ?, ?, ?, NULL, ?, NULL)
     ON CONFLICT(provider) DO UPDATE SET secret_encrypted=excluded.secret_encrypted, metadata_json=excluded.metadata_json,
       status=excluded.status, updated_at=excluded.updated_at, error=NULL`
  ).bind(provider, encryptedSecret, JSON.stringify(metadata), status, new Date().toISOString()).run();
}

export async function getIntegrationConnection(provider: string) {
  const row = await getDatabase().prepare("SELECT * FROM integration_connections WHERE provider=?").bind(provider).first<D1Row>();
  if (!row) return null;
  return { provider: row.provider, encryptedSecret: row.secret_encrypted, metadata: JSON.parse(row.metadata_json || "{}"), status: row.status, lastSyncedAt: row.last_synced_at, updatedAt: row.updated_at, error: row.error };
}

export async function updateIntegrationStatus(provider: string, status: string, error: string | null = null, metadata?: Record<string, unknown>) {
  const current = await getIntegrationConnection(provider);
  if (!current) return;
  await getDatabase().prepare("UPDATE integration_connections SET status=?, error=?, metadata_json=?, last_synced_at=?, updated_at=? WHERE provider=?")
    .bind(status, error, JSON.stringify(metadata || current.metadata), status === "connected" ? new Date().toISOString() : current.lastSyncedAt, new Date().toISOString(), provider).run();
}

export async function deleteIntegrationConnection(provider: string) {
  await getDatabase().prepare("DELETE FROM integration_connections WHERE provider=?").bind(provider).run();
}

export async function savePiazzaPost(post: { id: string; courseId: string; networkId: string; postNumber: string; title: string; body: string; answer: string; kind: string; createdAt: string | null; sourceUrl: string; folders: string[]; updatedAt: string | null; contentHash: string }) {
  await getDatabase().prepare(`INSERT OR IGNORE INTO piazza_post_versions
    (post_id, content_hash, course_id, title, body, source_url, remote_updated_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(post.id, post.contentHash, post.courseId, post.title, post.body, post.sourceUrl, post.updatedAt, new Date().toISOString()).run();
  await getDatabase().prepare(
    `INSERT INTO piazza_posts (id, course_id, network_id, post_number, title, body, answer, kind, created_at, source_url, folders_json, content_hash, remote_updated_at, synced_at, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id, title=excluded.title, body=excluded.body, answer=excluded.answer, kind=excluded.kind, created_at=excluded.created_at,
       source_url=excluded.source_url, folders_json=excluded.folders_json, content_hash=excluded.content_hash,
       remote_updated_at=excluded.remote_updated_at, synced_at=excluded.synced_at, is_active=1`
  ).bind(post.id, post.courseId, post.networkId, post.postNumber, post.title, post.body, post.answer, post.kind, post.createdAt, post.sourceUrl, JSON.stringify(post.folders), post.contentHash, post.updatedAt, new Date().toISOString()).run();
}

export async function getPiazzaPostState(id: string) {
  return getDatabase().prepare("SELECT content_hash, remote_updated_at FROM piazza_posts WHERE id=?").bind(id).first<{ content_hash: string; remote_updated_at: string | null }>();
}

export async function countPiazzaPosts(courseId?: string) {
  const row = await getDatabase().prepare(`SELECT COUNT(*) count FROM piazza_posts WHERE is_active=1 ${courseId ? "AND course_id=?" : ""}`)
    .bind(...(courseId ? [courseId] : [])).first<{ count: number }>();
  return Number(row?.count || 0);
}

export async function listShortcuts() {
  const result = await getDatabase().prepare("SELECT id, title, url, icon_url, sort_order FROM shortcuts ORDER BY sort_order, created_at").all<D1Row>();
  return result.results.map((row) => ({ id: String(row.id), title: String(row.title), url: String(row.url), iconUrl: row.icon_url ? String(row.icon_url) : null, sortOrder: Number(row.sort_order || 0) }));
}

export async function saveShortcut(title: string, url: string, iconUrl: string | null) {
  const now = new Date().toISOString();
  const existing = await getDatabase().prepare("SELECT id FROM shortcuts WHERE url=?").bind(url).first<{ id: string }>();
  const id = existing?.id || crypto.randomUUID();
  await getDatabase().prepare(
    `INSERT INTO shortcuts (id, title, url, icon_url, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM shortcuts), ?, ?)
     ON CONFLICT(url) DO UPDATE SET title=excluded.title, icon_url=excluded.icon_url, updated_at=excluded.updated_at`
  ).bind(id, title, url, iconUrl, now, now).run();
  return id;
}

export async function deleteShortcut(id: string) {
  await getDatabase().prepare("DELETE FROM shortcuts WHERE id=?").bind(id).run();
}
