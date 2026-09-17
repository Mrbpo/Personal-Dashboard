import type { LearningTask } from './domain.ts';
export type AgendaPrefs = { start: string; end: string; minutes: number; confirmed: boolean };
export type AgendaEvent = { title: string; startAt: string; endAt: string };
export type AgendaBlock = { id: string; taskId: string; date: string; start: string; end: string; minutes: number; title: string; course: string; action: string; target: string; reason: string; sourceUrl: string | null; evidence: string; estimated: boolean; done: boolean };
export function zonedTime(date: string, clock: string, timezone: string) {
  const target = Date.parse(`${date}T${clock}:00Z`);
  let value = target;
  for (let n = 0; n < 3; n++) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    const observed = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
    value += target - observed;
  }
  return value;
}
export function buildAgenda(tasks: LearningTask[], events: AgendaEvent[], prefs: AgendaPrefs, timezone: string, completed: string[] = [], now = Date.now()) {
  const first = new Date(now).toLocaleDateString('en-CA', { timeZone: timezone });
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.parse(first + 'T12:00:00Z') + i * 86400000).toISOString().slice(0, 10));
  const slots: { date: string; start: number; end: number; used: number }[] = [];
  for (const date of days) {
    let cursor = Math.max(zonedTime(date, prefs.start, timezone), Math.ceil(now / 300000) * 300000);
    const end = zonedTime(date, prefs.end, timezone);
    const busy = events.map(e => ({ start: Date.parse(e.startAt), end: Date.parse(e.endAt) })).filter(e => e.end > cursor && e.start < end).sort((a,b) => a.start-b.start);
    for (const event of busy) { if (event.start > cursor) slots.push({ date, start: cursor, end: Math.min(event.start, end), used: 0 }); cursor = Math.max(cursor, event.end); }
    if (cursor < end) slots.push({ date, start: cursor, end, used: 0 });
  }
  const blocks: AgendaBlock[] = [];
  const warnings: { taskId: string; title: string; reason: string }[] = [];
  const daily = new Map<string, number>();
  const seen = new Set<string>();
  for (const task of [...tasks].sort((a,b) => (Date.parse(a.dueAt || '') || Infinity) - (Date.parse(b.dueAt || '') || Infinity) || b.priorityScore-a.priorityScore)) {
    if (task.localStatus !== 'active' || task.canvasStatus === 'completed') continue;
    const key = task.courseId + ':' + task.sourceType + ':' + task.sourceId;
    if (seen.has(key)) continue; seen.add(key);
    if (task.prerequisiteBlocked || ['locked', 'possibly_superseded', 'needs_review'].includes(task.canvasStatus)) { warnings.push({ taskId: task.id, title: task.action, reason: '任务受限或要求需确认，未自动排入' }); continue; }
    const requirements = task.requirements.filter(r => r.trim());
    const steps = requirements.length ? requirements : ['打开原始资料，确认具体要求、交付物和评分标准'];
    // Missing estimates produce a short clarification session, not a fabricated full-task duration.
    const estimate = task.estimatedMinutes && task.estimatedMinutes > 0 ? task.estimatedMinutes : 15;
    const minutesPerStep = Math.max(5, Math.ceil(estimate / steps.length / 5) * 5);
    const deadline = Math.min(task.dueAt ? Date.parse(task.dueAt) : Infinity, task.lockAt ? Date.parse(task.lockAt) : Infinity);
    const unlock = task.unlockAt ? Date.parse(task.unlockAt) : 0;
    let missing = 0;
    let order = 0;
    let precedingEnd = unlock;
    for (let i = 0; i < steps.length; i++) {
      let remaining = task.estimatedMinutes ? minutesPerStep : (i === 0 ? 15 : 0);
      while (remaining > 0) {
        const part = ++order;
        const id = `${task.id}:${task.updatedAt}:${i}:${part}`;
        const size = Math.min(40, remaining);
        if (completed.includes(id)) { remaining -= size; continue; }
        const slot = slots.find(s => Math.max(s.start, precedingEnd) + size * 60000 <= Math.min(s.end, deadline) && (daily.get(s.date) || 0) + size <= prefs.minutes);
        if (!slot) { missing += remaining; break; }
        const start = Math.max(slot.start, precedingEnd), end = start + size * 60000;
        precedingEnd = end + 10 * 60000;
        blocks.push({ id, taskId: task.id, date: slot.date, start: new Date(start).toISOString(), end: new Date(end).toISOString(), minutes: size, title: task.action || task.title, course: task.courseCode, action: task.estimatedMinutes ? steps[i] : steps[0], target: !task.estimatedMinutes ? '记录明确要求及预计耗时；此段不是完成整个任务' : remaining > size ? `推进此项要求，记录已完成部分和下一步；本段不代表完成：${steps[i]}` : `核对这一项已落实：${steps[i]}`, reason: task.dueAt ? `截止 ${new Date(task.dueAt).toLocaleString('zh-CN', { timeZone: timezone })}；按截止顺序安排` : '没有确定截止时间，安排可调整', sourceUrl: task.sourceUrl, evidence: task.evidence, estimated: true, done: false });
        daily.set(slot.date, (daily.get(slot.date) || 0) + size);
        slot.start = end + 10 * 60000; // Ten-minute recovery buffer between study blocks.
        remaining -= size;
      }
      if (missing) { missing += (steps.length-i-1)*minutesPerStep; break; }
    }
    if (missing) warnings.push({ taskId: task.id, title: task.action, reason: `截止前或未来 14 天时段内排不下约 ${missing} 分钟；需要调整，不自动延期` });
    if (!task.estimatedMinutes || !requirements.length) warnings.push({ taskId: task.id, title: task.action, reason: '缺少可靠的耗时或细化要求；先核对原文，不能视为完整项目计划' });
  }
  blocks.sort((a,b) => a.start.localeCompare(b.start));
  return { days, blocks, warnings, prefs, timezone, generatedAt: new Date(now).toISOString() };
}
