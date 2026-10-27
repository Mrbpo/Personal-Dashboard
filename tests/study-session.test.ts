import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.STUDY_ANSWER_BACKEND='kernel';
process.env.OPENAI_API_KEY='fixture-not-sent';
const {kernel}=await import('../lib/kernel/service.ts');
const tutor=await import('../lib/tutor.ts');
const session=await import('../lib/study-session.ts');
const {database:db}=await import('../lib/database.ts');
const {acquireLease,releaseLease}=await import('../lib/jobs.ts');
function selected(ids:string[]){
 return ids.map(id=>({id,name:id+'.pdf',versionId:'fixture',sourceVersionId:'fixture-source',sourceHash:'fixture-hash'}));
}

test('auto keeps document statements separate from global facts and mixed questions',()=>{
 const selected={queryMode:'auto' as const,documentIds:['pdf-a'],revision:1};
 assert.equal(session.resolveStudyQueryMode('这份 PDF 写的截止日期是什么？',selected),'document');
 assert.equal(session.resolveStudyQueryMode('现在什么时候截止？',selected),'facts');
 assert.equal(session.resolveStudyQueryMode('解释公式，并告诉我作业截止时间',selected),'combined');
 assert.equal(session.resolveStudyQueryMode('解释这个概念',selected),'document');
});

