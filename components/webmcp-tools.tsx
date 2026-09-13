"use client";

import { useEffect } from "react";

type ModelContext = {
  registerTool(tool: Record<string, unknown>, options?: { signal?: AbortSignal }): void | Promise<void>;
};

function todayToronto() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
}

async function jsonOrThrow(response: Response) {
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || "请求失败");
  return value;
}

export function WebMcpTools() {
  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();

    const register = (tool: Record<string, unknown>) => {
      void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined);
    };

    register({
      name: "get_today_plan",
      title: "读取今日学习计划",
      description: "读取网站中今天的跨课程学习任务、紧急事项和需要确认的内容。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => jsonOrThrow(await fetch("/api/dashboard?date=" + todayToronto())),
    });

    register({
      name: "get_course_summary",
      title: "读取课程摘要",
      description: "按 Canvas 课程 ID 或课程代码读取课程摘要、任务、风险和来源。",
      inputSchema: {
        type: "object",
        properties: { courseId: { type: "string", description: "Canvas 课程 ID 或课程代码" } },
        required: ["courseId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input: unknown) => {
        const courseId = (input as { courseId?: string })?.courseId?.trim();
        if (!courseId) throw new Error("courseId 必填");
        return jsonOrThrow(await fetch("/api/courses/" + encodeURIComponent(courseId)));
      },
    });

    register({
      name: "sync_canvas",
      title: "同步 Canvas",
      description: "从 Quercus 读取所有当前课程并逐门分析，然后更新今日计划。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async () => {
        const start = await jsonOrThrow(await fetch("/api/sync", { method: "POST" }));
        const results = [];
        for (const course of start.courses) {
          const response = await fetch("/api/sync/courses/" + course.id + "?runId=" + start.runId, { method: "POST" });
          results.push(await response.json());
        }
        await jsonOrThrow(await fetch("/api/plans/" + todayToronto() + "/generate", { method: "POST" }));
        window.dispatchEvent(new Event("canvas-sync-complete"));
        return { runId: start.runId, courses: results };
      },
    });

    return () => lifecycle.abort();
  }, []);

  return null;
}
