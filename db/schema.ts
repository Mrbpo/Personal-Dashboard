import { integer, sqliteTable, text, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  code: text("code").notNull(),
  termName: text("term_name"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull(),
  syncedAt: text("synced_at"),
});

export const sourceItems = sqliteTable("source_items", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  sourceUrl: text("source_url"),
  contentHash: text("content_hash").notNull(),
  remoteUpdatedAt: text("remote_updated_at"),
  datesJson: text("dates_json").notNull().default("{}"),
  analysisJson: text("analysis_json"),
  analysisStatus: text("analysis_status").notNull().default("pending"),
  firstSeenAt: text("first_seen_at").notNull(),
  lastSeenAt: text("last_seen_at").notNull(),
}, (table) => [
  uniqueIndex("idx_source_course_type_remote").on(table.courseId, table.sourceType, table.sourceId),
  index("idx_source_course").on(table.courseId),
  index("idx_source_hash").on(table.contentHash),
]);

export const assignments = sqliteTable("assignments", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  htmlUrl: text("html_url"),
  dueAt: text("due_at"),
  unlockAt: text("unlock_at"),
  lockAt: text("lock_at"),
  pointsPossible: integer("points_possible"),
  submissionState: text("submission_state"),
  submittedAt: text("submitted_at"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_assignments_course_due").on(table.courseId, table.dueAt),
]);

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  courseId: text("course_id").notNull(),
  sourceItemId: text("source_item_id").notNull(),
  sourceType: text("source_type").notNull(),
  sourceId: text("source_id").notNull(),
  sourceUrl: text("source_url"),
  title: text("title").notNull(),
  action: text("action").notNull(),
  requirementsJson: text("requirements_json").notNull().default("[]"),
  dueAt: text("due_at"),
  unlockAt: text("unlock_at"),
  lockAt: text("lock_at"),
  canvasStatus: text("canvas_status").notNull(),
  urgency: text("urgency").notNull(),
  confidence: text("confidence").notNull(),
  evidence: text("evidence").notNull().default(""),
  estimatedMinutes: integer("estimated_minutes"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("idx_tasks_course_due").on(table.courseId, table.dueAt),
  index("idx_tasks_status_due").on(table.canvasStatus, table.dueAt),
]);

export const taskOverrides = sqliteTable("task_overrides", {
  taskId: text("task_id").primaryKey(),
  localStatus: text("local_status").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const courseSummaries = sqliteTable("course_summaries", {
  courseId: text("course_id").primaryKey(),
  summary: text("summary").notNull(),
  prioritiesJson: text("priorities_json").notNull().default("[]"),
  risksJson: text("risks_json").notNull().default("[]"),
  aiAvailable: integer("ai_available", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull(),
});

export const dailyPlans = sqliteTable("daily_plans", {
  date: text("date").primaryKey(),
  planJson: text("plan_json").notNull(),
  sourceVersion: text("source_version").notNull(),
  aiAvailable: integer("ai_available", { mode: "boolean" }).notNull().default(false),
  generatedAt: text("generated_at").notNull(),
});

export const changes = sqliteTable("changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  courseId: text("course_id").notNull(),
  sourceItemId: text("source_item_id").notNull(),
  changeType: text("change_type").notNull(),
  title: text("title").notNull(),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  detectedAt: text("detected_at").notNull(),
}, (table) => [
  index("idx_changes_detected").on(table.detectedAt),
  index("idx_changes_course").on(table.courseId),
]);

export const syncRuns = sqliteTable("sync_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  courseStatesJson: text("course_states_json").notNull().default("{}"),
  error: text("error"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

export const settings = sqliteTable("settings", {
  ownerId: text("owner_id").primaryKey(),
  timezone: text("timezone").notNull().default("America/Toronto"),
  dailyMinutes: integer("daily_minutes").notNull().default(150),
  updatedAt: text("updated_at").notNull(),
});
