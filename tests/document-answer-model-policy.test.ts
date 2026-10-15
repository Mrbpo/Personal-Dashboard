import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {KernelService} from '../lib/kernel/service.ts';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceRead} from '../lib/kernel/document-context.ts';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'document-mini54-empty-vault-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-local-model-policy-never-sent';
process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';

test('isolated Kernel answers bind mini54 original-image requests, verify snapshots and retain unverified charges',async()=>{
 const names=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN','AI_MODEL_RATES'] as const;
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]])),originalFetch=globalThis.fetch;
 // Initialize the test-only in-memory ledger before testing the literal process
 // guard. The Kernel reader below is a local stub, not a PostgreSQL connection.
 await database.prepare('SELECT count(*) n FROM ai_ledger').first();
 const source={documentId:'mini54-source',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:'source-sha'};
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
 const text='The source compares two samples.',c:DocumentAnswerContext={sourceContentIsUntrusted:true,parents:[],anchors:[{
  id:'pg:version:1',document_id:source.documentId,course_id:'',name:'Original study',origin:'fixture',origin_key:'mini54',
  source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body:text,locator:'original:1',page_number:1,
  evidence_id:'original-evidence',parser_version:'fixture-v1',score:1,evidence_body:'full-page'}],images:[{
  attachmentId:'image',assetId:hash(bytes),captionEvidenceId:'image-evidence',sha256:hash(bytes),byteLength:bytes.length,
  width:1,height:1,mime:'image/png',bytes,source}]};
 const complete={status:'available',context:{...c,parents:[],images:c.images.map(image=>'anchorEvidenceId' in image?image:({...image,originalReference:'source.png',
  provenance:{sourceUrl:'https://example.edu/source.png',revision:'fixture'}})),accounting:{anchorCount:1,parentCount:0,
  contextNodeCount:1,contextBodyCodepoints:text.length,imageCount:1,imageBytes:bytes.length}},manifest:{
  method:'complete-current-source',nodeOrder:'original-source',complete:true,reason:null,source,sourceNodeCount:1,returnedNodeCount:1,
  sourceBodyCodepoints:text.length,sourceBodyUtf8Bytes:Buffer.byteLength(text),orderedTextSha256:hash(text),structureManifestSha256:hash('structure'),
  parserWarnings:[],document:{name:'Original study',origin:'fixture',originKey:'mini54',parserVersion:'fixture-v1'},hierarchy:[],nodes:[],
  images:[{attachmentId:'image',captionEvidenceId:'image-evidence',sha256:hash(bytes),byteLength:bytes.length,width:1,height:1}],
  imageInputTokenUpper:3,limits:COMPLETE_DOCUMENT_SOURCE_LIMITS,manifestSha256:hash('original-manifest')}} satisfies CompleteDocumentSourceRead;
 const kernel=new KernelService();let reads=0,calls=0,attempts=0,actualModel:unknown='gpt-5.4-mini-2026-03-17';
 kernel.readCompleteDocumentSource=async()=>{reads++;return complete;};
 const requests:ReturnType<typeof buildDocumentAnswerRequest>[]=[],identities:string[]=[];
 const policy={scope:'development' as const,model:'gpt-5.4-mini' as const,beforeAttempt:async(identity:string)=>{attempts++;identities.push(identity);}};
 const latestLedger=()=>database.prepare('SELECT reserved,charged,status FROM ai_ledger ORDER BY rowid DESC LIMIT 1')
  .first<{reserved:number;charged:number|null;status:string}>();
 globalThis.fetch=async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body));requests.push(request);
  const input=JSON.parse(request.input[1].content[0].text),unit=input.quoteUnits.find((u:{selectable:boolean})=>u.selectable);
  return Response.json({status:'completed',model:actualModel,usage:{input_tokens:100,output_tokens:50},
   output_text:JSON.stringify({status:'answered',message:'',claims:[{text:'Two samples are compared.',citations:[{id:unit.id},{id:'i0'}]}]})});
 };
 try{
  delete process.env.AI_MODEL_RATES;
  await assert.rejects(kernel.answerSelectedStudySource('owner','How many?',source,{model:'gpt-5.4-mini'}),/isolated development/);
  process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/study';
  process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
  await assert.rejects(kernel.answerSelectedStudySource('owner','How many?',source,policy),/isolated administrator/);
  process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
  await assert.rejects(kernel.answerSelectedStudySource('owner','How many?',source,{...policy,beforeAttempt:undefined}),/attempt journal/);
  assert.equal(reads,0);assert.equal(calls,0);assert.equal(attempts,0);
  const result=await kernel.answerSelectedStudySource('owner','How many?',source,policy);
  assert.equal(result.status,'available');if(result.status!=='available')throw new Error('Expected supported request');
  assert.ok('requestedModel' in result.result);
  assert.equal(reads,3);assert.equal(calls,1);assert.equal(attempts,1);
  assert.equal(result.result.requestedModel,'gpt-5.4-mini');assert.equal(result.result.model,'gpt-5.4-mini-2026-03-17');
  assert.equal(result.result.providerRequestSha256,hash(JSON.stringify(requests[0])));
  assert.equal(requests[0].model,'gpt-5.4-mini');assert.deepEqual(requests[0].reasoning,{effort:'low'});
  assert.equal(requests[0].max_output_tokens,4000);const content=requests[0].input[1].content;assert.ok(Array.isArray(content));
  const actualImage=content.find(item=>item.type==='input_image');assert.ok(actualImage&&'detail' in actualImage);
  assert.equal(actualImage.detail,'original');
  assert.ok('image_url' in actualImage);
  assert.equal(actualImage.image_url,'data:image/png;base64,'+bytes.toString('base64'));
  const legacyHigh=structuredClone(requests[0]),legacyContent=legacyHigh.input[1].content;
  assert.ok(Array.isArray(legacyContent));const legacyImage=legacyContent.find(item=>item.type==='input_image');
  assert.ok(legacyImage&&'detail' in legacyImage);legacyImage.detail='high';
  assert.notEqual(result.result.providerRequestSha256,hash(JSON.stringify(legacyHigh)),'old high-detail raw is not an exact replay');
  assert.equal(result.result.answer.claims[0].citations[0].quote,text);assert.equal(result.result.answer.claims[0].citations[1].quote,'');
  assert.equal(result.manifest.request?.imageInputTokenUpper,3);assert.equal(result.manifest.request?.inputTokenUpper,
   result.manifest.request!.nonImageBodyUtf8Bytes+3+COMPLETE_DOCUMENT_SOURCE_LIMITS.framingTokens);
  const settled=(await latestLedger())!;assert.equal(settled.status,'settled');assert.equal(settled.charged,(100*.75+50*4.5)/1e6);
  const inputEstimate=Math.min(400000,Math.max(1000,Math.ceil(Buffer.byteLength(JSON.stringify(requests[0]))/2)));
  assert.equal(settled.reserved,(inputEstimate*.75+4000*4.5)/1e6,'base rates apply without a hidden rates override');
  actualModel='gpt-5.4-mini';await kernel.answerSelectedStudySource('owner','How many?',source,policy);
  assert.equal(calls,2);assert.equal((await latestLedger())?.status,'settled');
  for(actualModel of ['gpt-5-mini','gpt-6-astra','gpt-5.4-mini-2099-01-01',null]){
   const before:number=calls;
   await assert.rejects(kernel.answerSelectedStudySource('owner','How many?',source,policy),/different or unverified model/);
   assert.equal(calls,before+1,'one request, never a fallback or retry');
   const held=(await latestLedger())!;assert.equal(held.status,'reserved');assert.equal(held.charged,null);
  }
  actualModel='gpt-5-mini';const ordinary=await kernel.answerSelectedStudySource('owner','How many?',source);
  assert.equal(ordinary.status,'available');assert.equal(requests.at(-1)?.model,'gpt-5-mini');
  const ordinaryContent=requests.at(-1)!.input[1].content;assert.ok(Array.isArray(ordinaryContent));
  const ordinaryImage=ordinaryContent.find(item=>item.type==='input_image');
  assert.ok(ordinaryImage&&'image_url' in ordinaryImage);
  assert.equal(ordinaryImage.detail,'high');assert.equal(ordinaryImage.image_url,actualImage.image_url);
  assert.notEqual(ordinary.status==='available'&&'requestIdentity' in ordinary.result&&ordinary.result.requestIdentity,identities[0]);
  assert.equal(calls,7);assert.equal(attempts,6);
  const prepared=prepareDocumentAnswer('How many?',c);
  const astra=buildDocumentAnswerRequest(prepared,{model:'gpt-6-astra',reasoningEffort:'high',maxOutputTokens:4000});
  const astraContent=astra.input[1].content;assert.ok(Array.isArray(astraContent));
  const astraImage=astraContent.find(item=>item.type==='input_image');
  assert.ok(astraImage&&'detail' in astraImage);assert.equal(astraImage.detail,'original');
  assert.throws(()=>buildDocumentAnswerRequest(prepared,{model:'gpt-5.4' as 'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:4000}),/Invalid/);
 }finally{
  globalThis.fetch=originalFetch;for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}
 }
});
