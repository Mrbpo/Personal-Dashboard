import test from "node:test";
import assert from "node:assert/strict";

process.env.CANVAS_BASE_URL = "https://canvas.example.test";
process.env.CANVAS_TOKEN = "test-token";
const { allPages, downloadCanvasFile, getCourseSources, getHistoricalPlannerSources,
  setCanvasPlannerComplete, textFromHtml } = await import("../lib/canvas.ts");

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

test('planner normalization retains the outer typed reference even without a URL',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=(async input=>{
    const url=String(input);
    if(url.includes('/planner/items?'))return Response.json([{id:900,plannable_type:'assignment',
      plannable_id:42,plannable:{id:42,title:'Problem set',html_url:null,due_at:'2026-10-01'}}]);
    if(url.includes('/assignments?'))return Response.json([{id:42,name:'Problem set',
      html_url:'https://canvas.example.test/courses/7/assignments/42'}]);
    return Response.json(url.includes('/courses/7?')?{}:[]);
  }) as typeof fetch;
  try{
    const result=await getCourseSources('7');
    const planner=result.sources.find(source=>source.sourceType==='planner');
    assert.equal(planner?.sourceId,'42');
    assert.equal(planner?.plannableType,'assignment');
    assert.equal(planner?.plannableId,'42');
    assert.equal(planner?.sourceUrl,null);
  }finally{globalThis.fetch=original;}
});

test('historical planner fetch uses an old bounded window, follows pages and retries 429',async()=>{
  const original=globalThis.fetch;
  const calls:string[]=[];
  globalThis.fetch=(async input=>{
    const url=String(input);calls.push(url);
    if(calls.length===1)return new Response('',{status:429,headers:{'retry-after':'0'}});
    if(calls.length===2)return new Response(JSON.stringify([]),{status:200,
      headers:{Link:'<https://canvas.example.test/api/v1/planner/items?page=2>; rel="next"'}});
    return Response.json([{course_id:7,id:900,plannable_type:'assignment',plannable_id:42,
      plannable:{id:42,title:'Old assignment',due_at:'2026-05-26'}}]);
  }) as typeof fetch;
  try{
    const sources=await getHistoricalPlannerSources('7','2026-05-24','2026-06-01');
    assert.equal(sources.length,1);
    assert.equal(sources[0].id,'7:planner:42');
    assert.equal(sources[0].plannerItemId,'900');
    assert.equal(sources[0].plannerCourseId,'7');
    assert.equal(sources[0].plannableType,'assignment');
    assert.equal(sources[0].plannableId,'42');
    assert.match(calls[0],/start_date=2026-05-24&end_date=2026-06-01/);
    assert.equal(calls.length,3);
  }finally{globalThis.fetch=original;}
});

test('historical planner rejects a partial second page and a conflicting course',async()=>{
  const original=globalThis.fetch;
  let page=0;
  globalThis.fetch=(async()=>{
    page++;
    return page===1?new Response('[]',{headers:{Link:'<https://canvas.example.test/api/v1/planner/items?page=2>; rel="next"'}})
      :new Response('',{status:403});
  }) as typeof fetch;
  try{await assert.rejects(getHistoricalPlannerSources('7','2026-05-24','2026-06-01'),/CANVAS_REQUEST_FAILED_403/);}
  finally{globalThis.fetch=original;}
  globalThis.fetch=(async()=>Response.json([{course_id:8,plannable_type:'assignment',
    plannable_id:42,plannable:{id:42,title:'Wrong course'}}])) as typeof fetch;
  try{await assert.rejects(getHistoricalPlannerSources('7','2026-05-24','2026-06-01'),/CANVAS_PLANNER_COURSE_MISMATCH/);}
  finally{globalThis.fetch=original;}
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
