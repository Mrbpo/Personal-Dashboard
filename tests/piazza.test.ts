import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET = "piazza-test-secret-that-is-not-used-outside-tests";
const { baseCourseCode, classesFromStatus, confirmedPiazzaAnswer, decryptPiazzaCookies, encryptPiazzaCookies, normalizePiazzaPost, piazzaRpc } = await import("../lib/piazza.ts");

test("Piazza session cookies are encrypted and recoverable", () => {
  const cookies = { session_id: "private-session", csrftoken: "csrf" };
  const encrypted = encryptPiazzaCookies(cookies);
  assert.equal(encrypted.includes("private-session"), false);
  assert.deepEqual(decryptPiazzaCookies(encrypted), cookies);
});

test("Canvas and Piazza course codes share the same base code", () => {
  assert.equal(baseCourseCode("CHMA10H3 F - Intro Chemistry"), "CHMA10");
  assert.equal(baseCourseCode("CHMA10"), "CHMA10");
  assert.equal(baseCourseCode("STAB22H3 LEC01"), "STAB22");
});

test("Piazza status exposes only class matching fields", () => {
  assert.deepEqual(classesFromStatus({ networks: [{ id: "abc", name: "Statistics", course_number: "STAB22", term: "Fall 2026", email: "hidden@example.com" }] }), [
    { nid: "abc", name: "Statistics", num: "STAB22", term: "Fall 2026" },
  ]);
});

test("Piazza posts keep useful text but omit author metadata", () => {
  const normalized = normalizePiazzaPost({ nr: 7, modified: "2026-09-13T12:00:00Z", folders: ["lab"], history: [{ subject: "<b>Lab 1 notebook</b>", content: "<p>Prepare the title and purpose before class.</p>", uid: "author-id" }], children: [{ history: [{ content: "Bring a pen.", uid: "other-author" }] }] }, "network", "course");
  assert.equal(normalized.title, "Lab 1 notebook");
  assert.match(normalized.body, /Prepare the title/);
  assert.match(normalized.body, /Bring a pen/);
  assert.doesNotMatch(normalized.body, /author-id|other-author/);
  assert.equal(normalized.sourceUrl, "https://piazza.com/class/network/post/7");
});

test("only explicit instructor answers qualify as confirmed", () => {
  const post = { type: "question", nr: 8, history: [{ subject: "When is the lab?", content: "Please confirm." }], children: [
    { type: "s_answer", history: [{ content: "I think Tuesday." }] },
    { type: "followup", history: [{ content: "Any update?" }] },
    { type: "i_answer", history: [{ content: "The lab is Wednesday at 2 pm." }] },
  ] };
  assert.equal(confirmedPiazzaAnswer(post), "The lab is Wednesday at 2 pm.");
  assert.equal(normalizePiazzaPost(post, "network", "course").answer, "The lab is Wednesday at 2 pm.");
  assert.equal(confirmedPiazzaAnswer({ ...post, children: post.children.slice(0, 2) }), "");
  assert.equal(confirmedPiazzaAnswer({ ...post, type: "note" }), "");
});

test("Piazza client rejects every non-read RPC method", async () => {
  await assert.rejects(() => piazzaRpc({}, "content.create", {}), /PIAZZA_WRITE_BLOCKED/);
});
