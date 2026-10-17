import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.OPENAI_API_KEY='test-key-never-sent';
const {kernel}=await import('../lib/kernel/service.ts');
const {studyAnswerBackend,answerKernelStudy,StudyAnswerError}=await import('../lib/study-answer.ts');
const {documentAnswerSettings}=await import('../lib/kernel/document-answer.ts');
const tutor=await import('../lib/tutor.ts');

test('legacy is the default, invalid configuration fails closed and application policy stays bounded',async()=>{
 assert.equal(studyAnswerBackend('legacy'),'legacy');assert.equal(studyAnswerBackend('kernel'),'kernel');
 assert.throws(()=>studyAnswerBackend('typo'),StudyAnswerError);
 await assert.rejects(documentAnswerSettings({scope:'application',model:'gpt-6-astra'}),/bounded mini/);
 await assert.rejects(documentAnswerSettings({scope:'application',maxOutputTokens:9000}),/bounded mini/);
 assert.equal((await documentAnswerSettings({scope:'application',model:'gpt-5.4-mini',maxOutputTokens:3000})).model,'gpt-5.4-mini');
});

test('kernel tutor shares current-source references, preserves ownership and request idempotency without legacy calls',async()=>{
 const saved={backend:process.env.STUDY_ANSWER_BACKEND,model:process.env.OPENAI_MODEL},answer=kernel.answerStudyContent,courses=kernel.listCourses,fetch=globalThis.fetch;
 process.env.STUDY_ANSWER_BACKEND='kernel';process.env.OPENAI_MODEL='gpt-5.4-mini';
 let calls=0,legacyCalls=0,actual:any;
 globalThis.fetch=async()=>{legacyCalls++;throw Error('No legacy provider should be called');};
 kernel.listCourses=async()=>[];
 kernel.answerStudyContent=async(owner,question,options,policy)=>{
  calls++;actual={owner,question,options,policy};
  return {answer:{status:'answered',message:'',claims:[{text:'The measured value is 42.',citations:[{id:'e0',quote:'Measured 42.'}]}]},
   selectedUnits:[{claimIndex:0,citationIndex:0,selectionId:'q0',kind:'text',evidence:{id:'e0',kind:'text',documentId:'doc',documentVersionId:'v1',sourceVersionId:'sv1',sourceHash:'hash',evidenceId:'evidence',locator:'p2',sha256:'bodyhash'},startUtf16:0,endUtf16:12,quoteSha256:'quotehash'}],
   sourceDocuments:[{documentId:'doc',name:'Original notes'}],warnings:[],textEvidenceCount:1,imageEvidenceCount:0,model:'gpt-5.4-mini',
   inputFingerprint:'fp',providerRequestSha256:'request',promptVersion:'p',referencePolicyVersion:'r',providerResponseId:'response',usage:{input_tokens:10,output_tokens:5}} as any;
 };
 try{
  const id=await tutor.createTutorThread('alice','');
  await tutor.sendTutor('alice',id,'kernel-first-request01','What value is measured?',[],false);
  await tutor.sendTutor('alice',id,'kernel-first-request01','What value is measured?',[],false);
  assert.equal(calls,1);assert.equal(legacyCalls,0);assert.equal(actual.owner,'alice');
  assert.equal(actual.policy.scope,'application');assert.equal(actual.policy.model,'gpt-5.4-mini');
  assert.equal(actual.options.includeImages,true);assert.equal(actual.options.relatedDocuments,true);
  const state=await tutor.tutorState('alice',id),message=state.messages[1];
  assert.match(message.body,/42.*\[S1\]/);assert.equal(message.meta.citations[0].title,'Original notes · p2');
  assert.equal(message.meta.citations[0].evidence.documentVersionId,'v1');assert.equal(message.meta.study.semanticVerified,false);
  await assert.rejects(tutor.sendTutor('bob',id,'kernel-other-request01','Read it',[],false),/会话不存在/);
  await tutor.sendTutor('alice',id,'kernel-next-request001','And what does it mean?',[],false);
  assert.ok(actual.policy.conversation.some((m:any)=>m.role==='assistant'));
  kernel.answerStudyContent=async()=>{throw Error('retrieval broke');};
  await assert.rejects(answerKernelStudy('alice','Question','',[]),(e:any)=>e.stage==='retrieval');
  assert.equal(legacyCalls,0);
 }finally{
  kernel.answerStudyContent=answer;kernel.listCourses=courses;globalThis.fetch=fetch;
  for(const [name,value]of Object.entries({STUDY_ANSWER_BACKEND:saved.backend,OPENAI_MODEL:saved.model}))if(value===undefined)delete process.env[name];else process.env[name]=value;
 }
});
