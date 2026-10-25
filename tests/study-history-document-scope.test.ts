import {test} from 'node:test';import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='fixture-never-sent';
const {kernel}=await import('../lib/kernel/service.ts'),tutor=await import('../lib/tutor.ts');

test('current document identities supersede inferred course history without overriding explicit restrictions',async()=>{
 const keys=['STUDY_ANSWER_BACKEND','STUDY_COURSE_ROUTING','OPENAI_MODEL','STUDY_SOURCE_SCOPE','STUDY_CITATION_CHECK',
  'STUDY_SOURCE_VALUES','STUDY_SOURCE_QUANTITIES','STUDY_TEXT_CONTEXT_WINDOWS'] as const,
  env=Object.fromEntries(keys.map(k=>[k,process.env[k]])),saved={courses:kernel.listCourses,counts:kernel.documentRoutingCounts,
   unmapped:kernel.hasUnmappedCourseDocuments,find:kernel.findMentionedDocumentSources,answer:kernel.answerStudyContent,fetch:globalThis.fetch};
 const sources=[{documentId:'paper-a',title:'Independent Evaluation Methods.pdf',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:'h1'},
  {documentId:'paper-b',title:'Reliable Inference Experiments.pdf',currentVersionId:'v2',sourceVersionId:'s2',sourceHash:'h2'}],
  scope={excludedCourseIds:['stats'],origins:['upload']},calls:any[]=[];
 let lookups=0,unique=true,request=0;
 try{
  process.env.STUDY_ANSWER_BACKEND='kernel';process.env.STUDY_COURSE_ROUTING='explicit-codes-v1';process.env.OPENAI_MODEL='gpt-5.4-mini';
  for(const k of keys.slice(3))process.env[k]='off';
  kernel.listCourses=async()=>[{id:'chem',code:'CHMA10H3',enabled:true},{id:'math',code:'MATA29H3',enabled:true},
   {id:'stats',code:'STAB22H3',enabled:true}] as any;
  kernel.documentRoutingCounts=async()=>({eligibleDocuments:3,routedDocuments:3,eligiblePages:3,routedPages:3});
  kernel.hasUnmappedCourseDocuments=async()=>false;
  kernel.findMentionedDocumentSources=async(_owner,question)=>{lookups++;return question.includes(sources[0].title)?
   {status:'ambiguous',matches:sources,...(unique?{uniqueTitleSources:sources}:{})}:{status:'not-mentioned',matches:[]};};
  kernel.answerStudyContent=async(owner,question,options)=>{calls.push({owner,question,options});return {
   answer:{status:'insufficient-evidence',message:'Boundary fixture only.',claims:[]},selectedUnits:[],sourceDocuments:[],
   warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:'gpt-5.4-mini'} as any;};
  globalThis.fetch=async()=>{throw Error('No model calls permitted');};
  const id=await tutor.createTutorThread('history-owner',''),send=(q:string)=>tutor.sendTutor('history-owner',id,
   'history-scope-request-'+(++request),q,[],false,'',scope),seed=()=>send('CHMA10 syllabus requirements');
  await seed();assert.deepEqual(calls.at(-1).options.routingScope,{...scope,courseIds:['chem']});
  const before=lookups,question=`比较这两篇论文《${sources[0].title}》和《${sources[1].title}》的实验。`;
  await send(question);assert.deepEqual(calls.at(-1).options.routingScope,scope,'a new named-document topic must not inherit the earlier chemistry filter');
  assert.equal(lookups-before,1,'current metadata is read only once despite the history and keyword guards');
  let state=await tutor.tutorState('history-owner',id),meta=state.messages.at(-1)!.meta.study;
  assert.equal(meta.courseRouting.status,'none');assert.equal(meta.courseRouting.inputOrigin,undefined);
  assert.deepEqual(meta.documentAttribution.sources,sources);assert.equal(state.threads.find(t=>t.id===id)?.course_id,'');
  await seed();unique=false;const count=calls.length;await assert.rejects(send(question),(e:any)=>e.code==='course-scope-ambiguous');
  assert.equal(calls.length,count,'ambiguous document identities cannot silently fall back to the historical course');unique=true;
  await seed();await send('What are their assignment requirements?');
  assert.deepEqual(calls.at(-1).options.routingScope,{...scope,courseIds:['chem']});
  state=await tutor.tutorState('history-owner',id);assert.equal(state.messages.at(-1)!.meta.study.courseRouting.inputOrigin,'successful-history');
  const literalBefore=lookups;await send('MATA29 assignment '+question);
  assert.deepEqual(calls.at(-1).options.routingScope,{...scope,courseIds:['math']});assert.equal(lookups,literalBefore,'explicit current course remains authoritative');
  await assert.rejects(send('CHMA100 assignment '+question),(e:any)=>e.code==='course-scope-ambiguous');assert.equal(lookups,literalBefore);
 }finally{
  kernel.listCourses=saved.courses;kernel.documentRoutingCounts=saved.counts;kernel.hasUnmappedCourseDocuments=saved.unmapped;
  kernel.findMentionedDocumentSources=saved.find;kernel.answerStudyContent=saved.answer;globalThis.fetch=saved.fetch;
  for(const k of keys){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}
 }
});
