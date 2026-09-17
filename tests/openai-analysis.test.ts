import test from "node:test";
import assert from "node:assert/strict";
import type { CanvasSource } from "../lib/domain.ts";

process.env.OPENAI_API_KEY = "test-openai-key";
process.env.OPENAI_MODEL = "gpt-5-mini";
process.env.CANVAS_BASE_URL = "https://canvas.example.test";
process.env.CANVAS_TOKEN = "test-canvas-token";
const { analyzeSource, analyzeSourceFile } = await import("../lib/openai-analysis.ts");

const output = { summary: "摘要", actions: [{ title: "任务", action: "完成任务", requirements: [], recommendedStartAt: null, inferredDueAt: null, confidence: "certain", evidence: "evidence", estimatedMinutes: 30, possiblyCancelled: false }], notes: [] };

test("Responses requests use structured output and store false", async () => {
  const original = globalThis.fetch;
  let requestBody: { store?: boolean; text?: { format?: { type?: string; strict?: boolean } } } = {};
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ output_text: JSON.stringify(output) });
  }) as typeof fetch;
  try {
    const source: CanvasSource = { id: "1", courseId: "1", sourceType: "announcement", sourceId: "1", title: "Notice", body: "Complete the reading before class.", sourceUrl: null, updatedAt: null, dueAt: null, unlockAt: null, lockAt: null };
    assert.equal((await analyzeSource(source)).summary, "摘要");
    assert.equal(requestBody.store, false);
    assert.equal(requestBody.text?.format?.type, "json_schema");
    assert.equal(requestBody.text?.format?.strict, true);
  } finally { globalThis.fetch = original; }
});

test("temporary OpenAI file is deleted after analysis", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); calls.push(url);
    if (url.startsWith("https://canvas.example.test")) return new Response("document", { status: 200, headers: { "Content-Type": "text/plain" } });
    if (url.endsWith("/v1/files")) return Response.json({ id: "file_test" });
    if (url.endsWith("/v1/responses")) return Response.json({ output_text: JSON.stringify(output) });
    if (url.endsWith("/v1/files/file_test")) return Response.json({ deleted: true });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  try {
    const source: CanvasSource = { id: "f", courseId: "1", sourceType: "file", sourceId: "f", title: "Guide", body: "", sourceUrl: null, updatedAt: null, dueAt: null, unlockAt: null, lockAt: null, file: { url: "https://canvas.example.test/files/1/download", name: "guide.txt", size: 8, contentType: "text/plain" } };
    await analyzeSourceFile(source);
    assert.ok(calls.some((url) => url.endsWith("/v1/files/file_test")));
  } finally { globalThis.fetch = original; }
});
