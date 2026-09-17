"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addDays, addMonths, endOfMonth, format, startOfMonth, subMonths } from "date-fns";
import { CalendarRange, ChevronLeft, ChevronRight, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LearningTask } from "@/lib/domain";
import { conciseTaskAction } from "@/lib/task-presentation";

type ScheduleEvent = {
  id: string;
  title: string;
  description: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  sourceName: string;
};

type CalendarItem = {
  id: string;
  title: string;
  detailTitle?: string;
  startKey: string;
  endKey: string;
  course?: string;
  href?: string | null;
  kind: "task" | "schedule";
  urgency?: LearningTask["urgency"];
};

const weekdayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

function dateKey(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function zonedDateKey(value: string, timezone: string) {
  return new Date(value).toLocaleDateString("en-CA", { timeZone: timezone });
}

function calendarStart(month: Date) {
  const first = startOfMonth(month);
  const mondayOffset = (first.getDay() + 6) % 7;
  return addDays(first, -mondayOffset);
}

function laneItems(items: CalendarItem[], weekStart: Date) {
  const keys = Array.from({ length: 7 }, (_, index) => dateKey(addDays(weekStart, index)));
  const weekEnd = keys[6];
  const segments = items
    .filter((item) => item.endKey >= keys[0] && item.startKey <= weekEnd)
    .map((item) => ({
      ...item,
      start: Math.max(0, keys.indexOf(item.startKey) < 0 ? (item.startKey < keys[0] ? 0 : 6) : keys.indexOf(item.startKey)),
      end: Math.max(0, keys.indexOf(item.endKey) < 0 ? (item.endKey > weekEnd ? 6 : 0) : keys.indexOf(item.endKey)),
      beginsHere: item.startKey >= keys[0],
      endsHere: item.endKey <= weekEnd,
    }))
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const laneEnds: number[] = [];
  return segments.map((segment) => {
    let lane = laneEnds.findIndex((end) => end < segment.start);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = segment.end;
    return { ...segment, lane, laneCount: laneEnds.length };
  });
}

function itemStyle(item: CalendarItem) {
  if (item.kind === "schedule") return { backgroundColor: "#254d48", color: "#fffaf0" };
  const colors = ["#315e53", "#a25544", "#60756e", "#567386", "#a7833d", "#6f6250", "#805b5e"];
  const hash = Array.from(item.course || "课程").reduce((total, char) => total + char.charCodeAt(0), 0);
  const base = colors[hash % colors.length];
  return { backgroundColor: base, color: "#fffaf0", opacity: item.urgency === "review" ? 0.68 : item.urgency === "upcoming" ? 0.82 : 1 };
}

export function StudyCalendar({ tasks, timezone }: { tasks: LearningTask[]; timezone: string }) {
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [schedule, setSchedule] = useState<ScheduleEvent[]>([]);
  const [message, setMessage] = useState("");
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const firstDay = useMemo(() => calendarStart(month), [month]);
  const lastDay = useMemo(() => addDays(firstDay, 41), [firstDay]);

  const loadSchedule = useCallback(async () => {
    const response = await fetch(`/api/calendar?start=${encodeURIComponent(firstDay.toISOString())}&end=${encodeURIComponent(addDays(lastDay, 1).toISOString())}`);
    if (!response.ok) return;
    const result = await response.json();
    setSchedule(result.events || []);
  }, [firstDay, lastDay]);

  useEffect(() => { void loadSchedule(); }, [loadSchedule]);

  const items = useMemo<CalendarItem[]>(() => [
    ...tasks
      .filter((task) => task.dueAt && task.localStatus !== "ignored" && task.canvasStatus !== "possibly_superseded")
      .map((task) => {
        const dueKey = zonedDateKey(task.dueAt!, timezone);
        const suggestedStartKey = task.startAt ? zonedDateKey(task.startAt, timezone) : dueKey;
        const conciseTitle = conciseTaskAction(task);
        return {
          id: `task-${task.id}`,
          title: conciseTitle,
          detailTitle: task.title.trim() !== conciseTitle.trim() ? task.title : undefined,
          startKey: suggestedStartKey <= dueKey ? suggestedStartKey : dueKey,
          endKey: dueKey,
          course: task.courseCode.split(/\s+/)[0],
          href: task.sourceUrl,
          kind: "task" as const,
          urgency: task.urgency,
        };
      })
      // A far-future task may already be unlocked. Show its complete bar in the
      // month where it is due, instead of repeating every future task in today’s month.
      .filter((task) => task.endKey >= dateKey(firstDay) && task.endKey <= dateKey(lastDay)),
    ...schedule.map((event) => ({
      id: `schedule-${event.id}`,
      title: event.title,
      startKey: zonedDateKey(event.startAt, timezone),
      endKey: zonedDateKey(event.endAt || event.startAt, timezone),
      course: "日程",
      kind: "schedule" as const,
    })),
  ], [firstDay, lastDay, schedule, tasks, timezone]);

  const weeks = useMemo(() => Array.from({ length: 6 }, (_, week) => addDays(firstDay, week * 7)), [firstDay]);
  const mobileItems = useMemo(() => items
    .filter((item) => item.endKey >= dateKey(startOfMonth(month)) && item.endKey <= dateKey(endOfMonth(month)))
    .sort((a, b) => a.endKey.localeCompare(b.endKey) || a.startKey.localeCompare(b.startKey)), [items, month]);
  const todayKey = zonedDateKey(new Date().toISOString(), timezone);

  async function importSchedule(file: File) {
    setUploading(true);
    setMessage("正在导入日程…");
    const form = new FormData();
    form.append("file", file);
    try {
      const response = await fetch("/api/schedule/import", { method: "POST", body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "日程导入失败");
      setMessage(`已从 ${result.sourceName} 导入 ${result.imported} 项日程`);
      await loadSchedule();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "日程导入失败");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <section className="parchment-panel mb-5 overflow-hidden" aria-labelledby="calendar-title">
      <div className="calendar-header relative flex flex-col gap-4 border-b border-[#aa9b79] p-4 sm:flex-row sm:items-center sm:justify-between md:p-5">
        <div className="flex items-center gap-3">
          <span className="grid size-9 place-items-center border border-[#9f8752] bg-[#315e53] text-[#fff8e8]"><CalendarRange className="size-4" /></span>
          <div><p className="section-kicker">LEARNING TIMELINE</p><h2 id="calendar-title" className="text-xl font-semibold">{format(month, "yyyy 年 M 月")}</h2></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center border bg-[#f8f3e7] p-1">
            <Button variant="ghost" size="icon-sm" aria-label="上个月" onClick={() => setMonth((value) => subMonths(value, 1))}><ChevronLeft /></Button>
            <Button variant="ghost" size="sm" onClick={() => setMonth(startOfMonth(new Date()))}>今天</Button>
            <Button variant="ghost" size="icon-sm" aria-label="下个月" onClick={() => setMonth((value) => addMonths(value, 1))}><ChevronRight /></Button>
          </div>
          <input ref={inputRef} className="sr-only" type="file" accept=".ics,.csv,text/calendar,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void importSchedule(file); }} />
          <Button variant="outline" size="sm" className="bg-[#f8f3e7]" disabled={uploading} onClick={() => inputRef.current?.click()}><Upload />{uploading ? "导入中" : "导入日程"}</Button>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-b px-5 py-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between md:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="inline-flex items-center gap-1.5"><i className="size-2.5 bg-[#315e53]" />色相区分课程</span>
          <span className="inline-flex items-center gap-1.5"><i className="size-2.5 bg-[#254d48]" />导入日程</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-1.5 w-8 bg-[#a7833d]" />明暗表示紧迫度 · 横条为建议开始至截止</span>
        </div>
        <p aria-live="polite">{message || "支持 Canvas / Google / Outlook 导出的 .ics，以及 .csv"}</p>
      </div>

      <div className="divide-y md:hidden">
        {mobileItems.map((item) => {
          const color = itemStyle(item);
          const dateText = item.startKey === item.endKey ? `${item.endKey.slice(5).replace("-", "月")}日截止` : `${item.startKey.slice(5).replace("-", "月")}日 → ${item.endKey.slice(5).replace("-", "月")}日`;
          const body = (
            <div className="flex min-w-0 flex-1 items-start gap-3 py-4 pr-4">
              <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-xl text-xs font-bold text-white shadow-sm" style={color}>{item.endKey.slice(8)}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span className="font-semibold" style={{ color: color.backgroundColor }}>{item.course}</span><span>{dateText}</span></div>
                <p className="mt-1.5 break-words text-sm font-semibold leading-5 text-foreground">{item.title}</p>
                {item.detailTitle && <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">Canvas：{item.detailTitle}</p>}
                {item.startKey !== item.endKey && <div className="mt-2 h-1.5 w-full rounded-full opacity-70" style={{ backgroundColor: color.backgroundColor }} />}
              </div>
            </div>
          );
          return item.href ? <a key={`mobile-${item.id}`} href={item.href} target="_blank" rel="noreferrer" className="flex border-l-4 pl-4 transition hover:bg-muted/40" style={{ borderColor: color.backgroundColor }}>{body}</a> : <div key={`mobile-${item.id}`} className="flex border-l-4 pl-4" style={{ borderColor: color.backgroundColor }}>{body}</div>;
        })}
        {mobileItems.length === 0 && <p className="px-5 py-10 text-center text-sm text-muted-foreground">这个月还没有截止任务或导入日程。</p>}
      </div>

      <div className="hidden w-full overflow-hidden pb-2 md:block">
        <div className="w-full min-w-0">
          <div className="grid grid-cols-7 border-b bg-[#e7dfcf] text-center text-xs font-semibold text-muted-foreground">
            {weekdayNames.map((day, index) => <div key={day} className={`py-3 ${index > 4 ? "text-[#8a6640]" : ""}`}>{day}</div>)}
          </div>
          {weeks.map((weekStart) => {
            const segments = laneItems(items, weekStart);
            const lanes = segments.reduce((max, item) => Math.max(max, item.lane + 1), 0);
            const height = Math.max(106, 42 + lanes * 27 + 10);
            return (
              <div key={dateKey(weekStart)} className="relative border-b last:border-b-0" style={{ height }}>
                <div className="absolute inset-0 grid grid-cols-7">
                  {Array.from({ length: 7 }, (_, index) => {
                    const day = addDays(weekStart, index);
                    const key = dateKey(day);
                    const inMonth = day >= startOfMonth(month) && day <= endOfMonth(month);
                    return <div key={key} className={`min-w-0 border-r px-1 py-2 last:border-r-0 sm:px-2 sm:py-2.5 ${inMonth ? "bg-[#f8f4e9]" : "bg-[#e9e3d5]"}`}><span className={`inline-grid size-6 place-items-center text-[11px] font-semibold sm:size-7 sm:text-xs ${key === todayKey ? "border border-[#bea665] bg-primary text-white" : inMonth ? "text-foreground" : "text-muted-foreground/45"}`}>{day.getDate()}</span></div>;
                  })}
                </div>
                {segments.map((item) => {
                  const style = { left: `calc(${item.start} * 14.285714% + 4px)`, width: `calc(${item.end - item.start + 1} * 14.285714% - 8px)`, top: 41 + item.lane * 27 };
                  const className = `absolute z-10 flex h-[22px] min-w-0 items-center gap-1 overflow-hidden px-1.5 text-[9px] font-semibold leading-none shadow-[0_4px_12px_rgba(30,42,70,.14)] transition hover:z-20 hover:brightness-95 sm:gap-1.5 sm:px-2 sm:text-[11px] ${item.beginsHere ? "rounded-l-md" : "rounded-l-none"} ${item.endsHere ? "rounded-r-md" : "rounded-r-none"}`;
                  const barStyle = { ...style, ...itemStyle(item) };
                  const content = <><span className="hidden shrink-0 opacity-80 sm:inline">{item.course}</span><span className="min-w-0 truncate">{item.title}</span></>;
                  return item.href ? <a key={`${item.id}-${dateKey(weekStart)}`} href={item.href} target="_blank" rel="noreferrer" className={className} style={barStyle} title={`${item.course} · ${item.title}\n${item.startKey} → ${item.endKey}`}>{content}</a> : <div key={`${item.id}-${dateKey(weekStart)}`} className={className} style={barStyle} title={`${item.title}\n${item.startKey} → ${item.endKey}`}>{content}</div>;
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
