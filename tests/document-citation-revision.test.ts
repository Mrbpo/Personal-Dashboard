import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {KernelService} from '../lib/kernel/service.ts';
import {prepareDocumentAnswer,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceRead} from '../lib/kernel/document-context.ts';
import {prepareDocumentCitationRevision,buildDocumentCitationRevisionRequest,applyDocumentCitationRevision,
 type DocumentCitationRevisionBinding,type DocumentCitationRevisionPolicy} from '../lib/kernel/document-citation-revision.ts';

// Synthetic boundary fixture; neither a real table nor an acceptance score.
process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'citation-revision-empty-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-revision-test-never-sent';
process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const source={documentId:'synthetic',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:'source-sha'};
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
const question='What is the sample count?',body='Table 1: Sample statistics.';
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],anchors:[{
 id:'pg:v1:1',document_id:source.documentId,course_id:'',name:'Synthetic fixture',origin:'fixture',origin_key:'synthetic',
 source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:'caption:1',page_number:1,
 evidence_id:'caption',parser_version:'fixture',score:1,evidence_body:'full-page'}],images:[{
 attachmentId:'original-image',assetId:sha(bytes),captionEvidenceId:'caption',sha256:sha(bytes),byteLength:bytes.length,
 width:1,height:1,mime:'image/png',bytes,source}]};}
function binding(c=context()):DocumentCitationRevisionBinding{
 const prepared=prepareDocumentAnswer(question,c);
 return {inputFingerprint:prepared.fingerprint,quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,
  originalArtifact:{providerRequestSha256:sha('original-request'),rawResponseSha256:sha('original-raw'),
   inputFingerprint:prepared.fingerprint,answerVersion:'synthetic-answer-v1'},
  providerSelections:{status:'answered',message:'',claims:[{text:'There are 12 samples.',citations:[{id:prepared.quoteUnits[0].id}]},
   {text:'Sample statistics are presented.',citations:[{id:prepared.quoteUnits[0].id}]}]}};
}
function complete(c=context()):CompleteDocumentSourceRead{
 return {status:'available',context:{...c,parents:[],images:c.images.map(image=>'anchorEvidenceId' in image?image:
  {...image,originalReference:'fixture.png',provenance:{sourceUrl:'https://example.edu/fixture.png',revision:'synthetic'}}),
  accounting:{anchorCount:1,parentCount:0,contextNodeCount:1,contextBodyCodepoints:body.length,imageCount:c.images.length,imageBytes:bytes.length*c.images.length}},
 manifest:{method:'complete-current-source',nodeOrder:'original-source',complete:true,reason:null,source,sourceNodeCount:1,returnedNodeCount:1,
  sourceBodyCodepoints:body.length,sourceBodyUtf8Bytes:Buffer.byteLength(body),orderedTextSha256:sha(body),structureManifestSha256:sha('structure'),
  parserWarnings:[],document:{name:'Synthetic fixture',origin:'fixture',originKey:'synthetic',parserVersion:'fixture'},hierarchy:[],nodes:[],images:[],
  imageInputTokenUpper:3,limits:COMPLETE_DOCUMENT_SOURCE_LIMITS,manifestSha256:sha('current-complete-manifest')}};
}
async function development<T>(work:()=>Promise<T>){
 const names=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN'] as const,
  saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
 process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
 try{return await work();}finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
}
const local=(supported:boolean)=>({claimId:'c0',judgment:supported?'supported':'unsupported',reason:'Synthetic test judgment.',
 citationFindings:{r0:{judgment:supported?'supports':'does-not-establish',reason:'Synthetic reference finding.'}},
 objectUnitScope:{claim:'sample count',evidence:supported?'sample count':'caption only',alignment:supported?'same':'not-established'}});
const response=(value:unknown)=>Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',
 usage:{input_tokens:100,output_tokens:50},output_text:JSON.stringify(value)});
