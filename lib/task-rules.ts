import type { CanvasSource, CanvasStatus, Urgency } from "./domain";

export function classifyCanvasStatus(source: CanvasSource, now = new Date()): CanvasStatus {
  if (source.submissionState === "submitted" || source.submissionState === "graded") return "completed";
  if (source.prerequisiteBlocked) return "locked";
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

export function priorityScore(task: Pick<CanvasSource, "dueAt" | "lockAt" | "pointsPossible" | "prerequisiteBlocked"> & { canvasStatus: CanvasStatus }, now = new Date()) {
  const base: Record<CanvasStatus, number> = { due_today: 900, overdue_open: 860, due_soon: 720, locked: 640, not_open: 180, upcoming: 420, completed: 0, possibly_superseded: 80, needs_review: 360 };
  let score = base[task.canvasStatus];
  if (task.dueAt) {
    const hours = (new Date(task.dueAt).getTime() - now.getTime()) / 3600000;
    if (Number.isFinite(hours) && hours > 0) score += Math.max(0, 180 - Math.min(180, hours));
    if (Number.isFinite(hours) && hours < -24 * 14) score -= Math.min(700, Math.abs(hours) / 6);
  }
  if (task.lockAt) {
    const lockHours = (new Date(task.lockAt).getTime() - now.getTime()) / 3600000;
    if (lockHours > 0 && lockHours < 72) score += 120;
  }
  score += Math.min(100, Number(task.pointsPossible || 0) * 2);
  if (task.prerequisiteBlocked) score += 60;
  return Math.round(score);
}

export function urgencyForTask(status: CanvasStatus, dueAt: string | null, now = new Date()): Urgency {
  if (status === "overdue_open" && dueAt) {
    const ageDays = (now.getTime() - new Date(dueAt).getTime()) / 86400000;
    if (ageDays > 14) return "review";
  }
  return urgencyForStatus(status);
}

export const statusLabels: Record<CanvasStatus, string> = {
  due_today: "今日到期", due_soon: "即将到期", upcoming: "之后到期", overdue_open: "逾期仍可交",
  locked: "已锁定", not_open: "尚未开放", completed: "已完成", possibly_superseded: "疑似取消或替代", needs_review: "需要确认",
};

export function urgencyForStatus(status: CanvasStatus): Urgency {
  if (status === "due_today" || status === "overdue_open") return "urgent";
  if (status === "due_soon") return "soon";
  if (status === "upcoming" || status === "not_open") return "upcoming";
  return "review";
}