test('facts-only release blocks PDF modes and routes compatibility requests without document or model calls',async()=>{
 const previous=process.env.STUDY_FACTS_ONLY;
 const saved={selected:kernel.selectedStudyDocuments,facts:kernel.answerCourseFacts,answer:kernel.answerStudyContent,fetch:globalThis.fetch};
 let factCalls=0;
 process.env.STUDY_FACTS_ONLY='true';
 kernel.selectedStudyDocuments=async()=>{throw Error('PDF must stay paused');};
 kernel.answerStudyContent=async()=>{throw Error('PDF generation must stay paused');};
 kernel.answerCourseFacts=async()=>{factCalls++;return {answer:'Only confirmed course facts [F1]',meta:{citations:[{ref:'F1',title:'Confirmed fact'}]}};};
 globalThis.fetch=async()=>{throw Error('No model or network request permitted');};
 try{
  assert.equal(session.resolveStudyQueryMode('解释这份 PDF',{queryMode:'document',documentIds:['old-pdf'],revision:1}),'facts');
  const thread=await tutor.createTutorThread('facts-only-owner','');
  await assert.rejects(session.updateStudySession('facts-only-owner',thread,{queryMode:'document',documentIds:[],scopeRevision:0}),/PDF 问答已暂停/);
  await tutor.sendTutor('facts-only-owner',thread,'facts-only-00000001','最近有哪些截止时间？',[],false);
  const state=await tutor.tutorState('facts-only-owner',thread);
  assert.equal(state.messages[1].meta.studySession.effectiveMode,'facts');
  assert.equal(factCalls,1);
 }finally{
  if(previous===undefined)delete process.env.STUDY_FACTS_ONLY;else process.env.STUDY_FACTS_ONLY=previous;
  kernel.selectedStudyDocuments=saved.selected;kernel.answerCourseFacts=saved.facts;kernel.answerStudyContent=saved.answer;globalThis.fetch=saved.fetch;
 }
});
test('lost first response reuses the owner/request thread binding and rejects changed payloads',async()=>{
 const request={id:'lost-response-0001',payloadHash:'same-question-and-scope'};
 const [first,retry]=await Promise.all([
  tutor.createTutorThread('retry-owner','',request),tutor.createTutorThread('retry-owner','',request),
 ]);
 assert.equal(first,retry);
 assert.equal((await tutor.tutorState('retry-owner')).threads.length,1);
 await assert.rejects(tutor.createTutorThread('retry-owner','',{...request,payloadHash:'changed-document'}),/请求标识/);
 assert.equal((await tutor.tutorState('retry-owner')).threads.length,1);
 assert.notEqual(await tutor.createTutorThread('other-retry-owner','',request),first);
 await session.readStudySession('retry-owner',first);
 await tutor.deleteTutorThread('retry-owner',first);
 assert.equal((await db.prepare('SELECT thread_id FROM tutor_study_requests WHERE owner_id=?').bind('retry-owner').all()).results.length,0);
 assert.equal((await db.prepare('SELECT thread_id FROM tutor_study_scope_versions WHERE thread_id=?').bind(first).all()).results.length,0);
});
test('selection survives refresh, rejects stale revisions, foreign threads and active-generation changes',async()=>{
 const saved=kernel.selectedStudyDocuments;
 kernel.selectedStudyDocuments=async(_owner,ids)=>selected(ids.filter(id=>id!=='missing'));
 try{
  const thread=await tutor.createTutorThread('scope-alice','');
  const initial=await session.readStudySession('scope-alice',thread);
  const current=await session.updateStudySession('scope-alice',thread,{queryMode:'document',documentIds:['pdf-b','pdf-a'],scopeRevision:initial.revision});
  assert.deepEqual(await session.readStudySession('scope-alice',thread),current);
  assert.deepEqual(current.documentIds,['pdf-a','pdf-b']);
  await assert.rejects(session.readStudySession('scope-bob',thread),/无权访问/);
  await assert.rejects(session.updateStudySession('scope-alice',thread,{queryMode:'facts',documentIds:[],scopeRevision:0}),/已被其他/);
  await assert.rejects(session.updateStudySession('scope-alice',thread,{queryMode:'document',documentIds:['missing'],scopeRevision:current.revision}),/尚未完成解析/);
  const token='scope-test-lock';
  await acquireLease('tutor:'+thread,token);
  try{await assert.rejects(session.updateStudySession('scope-alice',thread,{queryMode:'document',documentIds:['pdf-c'],scopeRevision:current.revision}),/正在回答/);}
  finally{await releaseLease('tutor:'+thread,token);}
  const versions=(await db.prepare('SELECT revision FROM tutor_study_scope_versions WHERE thread_id=? ORDER BY revision').bind(thread).all()).results;
  assert.deepEqual(versions.map(row=>row.revision),[0,1]);
  kernel.selectedStudyDocuments=async()=>[];
  const cleared=await session.updateStudySession('scope-alice',thread,{queryMode:'document',documentIds:[],scopeRevision:current.revision});
  assert.deepEqual(cleared.documentIds,[],'all removed/unavailable selections can be cleared without broadening retrieval');
  assert.equal(cleared.revision,2);
 }finally{kernel.selectedStudyDocuments=saved;}
});
test('facts ignore unavailable selected PDF, persist exact request mode and reject idempotency scope changes',async()=>{
 const saved={selected:kernel.selectedStudyDocuments,facts:kernel.answerCourseFacts,answer:kernel.answerStudyContent,fetch:globalThis.fetch};
 let reads=0,calls=0;
 kernel.selectedStudyDocuments=async()=>{reads++;throw Error('PDF must not be consulted for facts');};
 kernel.answerCourseFacts=async(owner,q)=>{calls++;assert.equal(owner,'fact-owner');assert.equal(q,'现在什么时候截止？');return {answer:'Confirmed deadline: 2026-11-03 [F1]',meta:{citations:[{ref:'F1',title:'Confirmed fact'}]}};};
 kernel.answerStudyContent=async()=>{throw Error('Document answer must not run');};
 globalThis.fetch=async()=>{throw Error('No external requests permitted');};
 try{
  const thread=await tutor.createTutorThread('fact-owner','');
  const chosen=await session.updateStudySession('fact-owner',thread,{queryMode:'facts',documentIds:['missing'],scopeRevision:0});
  const send=()=>tutor.sendTutor('fact-owner',thread,'facts-request-0000001','现在什么时候截止？',[],false,'',undefined,chosen);
  await send();await send();
  assert.equal(calls,1);assert.equal(reads,0);
  const state=await tutor.tutorState('fact-owner',thread);
  assert.equal(state.messages[1].meta.studySession.effectiveMode,'facts');
  assert.deepEqual(state.messages[0].meta.requestStudy.documentIds,['missing']);
  const next=await session.updateStudySession('fact-owner',thread,{queryMode:'facts',documentIds:[],scopeRevision:chosen.revision});
  await assert.rejects(tutor.sendTutor('fact-owner',thread,'facts-request-0000001','现在什么时候截止？',[],false,'',undefined,next),/请求标识/);
 }finally{kernel.selectedStudyDocuments=saved.selected;kernel.answerCourseFacts=saved.facts;kernel.answerStudyContent=saved.answer;globalThis.fetch=saved.fetch;}
});
test('document request cannot broaden an empty selection, and changed scope excludes old conversation evidence',async()=>{
 const saved={selected:kernel.selectedStudyDocuments,answer:kernel.answerStudyContent,counts:kernel.documentRoutingCounts};
 const calls:{options:Parameters<typeof kernel.answerStudyContent>[2];policy:Parameters<typeof kernel.answerStudyContent>[3]}[]=[];
 kernel.selectedStudyDocuments=async(_owner,ids)=>selected(ids);
 kernel.documentRoutingCounts=async()=>({eligibleDocuments:2,routedDocuments:1,eligiblePages:2,routedPages:1});
 kernel.answerStudyContent=async(_owner,_q,options,policy)=>{calls.push({options,policy});return {answer:{status:'insufficient-evidence',message:'Fixture boundary only',claims:[]},
  selectedUnits:[],sourceDocuments:[],warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:'gpt-5-mini'} as unknown as Awaited<ReturnType<typeof kernel.answerStudyContent>>;};
 try{
  const thread=await tutor.createTutorThread('doc-owner','');
  const initial=await session.readStudySession('doc-owner',thread);
  await assert.rejects(tutor.sendTutor('doc-owner',thread,'empty-selection-0001','解释这个概念',[],false,'',undefined,initial),/选择 PDF/);
  const first=await session.updateStudySession('doc-owner',thread,{queryMode:'document',documentIds:['pdf-a'],scopeRevision:0});
  await tutor.sendTutor('doc-owner',thread,'document-scope-00001','解释第一个概念',[],false,'',undefined,first);
  const second=await session.updateStudySession('doc-owner',thread,{queryMode:'document',documentIds:['pdf-b'],scopeRevision:first.revision});
  await tutor.sendTutor('doc-owner',thread,'document-scope-00002','继续解释',[],false,'',undefined,second);
  assert.deepEqual(calls.at(-1)!.options!.routingScope,{documentIds:['pdf-b']});
  assert.deepEqual(calls.at(-1)!.policy!.conversation,[]);
  assert.equal(calls.at(-1)!.options!.courseId,undefined);
 }finally{kernel.selectedStudyDocuments=saved.selected;kernel.answerStudyContent=saved.answer;kernel.documentRoutingCounts=saved.counts;}
});
