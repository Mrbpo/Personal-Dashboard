'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { dueWindow, formatTaskDeadline, taskDeadline } from '@/lib/due-window';
import { conciseTaskAction, conciseRequirement } from '@/lib/task-presentation';
import { presentCourse } from '@/lib/course-presentation';
import { safeSourceHref } from '@/lib/uiv2/sections';
import type { LearningTask } from '@/lib/domain';
import type { dashboardData } from '@/lib/repository';
import styles from './console.module.css';

type Dashboard = Awaited<ReturnType<typeof dashboardData>>;
export function ConsoleDashboard({ timezone, mode = 'overview' }: { timezone: string; mode?: 'overview' | 'tasks' | 'courses' }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const date = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
      const response = await fetch('/api/dashboard?date=' + date, { cache: 'no-store' });
      if (!response.ok) throw new Error('课程数据库暂不可用，请稍后重试。');
      setData(await response.json()); setError('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败'); }
    finally { setLoading(false); }
  }, [timezone]);
  useEffect(() => { void load(); }, [load]);
  async function complete(task: LearningTask) {
    if (busy) return;
    setBusy(task.id); setMessage('');
    try {
      const response = await fetch('/api/tasks/' + encodeURIComponent(task.id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', syncCanvas: true }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '完成失败，本站未作更改');
      setMessage(result.canvas?.supported ? '已同步完成 Canvas To-do' : '这类内容没有 Canvas To-do 勾选项，已仅在本站标记');
      await load();
    } catch (reason) { setMessage(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(''); }
  }
  const now = data ? Date.parse(data.asOf) : 0;
  const tasks = dueWindow(data?.tasks || [], timezone, now);
  const overdue = tasks.filter(task => taskDeadline(task, timezone, now)?.overdue);
  return <div className={styles.dashboard}>
    <div className={styles.toolbar}><span>{timezone} · {data ? `数据时点 ${new Date(data.asOf).toLocaleString('zh-CN', { timeZone: timezone })}` : '等待读取真实数据'}</span><button disabled={loading} onClick={() => void load()}>{loading ? '读取中…' : '刷新数据'}</button></div>
    {error && <p role="alert" className={styles.notice}>{error}{data && ' 以下保留上次成功读取的记录。'}</p>}
    {message && <p role="status" className={styles.notice}>{message}</p>}
    {data && <>
      {mode === 'overview' && <dl className={styles.metrics}><div><dt>窗口内未完成</dt><dd>{tasks.length}<small>项</small></dd></div><div><dt>最近一周逾期</dt><dd>{overdue.length}<small>项</small></dd></div><div><dt>已启用课程</dt><dd>{data.courses.length}<small>门</small></dd></div><div><dt>最近同步</dt><dd className={styles.syncValue}>{data.lastSync?.status || '尚未同步'}<small>{data.lastSync ? new Date(data.lastSync.finishedAt || data.lastSync.startedAt).toLocaleString('zh-CN', { timeZone: timezone }) : '可前往经典总览开始同步'}</small></dd></div></dl>}
      <div className={mode === 'overview' ? styles.monitorGrid : undefined}>
        {mode !== 'courses' && <section className={styles.panel}><div className={styles.panelHeading}><h2>截止任务</h2><span>{tasks.length} 项</span></div><p className={styles.caption}>未来 16 天 · 最近一周逾期 · 按截止时间排序</p>
          {!tasks.length && <p className={styles.empty}>此时间窗口内没有未完成事项。</p>}
          <ul className={styles.taskList}>{tasks.map(task => <li key={task.id}>
            <div className={styles.taskMeta}><Link href={'/courses/' + encodeURIComponent(task.courseId)} title="在经典界面查看课程">{task.courseCode} ↗</Link><time>{formatTaskDeadline(task, timezone)}</time></div>
            <h3>{conciseTaskAction(task)}</h3><p>{conciseRequirement(task)}</p>
            <div className={styles.taskActions}><span className={taskDeadline(task, timezone, now)?.overdue ? styles.danger : styles.muted}>{task.prerequisiteBlocked ? '受先修条件限制' : task.canvasStatus === 'locked' ? '已锁定' : task.canvasStatus === 'not_open' ? '尚未开放' : taskDeadline(task, timezone, now)?.overdue ? '已逾期' : '待完成'}</span><button disabled={!!busy} onClick={() => void complete(task)}>{busy === task.id ? '保存中…' : '标记完成'}</button></div>
            <details><summary>要求与来源依据</summary><div className={styles.evidence}><p>原始项目：{task.title}</p><ul>{task.requirements.map((requirement, index) => <li key={index}>{requirement}</li>)}</ul><p>{task.evidence || '暂无额外依据'}</p>{safeSourceHref(task.sourceUrl) && <a href={safeSourceHref(task.sourceUrl)} target="_blank" rel="noreferrer">打开来源原文 ↗</a>}</div></details>
          </li>)}</ul>
        </section>}
        {mode !== 'tasks' && <div className={styles.rail}><section className={styles.panel}><div className={styles.panelHeading}><h2>课程目录</h2><span>{data.courses.length} 门</span></div><p className={styles.caption}>详情与资料在经典界面打开 ↗</p><ul className={styles.courseList}>{data.courses.map(course => <li key={course.id}><Link href={'/courses/' + encodeURIComponent(course.id)}><strong>{presentCourse(course.code, course.name).displayCode}</strong><span>{presentCourse(course.code, course.name).courseTitle}</span><small>{tasks.filter(task => task.courseId === course.id).length} 项窗口内任务 ↗</small></Link></li>)}</ul>{!data.courses.length && <p className={styles.empty}>暂无启用课程。请在设置中选择课程，或前往经典总览同步。</p>}</section>
          {mode === 'overview' && <section className={styles.panel}><div className={styles.panelHeading}><h2>最近变更</h2><Link href="/changes">全部 ↗</Link></div><ul className={styles.courseList}>{data.changes.map(change => <li key={String(change.id)}><strong>{change.courseCode}</strong><p>{change.title}</p><small>{({ dates_updated: '截止时间调整', source_missing: '来源已移除', restored: '来源已恢复', attachment_updated: '附件更新', prerequisite_updated: '先修条件更新' } as Record<string, string>)[String(change.type)] || String(change.type)}</small></li>)}</ul>{!data.changes.length && <p className={styles.empty}>暂无影响课程安排的新变更。</p>}</section>}
        </div>}
      </div>
    </>}
  </div>;
}
