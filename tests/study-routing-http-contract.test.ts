import {test} from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='fixture-key-never-sent';
const {kernel}=await import('../lib/kernel/service.ts');
const {studyRoutingScope,studyRoutingScopeWitness,StudyAnswerError}=await import('../lib/study-answer.ts');
const tutor=await import('../lib/tutor.ts');

test('scope DTO rejects malformed/legacy requests and canonicalizes equivalent JSON/form sets',()=>{
 const old=process.env.STUDY_ANSWER_BACKEND;
 try{
  process.env.STUDY_ANSWER_BACKEND='kernel';
  const a=studyRoutingScope({documentIds:['B','A','A']}),b=studyRoutingScope('{"documentIds":["A","B"]}',true);
  assert.deepEqual(a,b);assert.equal(studyRoutingScopeWitness(a)?.fingerprint,studyRoutingScopeWitness(b)?.fingerprint);
  assert.deepEqual(a?.documentIds,['A','B']);assert.equal(studyRoutingScope(undefined),undefined);assert.equal(studyRoutingScope(null,true),undefined);
  for(const value of [null,{topic:['guessed']},{origins:'canvas'}])assert.throws(()=>studyRoutingScope(value),(e:any)=>e.code==='invalid-routing-scope');
  assert.throws(()=>studyRoutingScope('not-json',true),(e:any)=>e.code==='invalid-routing-scope');
  process.env.STUDY_ANSWER_BACKEND='legacy';assert.equal(studyRoutingScope(undefined),undefined);
  assert.throws(()=>studyRoutingScope({documentIds:['A']}),(e:any)=>e instanceof StudyAnswerError&&e.stage==='configuration'&&e.code==='routing-requires-kernel');
 }finally{if(old===undefined)delete process.env.STUDY_ANSWER_BACKEND;else process.env.STUDY_ANSWER_BACKEND=old;}
});

test('shared sender binds scope to completed request identity and preserves explicit multi-course intent',async()=>{
 const names=['STUDY_ANSWER_BACKEND','OPENAI_MODEL','STUDY_SOURCE_SCOPE','STUDY_CITATION_CHECK','STUDY_SOURCE_VALUES','STUDY_SOURCE_QUANTITIES','STUDY_TEXT_CONTEXT_WINDOWS'] as const,
  env=Object.fromEntries(names.map(name=>[name,process.env[name]])),saved={answer:kernel.answerStudyContent,counts:kernel.documentRoutingCounts,courses:kernel.listCourses,fetch:globalThis.fetch};
 let answerCalls=0,countCalls=0,providerCalls=0,actual:any;
 try{
  process.env.STUDY_ANSWER_BACKEND='kernel';process.env.OPENAI_MODEL='gpt-5.4-mini';
  for(const name of names.slice(2))process.env[name]='off';
  globalThis.fetch=async()=>{providerCalls++;throw Error('Scope contract fixture forbids provider calls');};
  kernel.listCourses=async()=>{throw Error('Explicit multi-course scope must not guess or persist one course');};
  kernel.documentRoutingCounts=async(owner,scope)=>{countCalls++;assert.equal(owner,'scope-owner');assert.deepEqual(scope?.routingScope?.courseIds,['A','B']);
   return {eligibleDocuments:4,routedDocuments:2,eligiblePages:4,routedPages:2};};
  kernel.answerStudyContent=async(owner,question,options)=>{answerCalls++;actual={owner,question,options};
   return {answer:{status:'insufficient-evidence',message:'Synthetic contract response.',claims:[]},selectedUnits:[],sourceDocuments:[],
    warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:'gpt-5.4-mini'} as any;};
  const id=await tutor.createTutorThread('scope-owner',''),question='Compare the syllabus requirements',requestId='scoped-request-000001';
  await tutor.sendTutor('scope-owner',id,requestId,question,[],false,'',{courseIds:['B','A']});
  await tutor.sendTutor('scope-owner',id,requestId,question,[],false,'',{courseIds:['A','B','A']});
  assert.equal(answerCalls,1);assert.equal(countCalls,1);assert.deepEqual(actual.options.routingScope.courseIds,['A','B']);assert.equal(actual.options.courseId,undefined);
  const state=await tutor.tutorState('scope-owner',id),user=state.messages[0],reply=state.messages[1];
  assert.equal(state.threads.find(t=>t.id===id)?.course_id,'');
  assert.equal(user.meta.requestRouting.fingerprint,reply.meta.study.explicitRouting.fingerprint);
  assert.equal(reply.meta.study.explicitRouting.phase,'before-retrieval');
  assert.equal(reply.meta.study.explicitRouting.candidateCounts.routedDocuments,2);
  assert.equal(reply.meta.study.semanticVerified,false);
  for(const [q,scope]of [[question,{courseIds:['A']}],['A changed question',{courseIds:['A','B']}],[question,undefined]] as const)
   await assert.rejects(tutor.sendTutor('scope-owner',id,requestId,q,[],false,'',scope),
    (e:any)=>e instanceof StudyAnswerError&&e.code==='idempotency-scope-conflict');
  await assert.rejects(tutor.sendTutor('other-owner',id,'scoped-other-0000001',question,[],false,'',{courseIds:['A','B']}),/会话不存在/);
  assert.equal(answerCalls,1);assert.equal(countCalls,1);assert.equal(providerCalls,0);
 }finally{
  kernel.answerStudyContent=saved.answer;kernel.documentRoutingCounts=saved.counts;kernel.listCourses=saved.courses;globalThis.fetch=saved.fetch;
  for(const name of names){if(env[name]===undefined)delete process.env[name];else process.env[name]=env[name];}
 }
});
