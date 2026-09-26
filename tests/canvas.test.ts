import test from "node:test";
import assert from "node:assert/strict";

process.env.CANVAS_BASE_URL = "https://canvas.example.test";
process.env.CANVAS_TOKEN = "test-token";
const { allPages, downloadCanvasFile, getCourseSources, setCanvasPlannerComplete, textFromHtml } = await import("../lib/canvas.ts");

test('an optional Canvas endpoint failure marks the course scan incomplete',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=(async input=>{
    const url=String(input);
    if(url.includes('/quizzes?'))return new Response('temporary failure',{status:503});
    return Response.json(url.includes('/courses/course-1?')?{}:[]);
  }) as typeof fetch;
  try{
    const result=await getCourseSources('course-1');
    assert.equal(result.complete,false);
    assert.deepEqual(result.sources,[]);
  }finally{globalThis.fetch=original;}
});

test("Canvas pagination follows the next link and keeps bearer auth", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; auth: string | null }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (calls.length === 1) return new Response(JSON.stringify([{ id: 1 }]), { headers: { "Content-Type": "application/json", Link: '<https://canvas.example.test/api/v1/test?page=2>; rel="next"' } });
    return new Response(JSON.stringify([{ id: 2 }]), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await allPages<{ id: number }>("/api/v1/test"), [{ id: 1 }, { id: 2 }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].auth, "Bearer test-token");
  } finally { globalThis.fetch = original; }
});

test("Canvas HTML is cleaned into readable text", () => {
  assert.equal(textFromHtml("<p>Hello &amp; welcome</p><script>bad()</script><ul><li>Read this</li></ul>"), "Hello & welcome\n Read this");
});

test("Canvas file downloads resolve relative URLs but reject another origin", async () => {
  const original = globalThis.fetch; let requested = "";
  globalThis.fetch = (async (input: string | URL | Request) => { requested=String(input);return new Response("pdf"); }) as typeof fetch;
  try {
    assert.equal((await downloadCanvasFile("/files/42/download")).status,200);
    assert.equal(requested,"https://canvas.example.test/files/42/download");
    await assert.rejects(downloadCanvasFile("https://evil.example/files/42"),/UNTRUSTED_CANVAS_FILE_URL/);
  } finally { globalThis.fetch=original; }
});

test("Canvas planner completion creates a personal override", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method || "GET", body: String(init?.body || "") });
    if (!init?.method) return new Response("[]", { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ id: 9, marked_complete: true }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await setCanvasPlannerComplete("assignment", "42", true), { supported: true, synced: true });
    assert.equal(calls[1].method, "POST");
    assert.match(calls[1].body, /plannable_type=assignment/);
    assert.match(calls[1].body, /plannable_id=42/);
    assert.match(calls[1].body, /marked_complete=true/);
  } finally { globalThis.fetch = original; }
});
