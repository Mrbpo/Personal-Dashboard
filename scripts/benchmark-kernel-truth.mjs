import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (!process.env.KERNEL_DATABASE_URL) throw new Error('Set KERNEL_DATABASE_URL to an isolated PostgreSQL database');
const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
process.env.DATABASE_URL ||= `file:${resolve(root, 'truth.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
const { kernel } = await import('../lib/kernel/service.ts');
const { askKernel } = await import('../lib/kernel/ask.ts');
const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const cases = [];
const seed = !(await kernel.getCourse('kqa-course-1'));

for (let courseNo = 1; courseNo <= 5; courseNo++) {
  const courseId = `kqa-course-${courseNo}`, code = `KQA10${courseNo}`, name = `Benchmark Course ${courseNo}`;
  if (seed) await kernel.upsertCourse({ id: courseId, course_code: code, name, enabled: true }, 'canvas');
  cases.push({ kind: 'course', question: `${code} 是什么课程？`, courseId, expected: name });
  for (let taskNo = 1; taskNo <= 5; taskNo++) {
    const index = (courseNo - 1) * 5 + taskNo, taskId = `${courseId}:assignment:${taskNo}`;
    const title = `${code} Assignment ${String(taskNo).padStart(2, '0')}`;
    const date = `2026-10-${String(index).padStart(2, '0')}`;
    const dueAt = index % 2 ? date : `${date}T14:30:00Z`;
    const item = { id: taskId, courseId, sourceType: 'assignment', sourceId: String(taskNo), title,
      body: `Original assignment ${taskNo} for ${code}.`, sourceUrl: `https://example.org/${code}/${taskNo}`,
      updatedAt: '2026-09-28T00:00:00Z', dueAt, unlockAt: null, lockAt: null };
    if (seed) await kernel.ingestCanvasSource(item, null, checksum(item));
    cases.push({ kind: 'due', question: `${title} 的截止日期是什么？`, courseId, expected: date, taskId: `${taskId}:0` });
    if (taskNo <= 2) {
      if (seed) await kernel.setTaskStatus(`${taskId}:0`, 'completed');
      cases.push({ kind: 'status', question: `${title} 当前状态是什么？`, courseId, expected: 'completed', taskId: `${taskId}:0` });
    }
  }
}
for (let eventNo = 1; eventNo <= 10; eventNo++) {
  const date = `2026-11-${String(eventNo).padStart(2, '0')}`;
  const title = `Research Seminar ${String(eventNo).padStart(2, '0')}`;
  if (seed) await kernel.ingestEvent('benchmark', { uid: `seminar-${eventNo}`, title, description: `Seminar number ${eventNo}`,
    startAt: `${date}T13:00:00Z`, endAt: `${date}T14:00:00Z`, allDay: false });
  cases.push({ kind: 'event', question: `日程 ${title} 什么时候开始？`, courseId: '', expected: `${date}T13:00:00`, eventId: `event:benchmark:seminar-${eventNo}` });
}
if (cases.length !== 50) throw new Error(`Expected 50 cases, got ${cases.length}`);
const results = [];
for (const item of cases) {
  const response = await askKernel('benchmark-owner', item.question, item.courseId);
  const expectedId = item.taskId || item.eventId || item.courseId;
  const correct = response.answer.includes(item.expected) && response.citations.some(citation => citation.sourceId === expectedId);
  results.push({ ...item, correct, answer: response.answer, citations: response.citations.map(citation => citation.sourceId) });
}
await mkdir(root, { recursive: true });
await writeFile(resolve(root, 'truth-results.json'), JSON.stringify({ cases: results }, null, 2));
console.log(JSON.stringify({ queries: results.length, correct: results.filter(item => item.correct).length,
  byKind: Object.fromEntries([...new Set(results.map(item => item.kind))].map(kind => [kind, `${results.filter(item => item.kind === kind && item.correct).length}/${results.filter(item => item.kind === kind).length}`])) }));
