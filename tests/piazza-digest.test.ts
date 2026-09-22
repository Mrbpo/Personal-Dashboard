import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = ":memory:";
const { upsertCourses, savePiazzaPost } = await import("../lib/repository.ts");
const { getPiazzaDailySummary, searchConfirmedPiazzaAnswers } = await import("../lib/piazza-digest.ts");

test("daily digest includes every update while answer search excludes unconfirmed replies", async () => {
  await upsertCourses([{ id: "chem", name: "Chemistry", course_code: "CHMA10H3" }]);
  const base = { courseId: "chem", networkId: "network", folders: [], createdAt: "2026-09-22T12:00:00Z", updatedAt: "2026-09-22T13:00:00Z" };
  await savePiazzaPost({ ...base, id: "piazza:network:1", postNumber: "1", title: "Lab schedule", body: "When? Wednesday 2 pm", answer: "Wednesday 2 pm", kind: "question", sourceUrl: "https://piazza.com/class/network/post/1", contentHash: "a" });
  await savePiazzaPost({ ...base, id: "piazza:network:2", postNumber: "2", title: "Lab room", body: "Someone thinks room 2", answer: "", kind: "question", sourceUrl: "https://piazza.com/class/network/post/2", contentHash: "b" });
  await savePiazzaPost({ ...base, id: "piazza:network:3", postNumber: "3", title: "Welcome", body: "Welcome to class", answer: "", kind: "note", sourceUrl: "https://piazza.com/class/network/post/3", contentHash: "c" });
  await savePiazzaPost({ ...base, id: "piazza:network:4", postNumber: "4", title: "Late note", body: "Before midnight Toronto time", answer: "", kind: "note", updatedAt: "2026-09-23T02:00:00Z", sourceUrl: "https://piazza.com/class/network/post/4", contentHash: "d" });
  const daily = await getPiazzaDailySummary("2026-09-22", "America/Toronto");
  assert.equal(daily.total, 4);
  assert.equal(daily.answered, 1);
  assert.equal(daily.posts.length, 4);
  assert.equal((await searchConfirmedPiazzaAnswers("Lab")).total, 1);
  assert.equal((await searchConfirmedPiazzaAnswers("Wednesday")).items[0].id, "piazza:network:1");
  assert.equal((await searchConfirmedPiazzaAnswers("room")).total, 0);
});
