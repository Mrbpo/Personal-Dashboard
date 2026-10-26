import type { LearningTask } from './domain.ts';

export const DUE_WINDOW_DAYS = 16;
export const OVERDUE_WINDOW_DAYS = 7;
type DeadlineTask = Pick<LearningTask, 'id' | 'dueAt' | 'dueDate' | 'duePrecision' | 'localStatus' | 'canvasStatus' | 'cancelledAt'>;

export function calendarDay(now: number, timezone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(day: string, days: number) {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

function validDate(day: string | null | undefined): day is string {
  return Boolean(day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T12:00:00Z`)) && new Date(`${day}T12:00:00Z`).toISOString().slice(0, 10) === day);
}

export function taskDeadline(task: DeadlineTask, timezone: string, now = Date.now()) {
  if (task.duePrecision === 'date') {
    if (!validDate(task.dueDate)) return null;
    // A date-only deadline is a calendar date, never an invented midnight/23:59 instant.
    return { day: task.dueDate, overdue: task.dueDate < calendarDay(now, timezone), instant: null };
  }
  if (!task.dueAt || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(task.dueAt)) return null;
  const instant = Date.parse(task.dueAt);
  return Number.isFinite(instant) ? { day: calendarDay(instant, timezone), overdue: instant < now, instant } : null;
}

export function deadlineWindowBounds(timezone: string, now = Date.now()) {
  const today = calendarDay(now, timezone);
  return {start:addCalendarDays(today,-OVERDUE_WINDOW_DAYS),end:addCalendarDays(today,DUE_WINDOW_DAYS)};
}

export function dueWindow<T extends DeadlineTask>(tasks: T[], timezone: string, now = Date.now()): T[] {
  const {start,end} = deadlineWindowBounds(timezone,now);
  return tasks.filter(task => task.localStatus === 'active' && task.canvasStatus !== 'completed' && !task.cancelledAt)
    .map(task => ({ task, deadline: taskDeadline(task, timezone, now) }))
    .filter((row): row is { task: T; deadline: NonNullable<ReturnType<typeof taskDeadline>> } => Boolean(row.deadline && row.deadline.day >= start && row.deadline.day < end))
    .sort((a, b) => a.deadline.day.localeCompare(b.deadline.day) || (a.deadline.instant ?? -Infinity) - (b.deadline.instant ?? -Infinity) || a.task.id.localeCompare(b.task.id))
    .map(row => row.task);
}

export function formatTaskDeadline(task: DeadlineTask, timezone: string) {
  const deadline = taskDeadline(task, timezone);
  if (!deadline) return '截止日期待确认';
  if (task.duePrecision === 'date') return new Date(`${deadline.day}T12:00:00Z`).toLocaleDateString('zh-CN', { timeZone: 'UTC', month: 'short', day: 'numeric' }) + '（全天）';
  return new Date(deadline.instant!).toLocaleString('zh-CN', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', ...(task.duePrecision === 'hour' ? {} : { minute: '2-digit' }), ...(task.duePrecision === 'second' ? { second: '2-digit' } : {}) });
}
