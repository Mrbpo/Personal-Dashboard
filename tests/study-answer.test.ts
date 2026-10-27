import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.OPENAI_API_KEY='test-key-never-sent';
const {kernel}=await import('../lib/kernel/service.ts');
const {studyAnswerBackend,studyEvidenceSelection,studyCitationCheck,studySourceScope,studyQuantityConsistency,studyGenerationReasoning,studyGenerationOutputTokens,studyGenerationVerbosity,studySourceIdentityContext,studyDevelopmentDailyLimit,answerKernelStudy,StudyAnswerError}=await import('../lib/study-answer.ts');
const {documentAnswerSettings,DocumentModelResponseError}=await import('../lib/kernel/document-answer.ts');
const tutor=await import('../lib/tutor.ts');
const {SourceValueHeaderError}=await import('../lib/kernel/document-source-values.ts');

test('source-text citation configuration reaches Kernel and publishes an explicit manifest-bound view URL',async()=>{
 const {studySourceTextCitations}=await import('../lib/study-answer.ts');
 assert.equal(studySourceTextCitations('off'),undefined);assert.equal(studySourceTextCitations('current-source-view-v1'),'current-source-view-v1');
 assert.throws(()=>studySourceTextCitations('guess'),StudyAnswerError);
 const values={STUDY_SOURCE_TEXT_CITATIONS:'current-source-view-v1',STUDY_ANSWER_BACKEND:'kernel',STUDY_EVIDENCE_SELECTION:'select-then-answer',
  STUDY_CITATION_CHECK:'selected-once',STUDY_SOURCE_VALUES:'off',STUDY_SOURCE_QUANTITIES:'off',STUDY_SCOPE_ANNOTATIONS:'off',
  STUDY_SOURCE_SCOPE:'off',OPENAI_MODEL:'gpt-5.4-mini',STUDY_CITATION_TRACE_DIR:`${process.cwd()}/data/source-text-fixture-never-written`},
  env=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;
 let calls=0;
 try{
  Object.assign(process.env,values);
  kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{calls++;assert.equal(policy?.sourceTextCitations,'current-source-view-v1');await documentAnswerSettings(policy);
   const evidence={kind:'source-text',documentId:'real-doc',documentVersionId:'version',sourceVersionId:'sv',sourceHash:'hash',scope:'current-persisted-text-v1',
    locator:'all-current-stored-text',manifestSha256:'a'.repeat(64),viewSha256:'b'.repeat(64),sourceNodeCount:4};
   return {answer:{status:'answered',message:'',claims:[{text:'A text-scope conclusion.',citations:[]}]},selectedUnits:[{claimIndex:0,citationIndex:0,evidence}],
    sourceDocuments:[{documentId:'real-doc',name:'Scope.pdf'}],warnings:[],textEvidenceCount:4,imageEvidenceCount:0,model:null} as unknown as Awaited<ReturnType<typeof saved>>;};
  const result=await answerKernelStudy('owner','Synthetic source-scope question','',[]),url=new URL(result.citations[0].url,'http://test');
  assert.equal(url.pathname,'/api/library/real-doc');assert.equal(url.searchParams.get('scope'),'current-persisted-text-v1');
  assert.equal(url.searchParams.get('manifest'),'a'.repeat(64));assert.equal(url.searchParams.get('sourceVersion'),'sv');
  assert.equal(url.searchParams.has('evidenceId'),false);assert.equal(url.searchParams.has('snapshot'),false);assert.equal(result.answer,'A text-scope conclusion. [S1]');
  process.env.STUDY_EVIDENCE_SELECTION='single-pass';
  await assert.rejects(answerKernelStudy('owner','Synthetic question','',[]),(e:unknown)=>e instanceof StudyAnswerError&&e.code==='source-text-citations-require-selection-check');
  assert.equal(calls,1);
 }finally{kernel.answerStudyContent=saved;for(const[k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
test('literal scope output is opt-in, reaches the application policy and rejects specialized contracts',async()=>{
 const {studyScopeAnnotations}=await import('../lib/study-answer.ts');
 assert.equal(studyScopeAnnotations('off'),undefined);assert.equal(studyScopeAnnotations('literal-source-v1'),'literal-source-v1');
 assert.throws(()=>studyScopeAnnotations('guess'),/适用范围原文配置无效/);
 const values={STUDY_SCOPE_ANNOTATIONS:'literal-source-v1',STUDY_ANSWER_BACKEND:'kernel',STUDY_EVIDENCE_SELECTION:'select-then-answer',
  STUDY_CITATION_CHECK:'selected-once',STUDY_SOURCE_VALUES:'off',STUDY_SOURCE_QUANTITIES:'off',OPENAI_MODEL:'gpt-5.4-mini',
  STUDY_CITATION_TRACE_DIR:`${process.cwd()}/data/scope-fixture-never-written`};
 const env=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;let calls=0;
 try{
  Object.assign(process.env,values);
  kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{calls++;assert.equal(policy?.scopeAnnotations,'literal-source-v1');await documentAnswerSettings(policy);
   return {answer:{status:'insufficient-evidence',message:'Fixture.',claims:[]},selectedUnits:[],sourceDocuments:[],warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:null} as unknown as Awaited<ReturnType<typeof saved>>;};
  await answerKernelStudy('owner','Synthetic scoped question','',[]);assert.equal(calls,1);
  process.env.STUDY_SOURCE_VALUES='difference-v1';
  await assert.rejects(answerKernelStudy('owner','Synthetic scoped question','',[]),(e:unknown)=>e instanceof StudyAnswerError&&e.code==='scope-annotations-require-ordinary-selection-check');assert.equal(calls,1);
 }finally{kernel.answerStudyContent=saved;for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('application accepts both source contracts together and preserves the shared bounded policy',async()=>{
 const values={STUDY_ANSWER_BACKEND:'kernel',STUDY_EVIDENCE_SELECTION:'select-then-answer',STUDY_CITATION_CHECK:'selected-once',
  STUDY_SOURCE_VALUES:'difference-v1',STUDY_SOURCE_QUANTITIES:'bound-value-v1',STUDY_SOURCE_SCOPE:'off',
  STUDY_TEXT_CONTEXT_WINDOWS:'off',OPENAI_MODEL:'gpt-5.4-mini',STUDY_CITATION_TRACE_DIR:`${process.cwd()}/data/contract-fixture-never-written`};
 const env=Object.fromEntries(Object.keys(values).concat('STUDY_DEVELOPMENT_DAILY_LIMIT').map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;
 let calls=0;
 try{
  Object.assign(process.env,values);delete process.env.STUDY_DEVELOPMENT_DAILY_LIMIT;
  kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{calls++;
   assert.equal(policy?.sourceValueContract,'difference-v1');assert.equal(policy?.sourceQuantityContract,'bound-value-v1');
   await documentAnswerSettings(policy);
   return {answer:{status:'insufficient-evidence',message:'Fixture.',claims:[]},selectedUnits:[],sourceDocuments:[],warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:null} as any;};
  await answerKernelStudy('owner','Synthetic arithmetic or scalar question','',[]);assert.equal(calls,1);
 }finally{kernel.answerStudyContent=saved;for(const [k,v] of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('source header argument failures are attributed to generation, not PDF parsing or citation validation',async()=>{
 const names=['STUDY_DEVELOPMENT_DAILY_LIMIT','STUDY_CITATION_CHECK','STUDY_SOURCE_VALUES','STUDY_SOURCE_SCOPE','STUDY_TEXT_CONTEXT_WINDOWS','OPENAI_MODEL'] as const,
  env=Object.fromEntries(names.map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;
 try{
  delete process.env.STUDY_DEVELOPMENT_DAILY_LIMIT;process.env.STUDY_CITATION_CHECK='off';process.env.STUDY_SOURCE_VALUES='off';
  process.env.STUDY_SOURCE_SCOPE='off';process.env.STUDY_TEXT_CONTEXT_WINDOWS='off';process.env.OPENAI_MODEL='gpt-5.4-mini';
  kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{policy?.onStage?.('citation-validation');throw new SourceValueHeaderError();};
  await assert.rejects(answerKernelStudy('owner','Synthetic header arguments','',[]),(e:any)=>e instanceof StudyAnswerError&&
   e.stage==='generation'&&e.code==='source-value-header-path-not-established'&&e.cause instanceof SourceValueHeaderError);
 }finally{kernel.answerStudyContent=saved;for(const k of names){if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k];}}
});

test('application preserves model completion failure code and active pipeline stage without retry',async()=>{
 const values={STUDY_DEVELOPMENT_DAILY_LIMIT:undefined,STUDY_CITATION_CHECK:'off',STUDY_SOURCE_VALUES:'off',
  STUDY_SOURCE_QUANTITIES:'off',STUDY_SOURCE_SCOPE:'off',STUDY_TEXT_CONTEXT_WINDOWS:'off',OPENAI_MODEL:'gpt-5.4-mini'},
  env=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;
 let calls=0;
 try{
  for(const [k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
  for(const [stage,limit]of [['evidence-selection',true],['generation',true],['generation',false]] as const){
   kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{calls++;policy?.onStage?.(stage);throw new DocumentModelResponseError(limit);};
   await assert.rejects(answerKernelStudy('owner','Synthetic incomplete-response fixture','',[]),(e:unknown)=>
    e instanceof StudyAnswerError&&e.stage===stage&&e.code===(limit?'model-output-limit':'model-response-incomplete')&&e.cause instanceof DocumentModelResponseError);
  }
  assert.equal(calls,3,'no automatic retry or fallback answer');
 }finally{kernel.answerStudyContent=saved;for(const [k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('application generation envelope is explicit, chain guarded and does not replace selector or timeout bounds',async()=>{
 assert.equal(studyGenerationOutputTokens('3000'),undefined);assert.equal(studyGenerationOutputTokens('6000'),6000);
 for(const v of ['','6001','12000','6000.0'])assert.throws(()=>studyGenerationOutputTokens(v),StudyAnswerError);
 const values={STUDY_GENERATION_OUTPUT_TOKENS:'6000',STUDY_ANSWER_BACKEND:'kernel',STUDY_DEVELOPMENT_DAILY_LIMIT:undefined,
  STUDY_EVIDENCE_SELECTION:'select-then-answer',STUDY_CITATION_CHECK:'selected-once',STUDY_SOURCE_VALUES:'off',
  STUDY_SOURCE_QUANTITIES:'off',STUDY_SOURCE_SCOPE:'off',STUDY_TEXT_CONTEXT_WINDOWS:'off',OPENAI_MODEL:'gpt-5.4-mini',
  STUDY_CITATION_TRACE_DIR:`${process.cwd()}/data/generation-output-fixture-never-written`},
  env=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;
 let calls=0;
 try{
  for(const [k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
  kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{calls++;
   assert.equal(policy?.generationOutputTokens,6000);assert.equal(policy?.maxOutputTokens,3000);assert.equal(policy?.timeoutMs,55000);
   policy?.onStage?.('generation');throw new DocumentModelResponseError(true);};
  await assert.rejects(answerKernelStudy('owner','Synthetic budget question','',[]),(e:any)=>e.code==='model-output-limit');
  process.env.STUDY_EVIDENCE_SELECTION='single-pass';
  await assert.rejects(answerKernelStudy('owner','Synthetic budget question','',[]),(e:any)=>e.code==='generation-output-requires-selection-check');
  assert.equal(calls,1);
 }finally{kernel.answerStudyContent=saved;for(const [k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('application generation verbosity is opt-in, recorded and rejects wrong chains before retrieval',async()=>{
 assert.equal(studyGenerationVerbosity('low'),undefined);assert.equal(studyGenerationVerbosity('medium'),'medium');
 for(const value of ['','high','MEDIUM'])assert.throws(()=>studyGenerationVerbosity(value),StudyAnswerError);
 const values={STUDY_GENERATION_VERBOSITY:'medium',STUDY_GENERATION_OUTPUT_TOKENS:undefined,STUDY_ANSWER_BACKEND:'kernel',
  STUDY_DEVELOPMENT_DAILY_LIMIT:undefined,STUDY_EVIDENCE_SELECTION:'select-then-answer',STUDY_CITATION_CHECK:'selected-once',
  STUDY_SOURCE_VALUES:'off',STUDY_SOURCE_QUANTITIES:'off',STUDY_SOURCE_SCOPE:'off',STUDY_TEXT_CONTEXT_WINDOWS:'off',
  OPENAI_MODEL:'gpt-5.4-mini',STUDY_CITATION_TRACE_DIR:`${process.cwd()}/data/verbosity-fixture-never-written`},
  env=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;
 let calls=0;
 try{
  for(const [k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
  kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{calls++;
   assert.equal(policy?.generationVerbosity,'medium');await documentAnswerSettings(policy);
   return {answer:{status:'insufficient-evidence',message:'Fixture.',claims:[]},selectedUnits:[],sourceDocuments:[],warnings:[],
    textEvidenceCount:0,imageEvidenceCount:0,model:null} as any;};
  const response=await answerKernelStudy('owner','Synthetic verbosity question','',[]);
  assert.equal(response.meta.study.settings.generationVerbosity,'medium');
  assert.equal(response.meta.study.settings.evidenceSelectionVerbosity,'low');
  process.env.STUDY_EVIDENCE_SELECTION='single-pass';
  await assert.rejects(answerKernelStudy('owner','Synthetic verbosity question','',[]),(e:any)=>e.code==='generation-verbosity-requires-selection-check');
  assert.equal(calls,1);
 }finally{kernel.answerStudyContent=saved;for(const [k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('source identity context is explicit, application guarded and recorded without becoming truth',async()=>{
 assert.equal(studySourceIdentityContext('off'),undefined);
 assert.equal(studySourceIdentityContext('literal-course-frontpage-v1'),'literal-course-frontpage-v1');
 assert.throws(()=>studySourceIdentityContext('auto'),StudyAnswerError);
 await assert.rejects(documentAnswerSettings({scope:'development',sourceIdentityContext:'literal-course-frontpage-v1'}),/Source identity context/);
 const values={STUDY_SOURCE_IDENTITY_CONTEXT:'literal-course-frontpage-v1',STUDY_ANSWER_BACKEND:'kernel',STUDY_DEVELOPMENT_DAILY_LIMIT:undefined,
  STUDY_EVIDENCE_SELECTION:'select-then-answer',STUDY_CITATION_CHECK:'selected-once',STUDY_SOURCE_VALUES:'off',
  STUDY_SOURCE_QUANTITIES:'off',STUDY_SOURCE_SCOPE:'off',STUDY_TEXT_CONTEXT_WINDOWS:'off',OPENAI_MODEL:'gpt-5.4-mini',
  STUDY_CITATION_TRACE_DIR:`${process.cwd()}/data/identity-fixture-never-written`},
  env=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]])),saved=kernel.answerStudyContent;
 let calls=0;
 try{
  for(const [k,v]of Object.entries(values))if(v===undefined)delete process.env[k];else process.env[k]=v;
  kernel.answerStudyContent=async(_owner,_question,_scope,policy)=>{calls++;
   assert.equal(policy?.sourceIdentityContext,'literal-course-frontpage-v1');await documentAnswerSettings(policy);
   return {answer:{status:'insufficient-evidence',message:'Fixture.',claims:[]},selectedUnits:[],sourceDocuments:[],warnings:[],
    sourceIdentityContext:{version:'literal-course-frontpage-v1',courseOwnershipVerified:false,semanticVerified:false,additions:[]},
    textEvidenceCount:0,imageEvidenceCount:0,model:null} as any;};
  const response=await answerKernelStudy('owner','Synthetic source identity question','',[]);
  assert.equal(response.meta.study.settings.sourceIdentityContext,'literal-course-frontpage-v1');
  assert.equal(response.meta.study.sourceIdentityContext!.courseOwnershipVerified,false);
  process.env.STUDY_EVIDENCE_SELECTION='single-pass';
  await assert.rejects(answerKernelStudy('owner','Synthetic source identity question','',[]),(e:any)=>e.code==='source-identity-requires-selection-check');
  assert.equal(calls,1);
 }finally{kernel.answerStudyContent=saved;for(const [k,v]of Object.entries(env))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});

test('legacy is the default, invalid configuration fails closed and application policy stays bounded',async()=>{
 assert.equal(studyAnswerBackend('legacy'),'legacy');assert.equal(studyAnswerBackend('kernel'),'kernel');
 assert.throws(()=>studyAnswerBackend('typo'),StudyAnswerError);
 assert.equal(studyEvidenceSelection('single-pass'),undefined);assert.equal(studyEvidenceSelection('select-then-answer'),'select-then-answer');
 assert.throws(()=>studyEvidenceSelection('typo'),StudyAnswerError);
 assert.equal(studyCitationCheck('off'),undefined);assert.equal(studyCitationCheck('selected-once'),'selected-once');
 assert.throws(()=>studyCitationCheck('typo'),StudyAnswerError);
 assert.equal(studyQuantityConsistency('off'),undefined);assert.equal(studyQuantityConsistency('explicit-unit-v1'),'explicit-unit-v1');
 assert.throws(()=>studyQuantityConsistency('typo'),StudyAnswerError);
 await assert.rejects(documentAnswerSettings({scope:'development',quantityConsistency:'explicit-unit-v1'}),/quantity consistency policy/);
 assert.equal(studySourceScope('off'),undefined);assert.equal(studySourceScope('question-scope'),'question-scope');
 assert.throws(()=>studySourceScope('typo'),StudyAnswerError);
 assert.equal(studyGenerationReasoning('low'),undefined);assert.equal(studyGenerationReasoning('medium'),'medium');
 assert.throws(()=>studyGenerationReasoning('high'),StudyAnswerError);
 await assert.rejects(documentAnswerSettings({scope:'application',generationReasoningEffort:'high' as any}),/generation reasoning policy/);
 await assert.rejects(documentAnswerSettings({scope:'application',model:'gpt-6-astra'}),/bounded mini/);
 await assert.rejects(documentAnswerSettings({scope:'application',maxOutputTokens:9000}),/bounded mini/);
 assert.equal((await documentAnswerSettings({scope:'application',model:'gpt-5.4-mini',maxOutputTokens:3000})).model,'gpt-5.4-mini');
});

test('explicit development daily limit is process guarded, strictly bounded and absent by default',async()=>{
 const names=['STUDY_DEVELOPMENT_DAILY_LIMIT','KERNEL_ADMIN_DEVELOPMENT_RUN','KERNEL_DATABASE_URL','DATABASE_URL',
  'STUDY_CITATION_CHECK','STUDY_SOURCE_VALUES'] as const;
 const env=Object.fromEntries(names.map(n=>[n,process.env[n]])),saved=kernel.answerStudyContent,fetch=globalThis.fetch;
 let kernelCalls=0,providerCalls=0,captured:any;
 globalThis.fetch=async()=>{providerCalls++;throw Error('No provider in configuration fixture');};
 kernel.answerStudyContent=async(_o,_q,_s,policy)=>{kernelCalls++;captured=policy;return {answer:{status:'insufficient-evidence',message:'Fixture.',claims:[]},
  selectedUnits:[],sourceDocuments:[],warnings:[],textEvidenceCount:0,imageEvidenceCount:0,model:null} as any;};
 try{
  delete process.env.STUDY_DEVELOPMENT_DAILY_LIMIT;delete process.env.KERNEL_ADMIN_DEVELOPMENT_RUN;
  process.env.STUDY_CITATION_CHECK='off';process.env.STUDY_SOURCE_VALUES='off';
  assert.equal(studyDevelopmentDailyLimit(),undefined);
  assert.equal((await documentAnswerSettings({scope:'application'})).dailyLimit,200);
  await answerKernelStudy('owner','Synthetic question','',[]);assert.equal(Object.hasOwn(captured,'dailyLimit'),false);
  const ordinaryPolicy=JSON.stringify(captured);kernelCalls=0;
  await assert.rejects(documentAnswerSettings({scope:'application',dailyLimit:201}),/isolated administrator/);
  for(const value of ['1','200','1000']){process.env.STUDY_DEVELOPMENT_DAILY_LIMIT=value;
   await assert.rejects(answerKernelStudy('owner','Synthetic question','',[]),/isolated administrator/);}
  process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/not-acceptance';
  process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
  await assert.rejects(answerKernelStudy('owner','Synthetic question','',[]),/isolated administrator/);
  process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';process.env.DATABASE_URL=':memory:';
  await assert.rejects(answerKernelStudy('owner','Synthetic question','',[]),/isolated administrator/);
  process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
  for(const value of ['','0','-1','1.5','1001','Infinity',' 200 ','0200','1e3']){
   process.env.STUDY_DEVELOPMENT_DAILY_LIMIT=value;
   await assert.rejects(answerKernelStudy('owner','Synthetic question','',[]),(e:any)=>e instanceof StudyAnswerError&&e.code==='invalid-development-daily-limit');}
  assert.equal(kernelCalls,0);assert.equal(providerCalls,0);
  for(const value of [1,200,1000]){process.env.STUDY_DEVELOPMENT_DAILY_LIMIT=String(value);
   await answerKernelStudy('owner','Synthetic question','',[]);assert.equal(captured.dailyLimit,value);}
  assert.equal((await documentAnswerSettings({scope:'application',dailyLimit:1000})).dailyLimit,1000);
  delete process.env.STUDY_DEVELOPMENT_DAILY_LIMIT;
  await answerKernelStudy('owner','Synthetic question','',[]);assert.equal(JSON.stringify(captured),ordinaryPolicy);
  assert.equal(providerCalls,0);
 }finally{kernel.answerStudyContent=saved;globalThis.fetch=fetch;
  for(const n of names)if(env[n]===undefined)delete process.env[n];else process.env[n]=env[n];}
});

test('application trace retains a failed check and maps it to a non-answer error',async()=>{
 const {DocumentCitationCheckError}=await import('../lib/kernel/document-citation-audit.ts');
 const {randomUUID}=await import('node:crypto'),{readdir,readFile}=await import('node:fs/promises'),{join}=await import('node:path');
 const names=['STUDY_CITATION_CHECK','STUDY_CITATION_TRACE_DIR','OPENAI_MODEL'] as const;
 const env=Object.fromEntries(names.map(n=>[n,process.env[n]])),saved=kernel.answerStudyContent;
 process.env.STUDY_CITATION_CHECK='selected-once';process.env.OPENAI_MODEL='gpt-5.4-mini';delete process.env.STUDY_CITATION_TRACE_DIR;
 let calls=0;
 kernel.answerStudyContent=async(_o,_q,_s,policy)=>{calls++;await policy!.citationCheck!.beforeAttempt('a'.repeat(64));
  await policy!.citationCheck!.recordResponse({requestIdentity:'a'.repeat(64),providerRequestSha256:'b'.repeat(64),httpStatus:200,rawBody:'saved-fixture',rawSha256:'fixture'});
  throw new DocumentCitationCheckError('citation-support-not-established');};
 try{await assert.rejects(answerKernelStudy('alice','Question','course',[]),(e:any)=>e.code==='citation-trace-required');assert.equal(calls,0);
  const directory=join(process.cwd(),'data','citation-trace-unit-'+randomUUID());process.env.STUDY_CITATION_TRACE_DIR=directory;
  await assert.rejects(answerKernelStudy('alice','Question','course',[]),(e:any)=>e.stage==='citation-validation'&&e.code==='citation-support-not-established');
  const files=await readdir(directory);assert.equal(files.length,2);
  const receipt=JSON.parse(await readFile(join(directory,files.find(f=>f.endsWith('.response.json'))!),'utf8'));
  assert.equal(receipt.owner,'alice');assert.equal(receipt.record.rawBody,'saved-fixture');assert.equal(calls,1);
 }finally{kernel.answerStudyContent=saved;for(const n of names){if(env[n]===undefined)delete process.env[n];else process.env[n]=env[n];}}
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
  assert.equal(actual.options.refineAdjacent,process.env.KERNEL_DOCUMENT_HYBRID==='true'&&process.env.KERNEL_DOCUMENT_RERANK==='true');
  const state=await tutor.tutorState('alice',id),message=state.messages[1];
  assert.match(message.body,/42.*\[S1\]/);assert.equal(message.meta.citations[0].title,'Original notes · p2');
  assert.equal(message.meta.citations[0].evidence.documentVersionId,'v1');assert.equal(message.meta.study.semanticVerified,false);
  const citationQuery=new URL(message.meta.citations[0].url,'http://localhost').searchParams;
  assert.equal(citationQuery.get('snapshot'),'1');assert.equal(citationQuery.get('version'),'v1');
  assert.equal(citationQuery.get('sourceVersion'),'sv1');assert.equal(citationQuery.get('evidenceId'),'evidence');
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

test('shared tutor persists Kernel routing diagnostics unchanged without turning them into citations',async()=>{
 const names=['STUDY_ANSWER_BACKEND','OPENAI_MODEL','STUDY_SOURCE_SCOPE','STUDY_CITATION_CHECK','STUDY_SOURCE_VALUES','STUDY_SOURCE_QUANTITIES',
  'STUDY_TEXT_CONTEXT_WINDOWS'] as const,env=Object.fromEntries(names.map(n=>[n,process.env[n]])),
  saved={answer:kernel.answerStudyContent,courses:kernel.listCourses,fetch:globalThis.fetch};
 const diagnostic={version:'metadata-answer-routing-observation-v1',scope:'ranked-reader-returned-anchors-only',observedAnchors:2,
  routedAnchors:1,unroutedAnchors:1,observedDocuments:2,pools:[{planSha256:'fixture-plan',candidateSetSha256:'fixture-pool',candidateCount:40,observedAnchors:1}],
  anchors:[],eligibleCorpusDocuments:null,scoredDocuments:null,filtering:'none',semanticVerified:false,answerCorrectness:'unassessed'};
 let calls=0;
 try{
  process.env.STUDY_ANSWER_BACKEND='kernel';process.env.OPENAI_MODEL='gpt-5.4-mini';for(const n of names.slice(2))process.env[n]='off';
  globalThis.fetch=async()=>{throw Error('Routing metadata fixture cannot contact a provider');};kernel.listCourses=async()=>[];
  kernel.answerStudyContent=async()=>{calls++;return {answer:{status:'insufficient-evidence',message:'Synthetic transport fixture.',claims:[]},
   selectedUnits:[],sourceDocuments:[],warnings:[],textEvidenceCount:2,imageEvidenceCount:0,model:null,contentTagRouting:diagnostic} as any;};
  const thread=await tutor.createTutorThread('routing-meta-owner',''),requestId='routing-meta-request01';
  await tutor.sendTutor('routing-meta-owner',thread,requestId,'Explain gravitational force',[],false);
  await tutor.sendTutor('routing-meta-owner',thread,requestId,'Explain gravitational force',[],false);
  const state=await tutor.tutorState('routing-meta-owner',thread),reply=state.messages[1];
  assert.equal(calls,1);assert.deepEqual(reply.meta.study.contentTagRouting,diagnostic);
  assert.deepEqual(reply.meta.citations,[]);assert.equal(reply.meta.study.semanticVerified,false);
 }finally{
  kernel.answerStudyContent=saved.answer;kernel.listCourses=saved.courses;globalThis.fetch=saved.fetch;
  for(const n of names)if(env[n]===undefined)delete process.env[n];else process.env[n]=env[n];
 }
});
