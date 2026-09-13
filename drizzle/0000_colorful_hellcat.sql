CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`html_url` text,
	`due_at` text,
	`unlock_at` text,
	`lock_at` text,
	`points_possible` integer,
	`submission_state` text,
	`submitted_at` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_assignments_course_due` ON `assignments` (`course_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` text NOT NULL,
	`source_item_id` text NOT NULL,
	`change_type` text NOT NULL,
	`title` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`detected_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_changes_detected` ON `changes` (`detected_at`);--> statement-breakpoint
CREATE INDEX `idx_changes_course` ON `changes` (`course_id`);--> statement-breakpoint
CREATE TABLE `course_summaries` (
	`course_id` text PRIMARY KEY NOT NULL,
	`summary` text NOT NULL,
	`priorities_json` text DEFAULT '[]' NOT NULL,
	`risks_json` text DEFAULT '[]' NOT NULL,
	`ai_available` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`code` text NOT NULL,
	`term_name` text,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL,
	`synced_at` text
);
--> statement-breakpoint
CREATE TABLE `daily_plans` (
	`date` text PRIMARY KEY NOT NULL,
	`plan_json` text NOT NULL,
	`source_version` text NOT NULL,
	`ai_available` integer DEFAULT false NOT NULL,
	`generated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`timezone` text DEFAULT 'America/Toronto' NOT NULL,
	`daily_minutes` integer DEFAULT 150 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_items` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`source_url` text,
	`content_hash` text NOT NULL,
	`remote_updated_at` text,
	`dates_json` text DEFAULT '{}' NOT NULL,
	`analysis_json` text,
	`analysis_status` text DEFAULT 'pending' NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_source_course_type_remote` ON `source_items` (`course_id`,`source_type`,`source_id`);--> statement-breakpoint
CREATE INDEX `idx_source_course` ON `source_items` (`course_id`);--> statement-breakpoint
CREATE INDEX `idx_source_hash` ON `source_items` (`content_hash`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`course_states_json` text DEFAULT '{}' NOT NULL,
	`error` text,
	`started_at` text NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE TABLE `task_overrides` (
	`task_id` text PRIMARY KEY NOT NULL,
	`local_status` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`source_item_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_url` text,
	`title` text NOT NULL,
	`action` text NOT NULL,
	`requirements_json` text DEFAULT '[]' NOT NULL,
	`due_at` text,
	`unlock_at` text,
	`lock_at` text,
	`canvas_status` text NOT NULL,
	`urgency` text NOT NULL,
	`confidence` text NOT NULL,
	`evidence` text DEFAULT '' NOT NULL,
	`estimated_minutes` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_course_due` ON `tasks` (`course_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status_due` ON `tasks` (`canvas_status`,`due_at`);
--> statement-breakpoint
PRAGMA optimize;
