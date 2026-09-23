import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = ':memory:';
process.env.OPENAI_API_KEY = 'test-key';
const repo = await import('../lib/repository.ts');
const lib = await import('../lib/library.ts');
const { searchArchiveForAnswer } = await import('../lib/archive-search.ts');

test('strong local lab evidence avoids an external embedding wait', async () => {
  await repo.upsertCourses([{ id:'chem', name:'Chemistry', course_code:'CHMA10H3' }, { id:'stats', name:'Statistics', course_code:'STAB22H3' }]);
  const documentId = await lib.saveDocument('student','chem','upload','lab1','Lab 1 Instructions.txt','text/plain',Buffer.from('Lab 1 requirements: prepare the notebook before class.'));
  await lib.indexDocument('student',documentId);
  const source = { id:'chem:lab1', courseId:'chem', sourceType:'assignment', sourceId:'lab1', title:'Lab 1 assignment', body:'Prepare the notebook before class.', sourceUrl:null, updatedAt:null, dueAt:null, unlockAt:null, lockAt:null, submissionState:null, pointsPossible:null, prerequisiteBlocked:false };
  await repo.saveSource(source, null, await repo.hashSource(source), 'rule_only');
  await repo.savePiazzaPost({ id:'piazza:chem:lab1', courseId:'chem', networkId:'chem', postNumber:'lab1', title:'Lab 1 discussion', body:'Student asks about goggles.', answer:'Bring goggles to Lab 1.', kind:'question', createdAt:'2026-09-22', sourceUrl:'https://piazza.com/class/chem/post/lab1', folders:[], updatedAt:'2026-09-22', contentHash:'lab1' });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('embedding should not be needed'); }) as typeof fetch;
  try {
    const result = await searchArchiveForAnswer('student','CHMA10 Lab 1 requirements');
    assert.equal(calls, 0);
    assert.equal(result.inferredCourseId, 'chem');
    assert.ok(result.sources.some((item) => item.sourceType === 'document'));
    assert.ok(result.sources.some((item) => item.sourceType === 'piazza' && item.confirmedAnswer));
    assert.ok(result.sources.some((item) => item.sourceType === 'assignment'));
    assert.ok(result.sources.every((item) => item.courseId === 'chem'));
    assert.equal(result.timings.embeddingMs, 0);
    assert.ok(result.timings.structuredMs >= 0 && result.timings.libraryMs >= 0);

    const chinese = await searchArchiveForAnswer('student','我的实验要求','chem');
    assert.ok(chinese.sources.some((item) => item.sourceType === 'document' && item.sourceId === documentId), 'English Lab PDF must be found by the Chinese question');
    assert.ok(chinese.sources.some((item) => item.sourceType === 'piazza' && item.confirmedAnswer), 'confirmed Piazza answer must accompany the document');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('weak evidence makes at most one bounded embedding request', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.match(String(_input), /embeddings/);
    assert.ok(init?.signal);
    return Response.json({ data:[{ index:0, embedding:Array(768).fill(0.1) }] });
  }) as typeof fetch;
  try {
    const result = await searchArchiveForAnswer('student','CHMA10 unrelatedconcept');
    assert.equal(calls, 1);
    assert.ok(result.timings.embeddingMs >= 0);
    assert.ok(result.timings.totalMs >= result.timings.embeddingMs);
  } finally { globalThis.fetch = original; }
});

test('math tutorial plus syllabus remains within math and includes both requested sources', async () => {
  await repo.upsertCourses([{ id:'math', name:'Calculus I', course_code:'MATA29H3' }, { id:'stats', name:'Statistics I', course_code:'STAB22H3' }]);
  const mathTutorial=await lib.saveDocument('student','math','upload','math-tut','Tutorial 2.txt','text/plain',Buffer.from('Tutorial 2: complete problems 1 and 2 before Friday.'));
  await lib.indexDocument('student',mathTutorial);
  const statsTutorial=await lib.saveDocument('student','stats','upload','stats-tut','Tutorial 2.txt','text/plain',Buffer.from('Statistics Tutorial 2: make boxplots.'));
  await lib.indexDocument('student',statsTutorial);
  const syllabus={ id:'math:syllabus', courseId:'math', sourceType:'syllabus', sourceId:'syllabus', title:'课程大纲 Syllabus', body:'Tutorials count for 10 percent of the course grade.', sourceUrl:null, updatedAt:null, dueAt:null, unlockAt:null, lockAt:null, submissionState:null, pointsPossible:null, prerequisiteBlocked:false };
  await repo.saveSource(syllabus, null, await repo.hashSource(syllabus), 'rule_only');

  const result=await searchArchiveForAnswer('student','数学tut要做什么，帮我看看课程大纲');
  assert.equal(result.inferredCourseId,'math');
  assert.equal(result.courseSelection,null);
  assert.ok(result.sources.some((item)=>item.sourceId===mathTutorial));
  assert.ok(result.sources.some((item)=>item.sourceType==='syllabus'));
  assert.ok(result.sources.every((item)=>item.courseId==='math'));
  assert.ok(!result.sources.some((item)=>item.sourceId===statsTutorial));

  await repo.upsertCourses([{ id:'math2', name:'Linear Algebra', course_code:'MATB41H3' }]);
  const ambiguous=await searchArchiveForAnswer('student','数学tut要做什么，帮我看看课程大纲');
  assert.equal(ambiguous.inferredCourseId,null);
  assert.deepEqual(ambiguous.courseSelection?.map((course)=>course.id), ['math','math2']);
  assert.deepEqual(ambiguous.sources,[]);
});
