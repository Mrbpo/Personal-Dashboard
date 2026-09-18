"use client";

import { useEffect } from "react";

type ModelContext = {
  registerTool(tool: Record<string, unknown>, options?: { signal?: AbortSignal }): void | Promise<void>;
};

async function todayForSettings() {
  const settings = await jsonOrThrow(await fetch("/api/settings"));
  return new Date().toLocaleDateString("en-CA", { timeZone: settings.timezone || "America/Toronto" });
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
      execute: async () => jsonOrThrow(await fetch("/api/dashboard?date=" + await todayForSettings())),
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
        await jsonOrThrow(await fetch("/api/plans/" + await todayForSettings() + "/generate", { method: "POST" }));
        window.dispatchEvent(new Event("canvas-sync-complete"));
        return { runId: start.runId, courses: results };
      },
    });

    register({
      name: "search_course_library",
      title: "搜索课程资料库",
      description: "搜索已经归档的 Canvas、Piazza、邮件和上传资料，返回文件名、课程与页码引用。提供 courseId 可严格限制课程。",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, courseId: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async (input: unknown) => {
        const value=input as {query?:string;courseId?:string};
        if(!value.query?.trim())throw new Error("query 必填");
        return jsonOrThrow(await fetch("/api/v1/library/search?"+new URLSearchParams({q:value.query,...(value.courseId?{courseId:value.courseId}:{})})));
      },
    });

    register({
      name: "ask_course_tutor",
      title: "询问课程学习助手",
      description: "基于归档课程资料提问并返回带引用的回答。首次可给 courseId；未给时会自动识别，但不会混用不同课程。threadId 用于连续追问。",
      inputSchema: {
        type: "object",
        properties: { question: { type: "string" }, courseId: { type: "string" }, threadId: { type: "string" }, online: { type: "boolean" } },
        required: ["question"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: async (input: unknown) => jsonOrThrow(await fetch("/api/v1/study",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)})),
    });

    return () => lifecycle.abort();
  }, []);

  return null;
}
