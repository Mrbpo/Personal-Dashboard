import type { Metadata } from 'next';
import Link from 'next/link';
import { requireOwnerPage } from '@/lib/authz';
import { kernel } from '@/lib/kernel/service';
import { CandidateControl, TaskStatusControl } from './controls';
import { deadlineLabel, reviewValue, safeSourceUrl } from './format';
import styles from './kernel.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Kernel · Study Cabinet' };

type Evidence = Awaited<ReturnType<typeof kernel.canonicalEvidence>>[number];

function eventWindow() {
  const now = Date.now();
  return [new Date(now - 30 * 86400000).toISOString(), new Date(now + 120 * 86400000).toISOString()] as const;
}

function EvidenceList({ rows }: { rows: Evidence[] }) {
  if (!rows.length) return <p className={styles.muted}>暂无可显示的证据记录。</p>;
  const grouped = Map.groupBy(rows, row => row.attribute);
  return <details className={styles.evidence}>
    <summary>已确认依据 · {rows.length} 条</summary>
    {Array.from(grouped, ([attribute, items]) => <div className={styles.evidenceGroup} key={attribute}>
      <strong>{attribute}</strong>
      <ul>{items.map((item, index) => {
        const url = safeSourceUrl(item.source_url);
        return <li key={`${item.attribute}:${item.locator}:${index}`}>
          <span>{item.source} · {item.authority}</span>
          {item.original_excerpt && <blockquote>{item.original_excerpt}</blockquote>}
          <small>采集：{item.acquired_at}{item.published_at && ` · 发布：${item.published_at}`}{item.locator && ` · 位置：${item.locator}`}</small>
          {url && <> · <a href={url} target="_blank" rel="noopener noreferrer">来源链接</a></>}
        </li>;
      })}</ul>
    </div>)}
  </details>;
}

export default async function KernelPage() {
  const { authorized } = await requireOwnerPage('/kernel');
  if (!authorized) return <main className={styles.kernel}>
    <h1>Kernel</h1><p>请先登录以查看私人资料。</p><Link href="/login">前往登录</Link>
  </main>;

  const [start, end] = eventWindow();
  const [courses, tasks, events, pending] = await Promise.all([
    kernel.listCourses(), kernel.taskRows(undefined, true), kernel.listEvents(start, end), kernel.pendingCandidates(),
  ]);
  const evidence = await kernel.canonicalEvidence(
    courses.map(course => course.id), tasks.map(task => task.id), events.map(event => event.id),
  );
  const forRecord = (kind: string, key: string) => evidence.filter(row =>
    row.entity_kind === kind && (kind === 'task' ? row.task_id === key : row.entity_key === key));

  return <main className={styles.kernel}>
    <header className={styles.header}>
      <h1>Kernel</h1>
      <p>已确认资料与待核实候选分开显示</p>
    </header>

    <section aria-labelledby="courses-heading">
      <h2 id="courses-heading">课程 <span>{courses.length}</span></h2>
      {courses.length === 0 ? <p className={styles.empty}>暂无课程。</p> :
        <ul className={styles.records}>{courses.map(course => <li key={course.id}>
          <h3>{course.code} · {course.name}</h3>
          <p>{course.enabled ? '启用' : '停用'}{course.term_name && ` · ${course.term_name}`}</p>
          <EvidenceList rows={forRecord('course', course.id)} />
        </li>)}</ul>}
    </section>

    <section aria-labelledby="tasks-heading">
      <h2 id="tasks-heading">任务 <span>{tasks.length}</span></h2>
      <p className={styles.muted}>显示启用课程中的所有任务，包括已忽略任务。状态仅保存在本地。</p>
      {tasks.length === 0 ? <p className={styles.empty}>暂无任务。</p> :
        <ul className={styles.records}>{tasks.map(task => <li key={task.id}>
          <h3>{task.title}</h3>
          <p>{task.course_code} · {task.local_status} · 截止：{deadlineLabel(task)}</p>
          {task.source_missing && <p>来源已缺失</p>}
          {task.cancelled_at && <p>已取消</p>}
          <TaskStatusControl taskId={task.id} current={task.local_status} />
          <EvidenceList rows={forRecord('task', task.id)} />
        </li>)}</ul>}
    </section>

    <section aria-labelledby="events-heading">
      <h2 id="events-heading">事件 <span>{events.length}</span></h2>
      <p className={styles.muted}>显示过去 30 天至未来 120 天内的事件。</p>
      {events.length === 0 ? <p className={styles.empty}>此时间范围内暂无事件。</p> :
        <ul className={styles.records}>{events.map(event => <li key={event.id}>
          <h3>{event.title}</h3>
          <p>{event.sourceName} · {event.allDay ? `${event.startAt.slice(0, 10)}（全天）` : `${event.startAt} 至 ${event.endAt}`}</p>
          {event.description && <p>{event.description}</p>}
          <EvidenceList rows={forRecord('event', event.id)} />
        </li>)}</ul>}
    </section>

    <section aria-labelledby="pending-heading">
      <h2 id="pending-heading">待核实事实 <span>{pending.length}</span></h2>
      <p className={styles.muted}>下列内容尚未成为已确认事实。最多显示最早的 100 条。</p>
      {pending.length === 0 ? <p className={styles.empty}>暂无待核实事实。</p> :
        <ul className={styles.records}>{pending.map(item => {
          const deadline = item.value as { precision?: string; date?: string; at?: string } | null;
          const unlinked = item.entity_kind !== 'task' && ['due', 'cancelled'].includes(item.attribute);
          const ambiguous = item.attribute === 'due' && (!deadline?.precision ||
            (deadline.precision === 'date' ? !deadline.date : !deadline.at));
          const canAccept = !unlinked && !ambiguous;
          return <li key={item.id}>
          <h3>待核实 · {item.course_code || item.entity_kind} · {item.attribute}</h3>
          <p>候选值：<span className={styles.value}>{reviewValue(item.attribute, item.value)}</span></p>
          <p>当前已确认值：<span className={styles.value}>{reviewValue(item.attribute, item.canonical_value)}</span></p>
          <p>来源：{item.source} · {item.authority}</p>
          {item.original_excerpt && <blockquote>{item.original_excerpt}</blockquote>}
          <CandidateControl candidateId={item.id} canAccept={canAccept}
            explanation={unlinked ? '需先关联任务才能接受；可以拒绝。' : ambiguous ? '截止日期不明确，不能接受；可以拒绝。' : undefined} />
        </li>; })}</ul>}
    </section>
  </main>;
}
