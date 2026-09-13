import test from "node:test";
import assert from "node:assert/strict";
import { classifyCanvasStatus, urgencyForStatus } from "../lib/task-rules.ts";
import type { CanvasSource } from "../lib/domain.ts";

function source(overrides: Partial<CanvasSource>): CanvasSource {
  return {
    id: "1:assignment:1", courseId: "1", sourceType: "assignment", sourceId: "1",
    title: "Test", body: "", sourceUrl: null, updatedAt: null, dueAt: null,
    unlockAt: null, lockAt: null, ...overrides,
  };
}

const now = new Date("2026-09-13T12:00:00-04:00");

test("submitted work is complete", () => {
  assert.equal(classifyCanvasStatus(source({ submissionState: "submitted" }), now), "completed");
});

test("locked work wins over an overdue due date", () => {
  assert.equal(classifyCanvasStatus(source({ dueAt: "2026-09-12T12:00:00-04:00", lockAt: "2026-09-13T11:00:00-04:00" }), now), "locked");
});

test("overdue but unlocked work remains actionable", () => {
  assert.equal(classifyCanvasStatus(source({ dueAt: "2026-09-13T10:00:00-04:00", lockAt: "2026-09-14T10:00:00-04:00" }), now), "overdue_open");
});

test("future unlock is not open", () => {
  assert.equal(classifyCanvasStatus(source({ unlockAt: "2026-09-14T10:00:00-04:00" }), now), "not_open");
});

test("missing date needs review", () => {
  assert.equal(classifyCanvasStatus(source({}), now), "needs_review");
  assert.equal(urgencyForStatus("needs_review"), "review");
});
