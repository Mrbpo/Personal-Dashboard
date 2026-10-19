import {test} from 'node:test';import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='fixture-never-sent';
const {kernel}=await import('../lib/kernel/service.ts'),tutor=await import('../lib/tutor.ts'),
 {studyCourseRouting}=await import('../lib/study-answer.ts');

test('opt-in literal course routing reaches shared Kernel scope without persisting one course',async()=>{
 const names=['STUDY_ANSWER_BACKEND','STUDY_COURSE_ROUTING','OPENAI_MODEL','STUDY_SOURCE_SCOPE','STUDY_CITATION_CHECK','STUDY_SOURCE_VALUES','STUDY_SOURCE_QUANTITIES','STUDY_TEXT_CONTEXT_WINDOWS'] as const,
  env=Object.fromEntries(names.map(n=>[n,process.env[n]])),saved={courses:kernel.listCourses,counts:kernel.documentRoutingCounts,unmapped:kernel.hasUnmappedCourseDocuments,answer:kernel.answerStudyContent,fetch:globalThis.fetch};
 const calls:any[]=[];let catalogCalls=0,providerCalls=0,unmapped=false;
 const courses=[{id:'chem-fall',code:'CHMA10H3',name:'Chemistry',enabled:true},
  {id:'chem-spring',code:'CHMA10H3',name:'Chemistry',enabled:true},{id:'stats',code:'STAB22H3',name:'Statistics',enabled:true}];
 try{
  assert.equal(studyCourseRouting('off'),undefined);assert.throws(()=>studyCourseRouting('anything'),(e:any)=>e.code==='invalid-course-routing');
  process.env.STUDY_ANSWER_BACKEND='kernel';process.env.STUDY_COURSE_ROUTING='explicit-codes-v1';process.env.OPENAI_MODEL='gpt-5.4-mini';
  for(const name of names.slice(3))process.env[name]='off';
  kernel.listCourses=async()=>{catalogCalls++;return courses as any;};
  kernel.documentRoutingCounts=async()=>({eligibleDocuments:5,routedDocuments:3,eligiblePages:5,routedPages:3});
  kernel.hasUnmappedCourseDocuments=async(owner,ids)=>{assert.equal(owner,'route-owner');assert.deepEqual([...ids].sort(),['chem-fall','chem-spring','stats']);return unmapped;};
  kernel.answerStudyContent=async(owner,question,options)=>{calls.push({owner,question,options});return {
   answer:{status:'insufficient-evidence',message:'Synthetic fixture only.',claims:[]},selectedUnits:[],sourceDocuments:[],
   warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:'gpt-5.4-mini'} as any;};
  globalThis.fetch=async()=>{providerCalls++;throw Error('Course routing forbids provider calls');};
  const id=await tutor.createTutorThread('route-owner',''),question='Compare CHMA10 and STAB22 syllabus requirements';
  await tutor.sendTutor('route-owner',id,'course-multi-request-01',question,[],false);
  assert.deepEqual(calls[0].options.routingScope.courseIds,['chem-fall','chem-spring','stats']);
  let state=await tutor.tutorState('route-owner',id);assert.equal(state.threads.find(t=>t.id===id)?.course_id,'');
  assert.equal(state.messages[1].meta.study.courseRouting.status,'resolved');
  await tutor.sendTutor('route-owner',id,'course-followup-000001','What are their assignment requirements?',[],false);
  assert.deepEqual(calls[1].options.routingScope.courseIds,calls[0].options.routingScope.courseIds);
  state=await tutor.tutorState('route-owner',id);assert.equal(state.messages[3].meta.study.courseRouting.inputOrigin,'successful-history');
  await tutor.sendTutor('route-owner',id,'course-replace-0000001','STAB22 assignments',[],false);
  assert.deepEqual(calls[2].options.routingScope.courseIds,['stats']);
  const before=catalogCalls;
  await tutor.sendTutor('route-owner',id,'course-explicit-000001','CHMA10 assignments',[],false,'',{courseIds:['stats']});
  assert.equal(catalogCalls,before);assert.deepEqual(calls[3].options.routingScope.courseIds,['stats']);
  await tutor.sendTutor('route-owner',id,'course-broad-request01','Compare all courses syllabus requirements',[],false);
  assert.equal(calls[4].options.routingScope,undefined);
  unmapped=true;
  await tutor.sendTutor('route-owner',id,'course-unmapped-000001','STAB22 assignments',[],false);
  assert.equal(calls[5].options.routingScope,undefined,'unassigned content must retain broad retrieval');
  state=await tutor.tutorState('route-owner',id);
  assert.equal(state.messages.at(-1)!.meta.study.courseRouting.fallbackReason,'unassigned-or-unmapped-source');
  assert.equal(state.messages.at(-1)!.meta.study.courseRouting.scopeApplied,false);
  await assert.rejects(tutor.sendTutor('route-owner',id,'course-prefix-request1','CHMA100 assignment',[],false),(e:any)=>e.code==='course-scope-ambiguous');
  await assert.rejects(tutor.sendTutor('route-owner',id,'course-multi-request-01','A changed question',[],false),(e:any)=>e.code==='idempotency-scope-conflict');
  assert.equal(calls.length,6);assert.equal(providerCalls,0);
 }finally{
  kernel.listCourses=saved.courses;kernel.documentRoutingCounts=saved.counts;kernel.hasUnmappedCourseDocuments=saved.unmapped;kernel.answerStudyContent=saved.answer;globalThis.fetch=saved.fetch;
  for(const name of names){if(env[name]===undefined)delete process.env[name];else process.env[name]=env[name];}
 }
});
