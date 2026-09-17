import { serviceValue } from "./service-vault.ts";
import { aiResponse, hasAI } from './ai-response.ts';
import type { CanvasSource, ExtractedAnalysis } from "./domain.ts";
import { downloadCanvasFile } from "./canvas.ts";

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string" },
          action: { type: "string" },
          requirements: { type: "array", items: { type: "string" } },
          recommendedStartAt: { type: ["string", "null"] },
          inferredDueAt: { type: ["string", "null"] },
          confidence: { type: "string", enum: ["certain", "inferred"] },
          evidence: { type: "string" },
          estimatedMinutes: { type: ["integer", "null"] },
          possiblyCancelled: { type: "boolean" },
        },
        required: ["title", "action", "requirements", "recommendedStartAt", "inferredDueAt", "confidence", "evidence", "estimatedMinutes", "possiblyCancelled"],
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "actions", "notes"],
} as const;

function apiConfig() {
  if (!serviceValue("OPENAI_API_KEY")) return null;
  return { key: serviceValue("OPENAI_API_KEY"), model: serviceValue("OPENAI_MODEL") || "gpt-5-mini" };
}

function extractOutputText(payload: any): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("OPENAI_EMPTY_OUTPUT");
}

async function requestAnalysis(content: Array<Record<string, unknown>>): Promise<ExtractedAnalysis> {
  const config = apiConfig();
  if (!hasAI()) throw new Error("OPENAI_NOT_CONFIGURED");
  const response = await aiResponse("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config?.model || serviceValue('OPENAI_MODEL') || 'gpt-5-mini',
      store: false,
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: "你是学生的课程信息分析器。只根据所给原文提取学生需要采取的行动、要求、注意事项、日期变化和取消信息。不要猜测截止日期。输出简明中文；action 必须以动词开头并在 22 个汉字以内，直接说明学生要做什么；requirements 每项只保留一个要求；evidence 必须是原文中的短证据；不构成行动的内容放入 notes。recommendedStartAt 是建议学生真正开始做该任务的 ISO 8601 时间，绝对不能直接复制 Canvas 开放入口时间。只要任务尚未完成且有截止时间，就必须根据 estimatedMinutes、任务类型、复杂度和依赖关系给出一个建议开始时间；资料少时也要使用保守默认值（小测提前 1–2 天、普通作业提前 3–5 天、大型项目提前 1–3 周）。建议时间不得早于当前时间或 Canvas 开放时间，也不得晚于截止时间。没有截止日期或已经完成时才填 null。",
          },
          ...content,
        ],
      }],
      text: { format: { type: "json_schema", name: "course_action_analysis", strict: true, schema: analysisSchema } },
      max_output_tokens: 1800,
    }),
  });
  if (!response.ok) throw new Error("OPENAI_REQUEST_FAILED_" + response.status);
  return JSON.parse(extractOutputText(await response.json())) as ExtractedAnalysis;
}

export function hasOpenAI() {
  return hasAI();
}

export async function analyzeSource(source: CanvasSource): Promise<ExtractedAnalysis> {
  const text = [
    "类型：" + source.sourceType,
    "标题：" + source.title,
    source.dueAt ? "Canvas 截止时间：" + source.dueAt : "",
    source.unlockAt ? "Canvas 开放入口（不是建议开始时间）：" + source.unlockAt : "",
    source.lockAt ? "Canvas 锁定时间：" + source.lockAt : "",
    source.submissionState ? "Canvas 提交状态：" + source.submissionState : "",
    source.pointsPossible != null ? "分值：" + source.pointsPossible : "",
    "当前时间：" + new Date().toISOString(),
    "原文：\n" + source.body.slice(0, 50000),
  ].filter(Boolean).join("\n");
  return requestAnalysis([{ type: "input_text", text }]);
}

export async function analyzeSourceFile(source: CanvasSource): Promise<ExtractedAnalysis> {
  const config = apiConfig();
  if (!config || !source.file?.url) throw new Error("FILE_ANALYSIS_UNAVAILABLE");
  if (source.file.size > 8 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");
  const supported = /\.(pdf|docx?|pptx?|txt|md|csv|rtf)$/i.test(source.file.name) || /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument|vnd\.ms-powerpoint)|text\/)/i.test(source.file.contentType);
  if (!supported) throw new Error("FILE_ANALYSIS_UNAVAILABLE");
  const fileResponse = await downloadCanvasFile(source.file.url);
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append("file", new Blob([await fileResponse.arrayBuffer()], { type: source.file.contentType }), source.file.name);
  const uploaded = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.key },
    body: form,
  });
  if (!uploaded.ok) throw new Error("OPENAI_FILE_UPLOAD_FAILED_" + uploaded.status);
  const file = await uploaded.json() as { id: string };
  try {
    return await requestAnalysis([
      { type: "input_text", text: ["课程文件：" + source.file.name, source.dueAt ? "Canvas 截止时间：" + source.dueAt : "", source.unlockAt ? "Canvas 开放入口（不是建议开始时间）：" + source.unlockAt : "", source.submissionState ? "Canvas 提交状态：" + source.submissionState : "", "当前时间：" + new Date().toISOString()].filter(Boolean).join("\n") },
      { type: "input_file", file_id: file.id },
    ]);
  } finally {
    await fetch("https://api.openai.com/v1/files/" + file.id, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + config.key },
    }).catch(() => undefined);
  }
}
