import {test} from 'node:test';import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='fixture-never-sent';
const {kernel}=await import('../lib/kernel/service.ts'),tutor=await import('../lib/tutor.ts');

test('a unique current document resolves academic keyword false positives without becoming a course or document filter',async()=>{
 const names=['STUDY_ANSWER_BACKEND','STUDY_COURSE_ROUTING','OPENAI_MODEL','STUDY_SOURCE_SCOPE','STUDY_CITATION_CHECK','STUDY_SOURCE_VALUES','STUDY_SOURCE_QUANTITIES','STUDY_TEXT_CONTEXT_WINDOWS'] as const,
  env=Object.fromEntries(names.map(n=>[n,process.env[n]])),saved={courses:kernel.listCourses,counts:kernel.documentRoutingCounts,
   find:kernel.findMentionedDocumentSources,answer:kernel.answerStudyContent,fetch:globalThis.fetch};
 const source={documentId:'paper-a',title:'Independent Evaluation Methods.pdf',currentVersionId:'v1',sourceVersionId:'sv1',sourceHash:'hash1'},
  calls:any[]=[],lookups:any[]=[];let status:'resolved'|'ambiguous'|'not-mentioned'='resolved',providerCalls=0;
 try{
  process.env.STUDY_ANSWER_BACKEND='kernel';process.env.OPENAI_MODEL='gpt-5.4-mini';for(const n of names.slice(3))process.env[n]='off';
  kernel.listCourses=async()=>[{id:'chem',code:'CHMA10H3',name:'Chemistry',enabled:true},{id:'stats',code:'STAB22H3',name:'Statistics',enabled:true}] as any;
  kernel.documentRoutingCounts=async()=>({eligibleDocuments:3,routedDocuments:3,eligiblePages:3,routedPages:3});
  kernel.findMentionedDocumentSources=async(owner,question,options)=>{lookups.push({owner,question,options});return {
   status,matches:status==='resolved'?[source]:status==='ambiguous'?[source,{...source,documentId:'paper-b'}]:[]};};
  kernel.answerStudyContent=async(owner,question,options)=>{calls.push({owner,question,options});return {
   answer:{status:'insufficient-evidence',message:'Synthetic wiring only.',claims:[]},selectedUnits:[],sourceDocuments:[],
   warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:'gpt-5.4-mini'} as any;};
  globalThis.fetch=async()=>{providerCalls++;throw Error('Fixture forbids provider calls');};
  const question='关于论文《Independent Evaluation Methods》，What is the practice exam metric?',scope={excludedCourseIds:['stats'],origins:['upload'] as const};
  for(const mode of ['off','explicit-codes-v1']){
   process.env.STUDY_COURSE_ROUTING=mode;
   const id=await tutor.createTutorThread('document-owner','');
   await tutor.sendTutor('document-owner',id,'document-question-'+mode,question,[],false,'',{...scope,origins:[...scope.origins]});
   assert.equal(calls.at(-1).owner,'document-owner');assert.equal(calls.at(-1).question,question);
   assert.deepEqual(calls.at(-1).options.routingScope,scope);assert.equal(calls.at(-1).options.courseId,undefined);
   assert.deepEqual(lookups.at(-1),{owner:'document-owner',question,options:{routingScope:scope}});
   const state=await tutor.tutorState('document-owner',id);assert.equal(state.threads.find(t=>t.id===id)?.course_id,'');
   assert.deepEqual(state.messages.at(-1)!.meta.study.documentAttribution,{policy:'unique-mentioned-document-before-course-guard-v1',
    source,courseOwnershipVerified:false,scopeApplied:false});
   for(const ambiguous of ['not-mentioned','ambiguous'] as const){
    status=ambiguous;await assert.rejects(tutor.sendTutor('document-owner',id,'missing-document-'+mode+ambiguous,question,[],false),
     (e:any)=>e.code==='course-scope-ambiguous');
   }
   status='resolved';const n=lookups.length;
   await assert.rejects(tutor.sendTutor('document-owner',id,'unknown-course-'+mode,'CHMA100 assignment in Independent Evaluation Methods',[],false),
    (e:any)=>e.code==='course-scope-ambiguous');assert.equal(lookups.length,n,'unknown explicit course must not be rescued by a title');
  }
  assert.equal(calls.length,2);assert.equal(providerCalls,0);
 }finally{
  kernel.listCourses=saved.courses;kernel.documentRoutingCounts=saved.counts;kernel.findMentionedDocumentSources=saved.find;
  kernel.answerStudyContent=saved.answer;globalThis.fetch=saved.fetch;
  for(const n of names){if(env[n]===undefined)delete process.env[n];else process.env[n]=env[n];}
 }
});

