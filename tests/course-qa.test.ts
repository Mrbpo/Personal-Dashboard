import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "test-key";
const { answerCourseQuestion } = await import("../lib/course-qa.ts");

test("course Q&A retries a truncated structured response", async () => {
  const original = globalThis.fetch;
  const tokenLimits: number[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    tokenLimits.push(request.max_output_tokens);
    assert.match(request.input[0].content[0].text, /不是原文摘抄器/);
    assert.match(request.input[0].content[0].text, /课前完成/);
    if (tokenLimits.length === 1) return new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "{\"answer\":\"截断" }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ answer: "课前写好标题。 [S1]", needsClarification: false, followUps: [], citationRefs: ["S1"] }) }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await answerCourseQuestion("Lab 前写什么？", [{ ref: "S1", sourceId: "1", courseId: "1", courseCode: "CHMA10", sourceType: "page", title: "Lab notebook", excerpt: "课前写标题", body: "课前写标题", sourceUrl: null, updatedAt: null }]);
    assert.equal(result.answer, "课前写好标题。 [S1]");
    assert.deepEqual(tokenLimits, [3200, 6400]);
  } finally { globalThis.fetch = original; }
});
