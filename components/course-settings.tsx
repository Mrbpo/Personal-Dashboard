"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";

type Course = { id: string; code: string; name: string; enabled: boolean };

export function CourseSettings({ initial }: { initial: Course[] }) {
  const [courses, setCourses] = useState(initial);

  async function toggle(course: Course, enabled: boolean) {
    setCourses((items) => items.map((item) => item.id === course.id ? { ...item, enabled } : item));
    const response = await fetch("/api/courses/" + encodeURIComponent(course.id), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) setCourses((items) => items.map((item) => item.id === course.id ? course : item));
  }

  if (!courses.length) return <p className="text-sm text-muted-foreground">首次同步后，可在这里选择要纳入每日计划的课程。</p>;
  return (
    <div className="space-y-3">
      {courses.map((course) => (
        <label key={course.id} className="flex items-center gap-4 rounded-2xl border bg-background p-4">
          <span className="min-w-0 flex-1"><b className="block text-sm">{course.code}</b><span className="block truncate text-xs text-muted-foreground">{course.name}</span></span>
          <Switch checked={course.enabled} onCheckedChange={(enabled) => void toggle(course, enabled)} aria-label={`启用 ${course.code}`} />
        </label>
      ))}
    </div>
  );
}
