import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
process.env.OPENAI_API_KEY = "piazza-test-key";
process.env.CHATGPT_AUTO = "false";
process.env.AI_BUDGET_TEST_BYPASS = "true";
const { upsertCourses, savePiazzaPost } = await import("../lib/repository.ts");
const { answerPiazzaQuestion, generatePiazzaWeekSummary, listPiazzaAiWeeks, piazzaWeekStart } = await import("../lib/piazza-ai.ts");

test("weekly AI summary covers every post and refreshes only when sources change", async () => {
  await upsertCourses([{ id: "chem", name: "Chemistry", course_code: "CHMA10H3" }]);
  const base = { courseId: "chem", networkId: "network", folders: [], createdAt: "2026-09-22T12:00:00Z" };
  const confirmed = { ...base, id: "piazza:network:1", postNumber: "1", title: "Lab time", body: "When is lab? The teacher answered Wednesday at 2 pm.", answer: "Wednesday at 2 pm", kind: "question", updatedAt: "2026-09-22T13:00:00Z", sourceUrl: "https://piazza.com/class/network/post/1", contentHash: "a" };
  await savePiazzaPost(confirmed);
  await savePiazzaPost({ ...base, id: "piazza:network:2", postNumber: "2", title: "Bring goggles", body: "Everyone should bring goggles.", answer: "", kind: "note", updatedAt: "2026-09-22T12:00:00Z", sourceUrl: "https://piazza.com/class/network/post/2", contentHash: "b" });
  await savePiazzaPost({ ...base, id: "piazza:network:3", postNumber: "3", title: "Lab room rumor", body: "A student thinks room 3.", answer: "", kind: "question", updatedAt: "2026-09-22T11:00:00Z", sourceUrl: "https://piazza.com/class/network/post/3", contentHash: "c" });
  await savePiazzaPost({ ...base, id: "piazza:network:4", postNumber: "4", title: "Next week lab", body: "Next week meets on Friday.", answer: "", kind: "note", updatedAt: "2026-09-29T12:00:00Z", sourceUrl: "https://piazza.com/class/network/post/4", contentHash: "d" });
  assert.equal(piazzaWeekStart("2026-09-22"), "2026-09-21");
  assert.deepEqual((await listPiazzaAiWeeks()).map(week => week.weekStart), ["2026-09-28", "2026-09-21"]);
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    const materials = body.input[1].content as string;
    if (materials.includes("问题：")) {
      assert.match(materials, /Wednesday at 2 pm/);
      assert.doesNotMatch(materials, /Lab room rumor/);
      return Response.json({ output_text: JSON.stringify({ answer: "实验在周三下午两点。[P1]", supported: true, refs: ["P1"] }) });
    }
    assert.match(materials, /Lab room rumor/);
    assert.doesNotMatch(materials, /Next week lab/);
    return Response.json({ output_text: JSON.stringify({ points: [{ text: "实验在周三下午两点。", refs: ["P1"], category: "answer" }] }) });
  };
  try {
    const report = await generatePiazzaWeekSummary("2026-09-21");
    assert.equal(report.postCount, 3);
    assert.ok(report.points.some(point => point.refs.includes("P3")));
    assert.equal((await listPiazzaAiWeeks()).find(week => week.weekStart === "2026-09-21")?.report?.postCount, 3);
    await generatePiazzaWeekSummary("2026-09-21");
    assert.equal(calls, 1);
    const answer = await answerPiazzaQuestion("When is Lab time?", "2026-09-21");
    assert.equal(answer.supported, true);
    assert.equal(answer.sources[0].url, confirmed.sourceUrl);
    await savePiazzaPost({ ...confirmed, body: "When is lab? The teacher changed it to Thursday.", answer: "Thursday at 2 pm", contentHash: "changed" });
    assert.equal((await listPiazzaAiWeeks()).find(week => week.weekStart === "2026-09-21")?.report, null);
    await generatePiazzaWeekSummary("2026-09-21");
    assert.equal(calls, 3);
  } finally { globalThis.fetch = original; }
});