function journal(){
 const attempts:Parameters<DocumentCitationRevisionPolicy['beforeAttempt']>[0][]=[],raw:Parameters<DocumentCitationRevisionPolicy['recordResponse']>[0][]=[],states:Record<string,unknown>[]=[];
 const policy:DocumentCitationRevisionPolicy={scope:'development',beforeAttempt:async value=>{attempts.push(value);},
  recordResponse:async value=>{assert.equal(sha(value.rawBody),value.rawSha256);raw.push(value);},recordState:async value=>{states.push(value);}};
 return {attempts,raw,states,policy};
}
test('pure preparation binds real anchors, rejects stale identities and never forces a candidate',()=>{
 const c=context(),original=binding(c),saved=JSON.stringify(original),ready=prepareDocumentCitationRevision(question,c,original);
 assert.equal(ready.status,'ready');if(ready.status!=='ready')throw new Error('Expected ready');
 const request=buildDocumentCitationRevisionRequest(ready),content=request.input[1].content;
 assert.ok(Array.isArray(content));const input=JSON.parse(content[0].text!);
 assert.deepEqual(input,{claim:'There are 12 samples.',references:[{id:original.providerSelections.claims[0].citations[0].id,kind:'text',quote:body},{id:'i0',kind:'image'}]});
 assert.ok(!JSON.stringify(input).includes(question));const image=content.find(item=>item.type==='input_image');
 assert.ok(image&&'detail' in image);assert.equal(image.detail,'original');
 assert.equal(applyDocumentCitationRevision(ready,{status:'no-supported-reference',referenceIds:[]}),null);
 for(const invalid of [{status:'candidate-references',referenceIds:[]},{status:'candidate-references',referenceIds:['outside']},
  {status:'candidate-references',referenceIds:['i0','i0']},{status:'candidate-references',referenceIds:['i0'],text:'Rewritten claim'},
  {status:'no-supported-reference',referenceIds:['i0']}])assert.throws(()=>applyDocumentCitationRevision(ready,invalid));
 const revised=applyDocumentCitationRevision(ready,{status:'candidate-references',referenceIds:['i0']});
 assert.deepEqual(revised?.providerSelections.claims.map(claim=>claim.text),original.providerSelections.claims.map(claim=>claim.text));
 assert.equal(revised?.providerSelections.status,original.providerSelections.status);assert.equal(JSON.stringify(original),saved);
 for(const field of ['inputFingerprint','quoteUnitManifestSha256'] as const)assert.throws(()=>prepareDocumentCitationRevision(question,c,{...original,[field]:sha('stale')}));
 const historical=structuredClone(original);historical.originalArtifact.inputFingerprint=sha('older-context');
 assert.throws(()=>prepareDocumentCitationRevision(question,c,historical),/explicit caller-bound rebind proof/);
 historical.originalArtifact.contextRebind={fromInputFingerprint:sha('older-context'),toInputFingerprint:original.inputFingerprint,
  proofReference:'local-only-proof.json',proofSha256:sha('proof')};
 assert.equal(prepareDocumentCitationRevision(question,c,historical).status,'ready');
 const foreign=context();foreign.images[0].source={...source,documentId:'other'};
 assert.equal(prepareDocumentCitationRevision(question,foreign,binding(foreign)).status,'unavailable');
 const ambiguous=context();ambiguous.images.push({...ambiguous.images[0],attachmentId:'second'});
 const unavailable=prepareDocumentCitationRevision(question,ambiguous,binding(ambiguous));
 assert.equal(unavailable.status,'unavailable');if(unavailable.status==='unavailable')assert.equal(unavailable.reason,'ambiguous-anchor-images');
 const control=binding();control.providerSelections.claims[0].citations=[{id:'i0'}];
 assert.equal(prepareDocumentCitationRevision(question,c,control).status,'not-applicable');
});

