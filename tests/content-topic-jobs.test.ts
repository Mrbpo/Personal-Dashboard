import{test,after}from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{claimIngestionJob,finishIngestionJob,retryIngestionJob,deferIngestionJob}from'../lib/kernel/jobs.ts';
import{contentTopicJobMode,CONTENT_TOPIC_JOB_KIND}from'../lib/kernel/content-topic-jobs.ts';import{AiBudgetDeferredError}from'../lib/ai-budget.ts';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');let calls=0,transportError=false;const requestBodies:string[]=[];
globalThis.fetch=async(input,init)=>{
 assert.equal(String(input),'https://api.openai.com/v1/responses');calls++;if(transportError)throw Error('Synthetic unknown transport outcome');
 requestBodies.push(String(init?.body));const request=JSON.parse(String(init?.body));assert.equal(request.text.format.name,'controlled_topic_selection_v1');
 const supplied=JSON.parse(request.input[1].content[0].text),labels=[{labelId:supplied.labels.find((l:{topic:string})=>l.topic==='calculus').id,quoteUnitId:supplied.excerpts[0].id}];
 return Response.json({status:'completed',model:'gpt-5.4-mini',usage:{input_tokens:0,output_tokens:0},output_text:JSON.stringify({labels})});
};
after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});
test('topic job mode is explicit and defaults off',()=>{
 const saved=process.env.KERNEL_CONTENT_TOPICS;try{delete process.env.KERNEL_CONTENT_TOPICS;assert.equal(contentTopicJobMode(),'off');
  process.env.KERNEL_CONTENT_TOPICS='invalid';assert.throws(contentTopicJobMode,/Invalid/);
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TOPICS;else process.env.KERNEL_CONTENT_TOPICS=saved;}
});
test('incremental topic jobs atomically queue pages and recover saved output without repeated paid transport',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='topic-job:'+uid,saved={mode:process.env.KERNEL_CONTENT_TOPICS,key:process.env.OPENAI_API_KEY,budget:process.env.AI_MONTHLY_BUDGET,bypass:process.env.AI_BUDGET_TEST_BYPASS};
 const add=async(name:string,texts=['Calculus describes integrals.'])=>{
  const doc={id:hash(uid+name),ownerId:owner,courseId:'',name:name+'.txt',hash:hash(texts.join('\n')),mime:'text/plain',origin:'fixture-topic-job',originKey:uid+name};
  await kernel.ingestParsedDocument(doc,texts.map((text,i)=>({pageNumber:i+1,locator:'page '+(i+1),text})),{parserVersion:'topic-job-plain-text-v1',extractionMethod:'plain-text'});return doc;
 };
 const list=async(id:string)=>(await kernelPool().query('SELECT * FROM ingestion_jobs WHERE kind=$1 AND scope=$2 ORDER BY (payload->>\'pageNumber\')::int',[CONTENT_TOPIC_JOB_KIND,id])).rows;
 const claim=async(id:string)=>{const j=await claimIngestionJob(id);assert.ok(j);return j;};
 try{
  delete process.env.KERNEL_CONTENT_TOPICS;process.env.OPENAI_API_KEY='synthetic-no-real-api';process.env.AI_MONTHLY_BUDGET='1';process.env.AI_BUDGET_TEST_BYPASS='false';
  const seed=await add('Vocabulary'),row=(await kernelPool().query('SELECT d.current_version_id,v.source_version_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id WHERE d.id=$1',[seed.id])).rows[0];
  assert.equal((await list(seed.id)).length,0);
  await kernel.recordDocumentClassification(owner,{documentId:seed.id,versionId:row.current_version_id,sourceVersionId:row.source_version_id,sourceHash:seed.hash,
   classifierId:'manual/job-vocab',producerVersion:'fixture-v1',method:'manual',model:null,previousId:null,tags:[{facet:'topic',key:'calculus',confidence:1,evidence:{kind:'human-judgment'}}]},'fixture-admin','Synthetic vocabulary');
  process.env.KERNEL_CONTENT_TOPICS='controlled-v1';
  const doc=await add('Notes',['Calculus describes integrals.','Calculus also describes derivatives.']);const queued=await list(doc.id);assert.equal(queued.length,2);
  await add('Notes',['Calculus describes integrals.','Calculus also describes derivatives.']);assert.equal((await list(doc.id)).length,2);
  const first=await claim(queued[0].id),n=calls;const imported=await kernel.runDocumentTopicJob(first);assert.equal(imported.status,'imported');assert.equal(calls,n+1);
  assert.equal((await kernel.documentClassifications(owner,doc.id)).length,1);
  const cp=(await list(doc.id))[0].payload.topicCheckpoint;assert.equal(cp.delivery,'received');assert.ok(cp.rawResponse);
  const audit=JSON.parse(String((await kernel.documentClassifications(owner,doc.id))[0].reason));assert.equal(audit.transport,'kernel-worker-output');
  assert.equal(audit.requestSha256,hash(requestBodies[0]),'Audit binds the exact transport bytes despite JSONB roundtrip');
  assert.equal(JSON.stringify(JSON.parse(cp.packetJson).request),requestBodies[0]);
  await kernel.runDocumentTopicJob(first);assert.equal(calls,n+1,'Crash after import before finish must replay without provider');await finishIngestionJob(first.id,first.lease_token);
  const second=await claim(queued[1].id);await kernel.runDocumentTopicJob(second);await finishIngestionJob(second.id,second.lease_token);
  assert.equal((await kernel.documentClassifications(owner,doc.id)).length,2,'Other page labels survive');
  const afterFinish=calls;await assert.rejects(kernel.runDocumentTopicJob(second),/lease lost/);assert.equal(calls,afterFinish);
  const route=await kernel.searchDocumentText(owner,'calculus integrals',{semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false});assert.ok(route.some(r=>r.document_id===doc.id));

  const recover=await add('Recover'),rjob=await claim((await list(recover.id))[0].id),beforeRecovery=calls;
  await kernelPool().query(`CREATE FUNCTION topic_job_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.actor='kernel:content-topics' THEN RAISE EXCEPTION 'Synthetic import interruption'; END IF; RETURN NEW; END $$`);
  await kernelPool().query('CREATE TRIGGER topic_job_test_reject BEFORE INSERT ON document_content_classifications FOR EACH ROW EXECUTE FUNCTION topic_job_test_reject()');
  try{await assert.rejects(kernel.runDocumentTopicJob(rjob),/Synthetic import interruption/);}finally{await kernelPool().query('DROP TRIGGER topic_job_test_reject ON document_content_classifications');await kernelPool().query('DROP FUNCTION topic_job_test_reject()');}
  assert.equal(calls,beforeRecovery+1);assert.equal((await list(recover.id))[0].payload.topicCheckpoint.delivery,'received');assert.equal((await kernel.documentClassifications(owner,recover.id)).length,0);
  await finishIngestionJob(rjob.id,rjob.lease_token,'Synthetic import interruption');assert.equal((await list(recover.id))[0].state,'failed');
  await retryIngestionJob(rjob.id);const resumed=await claim(rjob.id);await kernel.runDocumentTopicJob(resumed);await finishIngestionJob(resumed.id,resumed.lease_token);
  assert.equal(calls,beforeRecovery+1,'Saved actual response resumes after administrator retry, no paid replay');

  const uncertain=await add('Uncertain'),ujob=await claim((await list(uncertain.id))[0].id),beforeUnknown=calls;transportError=true;
  try{await assert.rejects(kernel.runDocumentTopicJob(ujob),/Synthetic unknown transport/);}finally{transportError=false;}
  assert.equal((await list(uncertain.id))[0].payload.topicCheckpoint.delivery,'attempted');await finishIngestionJob(ujob.id,ujob.lease_token,'Unknown provider outcome');assert.equal((await list(uncertain.id))[0].state,'failed');
  await retryIngestionJob(ujob.id);const blocked=await claim(ujob.id);await assert.rejects(kernel.runDocumentTopicJob(blocked),/administrator reconciliation/);
  assert.equal(calls,beforeUnknown+1);await finishIngestionJob(blocked.id,blocked.lease_token,'Reconciliation required');

  const deferred=await add('Deferred'),djob=await claim((await list(deferred.id))[0].id),beforeBudget=calls;process.env.AI_MONTHLY_BUDGET='0';let deferredError:AiBudgetDeferredError|undefined;
  try{await kernel.runDocumentTopicJob(djob);}catch(e){assert.ok(e instanceof AiBudgetDeferredError);deferredError=e;}finally{process.env.AI_MONTHLY_BUDGET='1';}
  assert.ok(deferredError);assert.equal(calls,beforeBudget);assert.equal((await list(deferred.id))[0].payload.topicCheckpoint.delivery,'prepared');
  await deferIngestionJob(djob.id,djob.lease_token,deferredError.retryAt,deferredError.reason);assert.equal((await list(deferred.id))[0].attempts,0);

  const stale=await add('Stale'),oldJob=(await list(stale.id))[0];
  await kernel.ingestParsedDocument(stale,[{pageNumber:1,locator:'page 1',text:'Calculus describes integrals.'}],{parserVersion:'topic-job-plain-text-v2',extractionMethod:'plain-text'});
  const sjob=await claim(oldJob.id),beforeStale=calls;await assert.rejects(kernel.runDocumentTopicJob(sjob),/source version changed/);assert.equal(calls,beforeStale);await finishIngestionJob(sjob.id,sjob.lease_token,'Stale source');

  const raced=await add('Raced'),racedJob=await claim((await list(raced.id))[0].id),beforeRace=calls;
  const racing=await Promise.allSettled([kernel.runDocumentTopicJob(racedJob),kernel.runDocumentTopicJob(racedJob)]);
  assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);assert.equal(calls,beforeRace+1,'Concurrent execution of one lease must not duplicate transport');
  await finishIngestionJob(racedJob.id,racedJob.lease_token);

  await kernelPool().query(`CREATE FUNCTION topic_queue_test_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.scope='${hash(uid+'Rollback')}' THEN RAISE EXCEPTION 'Synthetic queue interruption'; END IF; RETURN NEW; END $$`);
  await kernelPool().query('CREATE TRIGGER topic_queue_test_reject BEFORE INSERT ON ingestion_jobs FOR EACH ROW EXECUTE FUNCTION topic_queue_test_reject()');
  try{await assert.rejects(add('Rollback'),/Synthetic queue interruption/);}finally{await kernelPool().query('DROP TRIGGER topic_queue_test_reject ON ingestion_jobs');await kernelPool().query('DROP FUNCTION topic_queue_test_reject()');}
  assert.equal((await kernelPool().query('SELECT id FROM document_texts WHERE id=$1',[hash(uid+'Rollback')])).rowCount,0,'Source and queue roll back together');
 }finally{for(const [key,value]of Object.entries({KERNEL_CONTENT_TOPICS:saved.mode,OPENAI_API_KEY:saved.key,AI_MONTHLY_BUDGET:saved.budget,AI_BUDGET_TEST_BYPASS:saved.bypass}))if(value===undefined)delete process.env[key];else process.env[key]=value;}
});
