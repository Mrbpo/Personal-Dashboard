'use client';

import { CalendarClock, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Task = {
  id: string;
  courseCode: string;
  title: string;
  action: string;
  dueAt: string | null;
  sourceUrl: string | null;
  localStatus: string;
  canvasStatus: string;
  prerequisiteBlocked: boolean;
};

export function DueDayList({ tasks, timezone }: { tasks: Task[]; timezone: string }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });
  const rows = tasks
    .filter((task) => task.dueAt && task.localStatus === 'active' && task.canvasStatus !== 'completed')
    .sort((a, b) => Date.parse(a.dueAt!) - Date.parse(b.dueAt!));
  const groups = new Map<string, Task[]>();
  for (const task of rows) {
    const day = new Date(task.dueAt!).toLocaleDateString('en-CA', { timeZone: timezone });
    groups.set(day, [...(groups.get(day) || []), task]);
  }
  const dates = [...groups.keys()];
  const dayLabel = (date: string) => {
    const offset = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
    if (offset === 0) return '今天';
    if (offset === 1) return '明天';
    if (offset < 0) return `已逾期 ${Math.abs(offset)} 天`;
    return new Date(`${date}T12:00:00Z`).toLocaleDateString('zh-CN', { timeZone: 'UTC', month: 'long', day: 'numeric', weekday: 'short' });
  };

  return (
    <section className="parchment-panel min-w-0 p-4 md:p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><CalendarClock className="size-5" /></span>
        <div>
          <p className="section-kicker">DUE DAYS</p>
          <h2 className="text-2xl font-semibold">截止日期</h2>
          <p className="mt-1 text-sm text-muted-foreground">只列有明确截止时间的事项，不自动安排学习时段。</p>
        </div>
      </div>
      {!dates.length ? (
        <p className="mt-5 rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">目前没有确定的截止事项。</p>
      ) : (
        <div className="mt-5 space-y-4">
          {dates.map((date) => (
            <div key={date} className="overflow-hidden rounded-xl border bg-background/80">
              <div className="flex items-center justify-between border-b bg-muted/45 px-4 py-2.5">
                <h3 className="font-semibold">{dayLabel(date)}</h3>
                <span className="text-xs text-muted-foreground">{date} · {groups.get(date)!.length} 项</span>
              </div>
              <div className="divide-y">
                {groups.get(date)!.map((task) => {
                  const overdue = date < today;
                  return (
                    <article key={task.id} className="flex min-w-0 items-start gap-3 p-4">
                      <Badge variant={overdue ? 'destructive' : 'secondary'} className="shrink-0">{task.courseCode}</Badge>
                      <div className="min-w-0 flex-1">
                        <h4 className="font-medium">{task.title}</h4>
                        <p className="mt-1 text-sm text-muted-foreground">{task.action}</p>
                        <p className={`mt-1 text-xs font-medium ${overdue ? 'text-destructive' : 'text-primary'}`}>
                          {new Date(task.dueAt!).toLocaleString('zh-CN', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          {task.prerequisiteBlocked ? ' · 当前受先修条件限制' : ''}
                        </p>
                      </div>
                      {task.sourceUrl && <a href={task.sourceUrl} target="_blank" rel="noreferrer" aria-label={`打开 ${task.title}`} className="shrink-0 text-muted-foreground hover:text-primary"><ExternalLink className="size-4" /></a>}
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
