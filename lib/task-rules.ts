import type { CanvasSource, CanvasStatus, Urgency } from "./domain";

export function classifyCanvasStatus(source: CanvasSource, now = new Date()): CanvasStatus {
  if (source.submissionState === "submitted" || source.submissionState === "graded") return "completed";
  const due = source.dueAt ? new Date(source.dueAt) : null;
  const unlock = source.unlockAt ? new Date(source.unlockAt) : null;
  const lock = source.lockAt ? new Date(source.lockAt) : null;
  if (unlock && unlock > now) return "not_open";
  if (lock && lock < now) return "locked";
  if (!due) return "needs_review";
  const hours = (due.getTime() - now.getTime()) / 3600000;
  if (hours < 0) return "overdue_open";
  if (hours <= 24 && due.toLocaleDateString("en-CA", { timeZone: "America/Toronto" }) === now.toLocaleDateString("en-CA", { timeZone: "America/Toronto" })) return "due_today";
  if (hours <= 72) return "due_soon";
  return "upcoming";
}

export function urgencyForStatus(status: CanvasStatus): Urgency {
  if (status === "due_today" || status === "overdue_open") return "urgent";
  if (status === "due_soon") return "soon";
  if (status === "upcoming" || status === "not_open") return "upcoming";
  return "review";
}
