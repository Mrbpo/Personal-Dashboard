import test from "node:test";
import assert from "node:assert/strict";

process.env.OPENAI_API_KEY = "test-key";
const { answerCourseQuestion, cleanActionAnswer } = await import("../lib/course-qa.ts");

test("short task answers remove setup detours, speculation and offers", () => {
  const answer = cleanActionAnswer("释义：Tutorial 是课程练习。 1) 截止周五。[S1]\n2. 做频率表。[S1]\n3. 在 workspace 建立资料夹并新建 tutorial1.R。[S2]\n4. 未列出的事项（需你确认）：请确认提交平台与文件命名。\n5. 画条形图。[S1]\n6. 如果你愿意我还可以继续帮助。", "tutorial 1 要做什么");
  assert.equal(answer, "1) 截止周五。[S1]\n2. 做频率表。[S1]\n3. 画条形图。[S1]");
});

test("course Q&A retries a truncated structured response", async () => {
  const original = globalThis.fetch;
  const tokenLimits: number[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    tokenLimits.push(request.max_output_tokens);
    const prompt=request.input.find((item: {role:string})=>item.role==='user').content[0].text;
    assert.match(prompt, /不是原文摘抄器/);
    assert.match(prompt, /课前完成/);
    if (tokenLimits.length === 1) return new Response(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output_text: "{\"answer\":\"截断" }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ answer: "课前写好标题。 [S1]", needsClarification: false, followUps: [], citationRefs: ["S1"] }) }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    const result = await answerCourseQuestion("Lab 前写什么？", [{ ref: "S1", sourceId: "1", courseId: "1", courseCode: "CHMA10", sourceType: "page", title: "Lab notebook", excerpt: "课前写标题", body: "课前写标题", sourceUrl: null, updatedAt: null }]);
    assert.equal(result.answer, "课前写好标题。 [S1]");
    assert.deepEqual(tokenLimits, [3200, 6400]);
  } finally { globalThis.fetch = original; }
});

test("answer context includes both a strong document and confirmed Piazza evidence", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    const prompt = request.input.find((item: {role:string})=>item.role==='user').content[0].text;
    assert.match(prompt, /Lab 1 PDF says prepare the notebook/);
    assert.match(prompt, /教师明确回答：Bring goggles/);
    assert.match(prompt, /分别引用/);
    assert.match(prompt, /解析警告（此来源）：\["原始公式文本未验证 LaTeX、符号和上下标"\]/);
    const instruction=request.input.find((item:{role:string})=>item.role==='developer').content[0].text;
    assert.match(instruction, /不得断言抽取式是精确原式/);
    assert.match(instruction, /已支持的普通正文仍可正常回答/);
    return Response.json({ status:'completed', output_text:JSON.stringify({ answer:'准备实验记录本，并带护目镜。[S1][S2]', needsClarification:false, followUps:[], citationRefs:['S1','S2'] }) });
  }) as typeof fetch;
  try {
    const sources = [
      { ref:'S1', sourceId:'pdf', courseId:'chem', courseCode:'CHMA10', sourceType:'document', title:'Lab1.pdf', excerpt:'Lab 1 PDF says prepare the notebook', body:'Lab 1 PDF says prepare the notebook', sourceUrl:'/api/library/pdf', updatedAt:null,parser_warnings:['原始公式文本未验证 LaTeX、符号和上下标'] },
      { ref:'S2', sourceId:'post', courseId:'chem', courseCode:'CHMA10', sourceType:'piazza', title:'Lab 1 discussion', excerpt:'教师明确回答：Bring goggles', body:'教师明确回答：Bring goggles', sourceUrl:'https://piazza.com/test', updatedAt:null, confirmedAnswer:true },
    ];
    const result = await answerCourseQuestion('CHMA10 Lab 1 要求是什么？', sources);
    assert.deepEqual(result.citationRefs, ['S1','S2']);
  } finally { globalThis.fetch = original; }
});

test("unconfirmed Piazza discussion alone cannot establish lab requirements", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('insufficient evidence must not invoke AI'); }) as typeof fetch;
  try {
    const result = await answerCourseQuestion('Lab 1 要求是什么？', [{ ref:'S1', sourceId:'student', courseId:'chem', courseCode:'CHMA10', sourceType:'piazza', title:'Lab 1 question', excerpt:'学生猜测', body:'此问答帖尚无教师明确回答。学生猜测', sourceUrl:null, updatedAt:null, unconfirmedDiscussion:true }]);
    assert.equal(result.needsClarification, true);
    assert.match(result.answer, /不能据此确定实验要求/);
  } finally { globalThis.fetch = original; }
});

test('a combined tutorial and syllabus question asks AI to answer both parts', async () => {
  const original=globalThis.fetch;
  globalThis.fetch=(async (_input: string | URL | Request, init?: RequestInit) => {
    const prompt=JSON.parse(String(init?.body)).input.find((item:{role:string})=>item.role==='user').content[0].text as string;
    assert.match(prompt,/分两部分回答/);
    assert.match(prompt,/Tutorial 2 requires problems 1 and 2/);
    assert.match(prompt,/Tutorials count for 10 percent/);
    assert.doesNotMatch(prompt,/忽略与当前任务无关的旧公告、通用 syllabus/);
    return Response.json({status:'completed',output_text:JSON.stringify({answer:'Tutorial 2 完成第 1、2 题。[S1]\n大纲说明 tutorial 占总评 10%。[S2]',needsClarification:false,followUps:[],citationRefs:['S1','S2']})});
  }) as typeof fetch;
  try {
    const base={courseId:'math',courseCode:'MATA29H3',excerpt:'',sourceUrl:null,updatedAt:null};
    const answer=await answerCourseQuestion('数学tut要做什么，帮我看看课程大纲',[
      {...base,ref:'S1',sourceId:'tut',sourceType:'document',title:'Tutorial 2',body:'Tutorial 2 requires problems 1 and 2.'},
      {...base,ref:'S2',sourceId:'syllabus',sourceType:'syllabus',title:'Syllabus',body:'Tutorials count for 10 percent.'},
    ]);
    assert.deepEqual(answer.citationRefs,['S1','S2']);
  } finally {globalThis.fetch=original;}
});

test("an ambiguous lab request asks for the course instead of mixing requirements", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error('ambiguous courses must not invoke AI'); }) as typeof fetch;
  try {
    const common = { sourceType:'assignment', title:'Lab 1', excerpt:'Lab requirements', body:'Lab requirements', sourceUrl:null, updatedAt:null };
    const result = await answerCourseQuestion('我的实验要求', [
      { ...common, ref:'S1', sourceId:'chem-lab', courseId:'chem', courseCode:'CHMA10' },
      { ...common, ref:'S2', sourceId:'stats-lab', courseId:'stats', courseCode:'STAB22' },
    ]);
    assert.equal(result.needsClarification, true);
    assert.match(result.answer, /CHMA10、STAB22/);
    assert.deepEqual(result.citationRefs, ['S1','S2']);
  } finally { globalThis.fetch = original; }
});