test('independently named documents can compare experiments without choosing a course or narrowing caller scope',async()=>{
 const names=['STUDY_ANSWER_BACKEND','STUDY_COURSE_ROUTING','OPENAI_MODEL','STUDY_SOURCE_SCOPE','STUDY_CITATION_CHECK',
  'STUDY_SOURCE_VALUES','STUDY_SOURCE_QUANTITIES','STUDY_TEXT_CONTEXT_WINDOWS'] as const,
  env=Object.fromEntries(names.map(n=>[n,process.env[n]])),saved={courses:kernel.listCourses,counts:kernel.documentRoutingCounts,
   find:kernel.findMentionedDocumentSources,answer:kernel.answerStudyContent,fetch:globalThis.fetch};
 const sources=[{documentId:'paper-a',title:'Independent Evaluation Methods.pdf',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:'h1'},
  {documentId:'paper-b',title:'Reliable Inference Experiments.pdf',currentVersionId:'v2',sourceVersionId:'s2',sourceHash:'h2'}],
  scope={excludedCourseIds:['stats'],origins:['upload']},calls:any[]=[];
 let unique=true,lookups=0;
 try{
  process.env.STUDY_ANSWER_BACKEND='kernel';process.env.OPENAI_MODEL='gpt-5.4-mini';for(const n of names.slice(3))process.env[n]='off';
  kernel.listCourses=async()=>[{id:'chem',code:'CHMA10H3',name:'Chemistry',enabled:true},{id:'stats',code:'STAB22H3',name:'Statistics',enabled:true}] as any;
  kernel.documentRoutingCounts=async()=>({eligibleDocuments:3,routedDocuments:3,eligiblePages:3,routedPages:3});
  kernel.findMentionedDocumentSources=async()=>{lookups++;return {status:'ambiguous',matches:sources,
   ...(unique?{uniqueTitleSources:sources}:{})};};
  kernel.answerStudyContent=async(owner,question,options)=>{calls.push({owner,question,options});return {
   answer:{status:'insufficient-evidence',message:'Synthetic wiring only.',claims:[]},selectedUnits:[],sourceDocuments:[],
   warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:'gpt-5.4-mini'} as any;};
  globalThis.fetch=async()=>{throw Error('No provider calls in course-entry boundary check');};
  const question=`对比《${sources[0].title}》和《${sources[1].title}》的实验内容。`;
  for(const mode of ['off','explicit-codes-v1']){
   process.env.STUDY_COURSE_ROUTING=mode;const id=await tutor.createTutorThread('multi-owner','');
   await tutor.sendTutor('multi-owner',id,'multi-document-title-'+mode,question,[],false,'',scope);
   const call=calls.at(-1);assert.equal(call.owner,'multi-owner');assert.equal(call.question,question);
   assert.deepEqual(call.options.routingScope,scope);assert.equal(call.options.courseId,undefined);
   assert.equal(call.options.documentId,undefined);assert.equal(call.options.sourceHint,undefined);
   const state=await tutor.tutorState('multi-owner',id);assert.equal(state.threads.find(t=>t.id===id)?.course_id,'');
   assert.deepEqual(state.messages.at(-1)!.meta.study.documentAttribution,{policy:'multiple-mentioned-documents-before-course-guard-v1',
    sources,courseOwnershipVerified:false,scopeApplied:false});
   unique=false;await assert.rejects(tutor.sendTutor('multi-owner',id,'duplicate-document-title-'+mode,question,[],false,'',scope),
    (e:any)=>e.code==='course-scope-ambiguous');unique=true;
   const before=lookups;await assert.rejects(tutor.sendTutor('multi-owner',id,'unknown-course-title-'+mode,'CHMA100 assignment '+question,[],false,'',scope),
    (e:any)=>e.code==='course-scope-ambiguous');assert.equal(lookups,before,'unknown literal course is still rejected before title rescue');
  }
  assert.equal(calls.length,2);
 }finally{
  kernel.listCourses=saved.courses;kernel.documentRoutingCounts=saved.counts;kernel.findMentionedDocumentSources=saved.find;
  kernel.answerStudyContent=saved.answer;globalThis.fetch=saved.fetch;
  for(const n of names){if(env[n]===undefined)delete process.env[n];else process.env[n]=env[n];}
 }
});
