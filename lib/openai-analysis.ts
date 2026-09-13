import { env } from "cloudflare:workers";
import type { CanvasSource, ExtractedAnalysis } from "./domain";
import { downloadCanvasFile } from "./canvas";

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
          inferredDueAt: { type: ["string", "null"] },
          confidence: { type: "string", enum: ["certain", "inferred"] },
          evidence: { type: "string" },
          estimatedMinutes: { type: ["integer", "null"] },
          possiblyCancelled: { type: "boolean" },
        },
        required: ["title", "action", "requirements", "inferredDueAt", "confidence", "evidence", "estimatedMinutes", "possiblyCancelled"],
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "actions", "notes"],
} as const;

function apiConfig() {
  if (!env.OPENAI_API_KEY) return null;
  return { key: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || "gpt-5-mini" };
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
  if (!config) throw new Error("OPENAI_NOT_CONFIGURED");
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + config.key, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      store: false,
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: "你是学生的课程信息分析器。只根据所给原文提取学生需要采取的行动、要求、注意事项、日期变化和取消信息。不要猜测没有证据的日期。输出中文，evidence 必须是原文中的短证据；不构成行动的内容放入 notes。",
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
  return Boolean(apiConfig());
}

export async function analyzeSource(source: CanvasSource): Promise<ExtractedAnalysis> {
  const text = [
    "类型：" + source.sourceType,
    "标题：" + source.title,
    source.dueAt ? "Canvas 截止时间：" + source.dueAt : "",
    source.lockAt ? "Canvas 锁定时间：" + source.lockAt : "",
    "原文：\n" + source.body.slice(0, 50000),
  ].filter(Boolean).join("\n");
  return requestAnalysis([{ type: "input_text", text }]);
}

export async function analyzeSourceFile(source: CanvasSource): Promise<ExtractedAnalysis> {
  const config = apiConfig();
  if (!config || !source.file?.url) throw new Error("FILE_ANALYSIS_UNAVAILABLE");
  if (source.file.size > 8 * 1024 * 1024) throw new Error("FILE_TOO_LARGE");
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
      { type: "input_text", text: "课程文件：" + source.file.name },
      { type: "input_file", file_id: file.id },
    ]);
  } finally {
    await fetch("https://api.openai.com/v1/files/" + file.id, {
      method: "DELETE",
      headers: { Authorization: "Bearer " + config.key },
    }).catch(() => undefined);
  }
}