test('Kernel development entry makes three isolated calls and changes citations only; all other claims remain unreviewed',async()=>{
 await database.prepare('SELECT count(*) n FROM ai_ledger').first();
 const kernel=new KernelService(),j=journal(),original=binding(),saved=JSON.stringify(original),oldFetch=globalThis.fetch;
 let calls=0;kernel.readCompleteDocumentSource=async()=>complete();
 globalThis.fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body)),content=request.input[1].content,input=JSON.parse(content[0].text);calls++;
  assert.equal(j.attempts.length,calls);assert.equal(j.states[0].event,'original');
  assert.equal(request.max_output_tokens,1000);assert.deepEqual(request.reasoning,{effort:'low'});
  assert.ok(j.attempts.at(-1)!.inputTokenUpper>16384);assert.ok(j.attempts.at(-1)!.fundingUpperUSD>=j.attempts.at(-1)!.usageUpperUSD);
  if(calls===1){assert.deepEqual(input.references,[{refId:'r0',kind:'text',quote:body}]);assert.equal(content.length,1);return response(local(false));}
  if(calls===2){assert.equal(input.claim,'There are 12 samples.');assert.equal(input.references.length,2);return response({status:'candidate-references',referenceIds:['i0']});}
  assert.deepEqual(input.references,[{refId:'r0',kind:'image'}]);assert.ok(!content[0].text.includes(body));return response(local(true));
 };
 try{
  await assert.rejects(kernel.reviseSelectedStudySourceCitation('owner',question,source,original,j.policy),/isolated administrator/);assert.equal(calls,0);
  await development(async()=>{
   const savedRate=process.env.AI_MODEL_RATES;
   try{
    process.env.AI_MODEL_RATES=JSON.stringify({'gpt-5.4-mini':{input:1,output:4.5,context:400000}});
    await assert.rejects(kernel.reviseSelectedStudySourceCitation('owner',question,source,original,j.policy),/frozen mini54 rate/);
    delete process.env.AI_MODEL_RATES;process.env.AI_BUDGET_TEST_BYPASS='true';
    await assert.rejects(kernel.reviseSelectedStudySourceCitation('owner',question,source,original,j.policy),/ordinary ledger/);
    assert.equal(calls,0);assert.equal(j.attempts.length,0);
   }finally{if(savedRate===undefined)delete process.env.AI_MODEL_RATES;else process.env.AI_MODEL_RATES=savedRate;process.env.AI_BUDGET_TEST_BYPASS='false';}
   const result=await kernel.reviseSelectedStudySourceCitation('owner',question,source,original,j.policy);
   assert.equal(result.status,'available');if(result.status!=='available')throw new Error('Expected result');
   assert.equal(result.result.status,'revised');assert.equal(calls,3);assert.equal(j.raw.length,3);
   assert.equal(result.result.wholeAnswerVerified,false);
   assert.deepEqual(result.result.claimReviews,[{claimIndex:0,status:'revised-local-supported'},{claimIndex:1,status:'unreviewed'}]);
   assert.deepEqual(result.result.providerSelections.claims.map(claim=>claim.text),original.providerSelections.claims.map(claim=>claim.text));
   assert.deepEqual(result.result.providerSelections.claims[1],original.providerSelections.claims[1]);assert.equal(JSON.stringify(original),saved);
   assert.equal((await database.prepare("SELECT count(*) n FROM ai_ledger WHERE status='settled'").first<{n:number}>())?.n,3);
  });
 }finally{globalThis.fetch=oldFetch;}
});

test('no support, failed new audit, malformed proposal and changed source retain the original without retries',async()=>{
 const kernel=new KernelService(),oldFetch=globalThis.fetch;let changed=false;
 kernel.readCompleteDocumentSource=async()=>{const current=complete();if(changed)current.manifest.manifestSha256=sha('changed');return current;};
 try{await development(async()=>{
  for(const variant of ['empty','unsupported','malformed','changed','timeout']){
   const j=journal(),original=binding();let calls=0;changed=false;
   globalThis.fetch=async()=>{
    calls++;if(variant==='timeout')throw new DOMException('Timed out','TimeoutError');
    if(variant==='changed')changed=true;
    if(calls===1)return response(local(false));
    if(calls===2)return response(variant==='empty'?{status:'no-supported-reference',referenceIds:[]}:
     variant==='malformed'?{status:'candidate-references',referenceIds:['i0'],claim:'changed'}:{status:'candidate-references',referenceIds:['i0']});
    return response(local(false));
   };
   const result=await kernel.reviseSelectedStudySourceCitation('owner',question,source,original,j.policy);
   assert.equal(result.status,'available');if(result.status!=='available')throw new Error('Expected result');
   assert.equal(result.result.revision,null);assert.deepEqual(result.result.providerSelections,original.providerSelections);
   assert.equal(result.result.wholeAnswerVerified,false);assert.equal(result.result.claimReviews[1].status,'unreviewed');
   assert.equal(calls,variant==='empty'||variant==='malformed'?2:variant==='unsupported'?3:1);
   assert.equal(j.raw.length,variant==='timeout'?0:calls);assert.equal(j.states.at(-1)?.event,'result');
  }
  changed=false;const j=journal(),control=binding();control.providerSelections.claims[0].citations=[{id:'i0'}];
  globalThis.fetch=async()=>{throw new Error('Positive image control must remain unreviewed with zero calls');};
  const result=await kernel.reviseSelectedStudySourceCitation('owner',question,source,control,j.policy);
  assert.equal(result.status,'available');if(result.status!=='available')throw new Error('Expected result');
  assert.equal(result.result.status,'not-applicable');assert.equal(j.attempts.length,0);
  assert.ok(result.result.claimReviews.every(review=>review.status==='unreviewed'));
 });}finally{globalThis.fetch=oldFetch;}
});
