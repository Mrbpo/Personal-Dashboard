import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {KernelService} from '../lib/kernel/service.ts';
import {migrateKernel,kernelPool} from '../lib/kernel/db.ts';
import {prepareDocumentAnswer,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceRead} from '../lib/kernel/document-context.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest,validateDocumentCitationAudit,
 type DocumentCitationAuditBinding,type DocumentCitationAuditPolicy,type DocumentCitationAuditResponse} from '../lib/kernel/document-citation-audit.ts';

const postgresUrl=process.env.KERNEL_DATABASE_URL;
process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'citation-audit-empty-vault-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-local-citation-audit-never-sent';
process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';
after(async()=>{if(postgresUrl)await kernelPool().end();});
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const source={documentId:'audit-source',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:'source-sha'};
const question='How many samples are compared?',body='The study compares two samples.';
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],anchors:[{
 id:'pg:version:1',document_id:source.documentId,course_id:'',name:'Original study',origin:'fixture',origin_key:'audit',
 source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:'original:1',page_number:1,
 evidence_id:'original-evidence',parser_version:'fixture-v1',score:1,evidence_body:'full-page'}],images:[{
 attachmentId:'image',assetId:hash(bytes),captionEvidenceId:'image-evidence',sha256:hash(bytes),byteLength:bytes.length,
 width:1,height:1,mime:'image/png',bytes,source}]};}
function binding(c=context()):DocumentCitationAuditBinding{
 const prepared=prepareDocumentAnswer(question,c);
 return {inputFingerprint:prepared.fingerprint,quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,claimIndex:0,
  providerSelections:{status:'answered',message:'',claims:[{text:'Two samples are compared.',
   citations:[{id:prepared.quoteUnits[0].id},{id:'i0'}]}]}};
}
function complete(c=context()):CompleteDocumentSourceRead{return {status:'available',context:{...c,parents:[],
 images:c.images.map(image=>({...image,originalReference:'source.png',provenance:{sourceUrl:'https://example.edu/source.png',revision:'fixture'}})),accounting:{
 anchorCount:1,parentCount:0,contextNodeCount:1,contextBodyCodepoints:body.length,imageCount:1,imageBytes:bytes.length}},manifest:{
 method:'complete-current-source',nodeOrder:'original-source',complete:true,reason:null,source,sourceNodeCount:1,returnedNodeCount:1,
 sourceBodyCodepoints:body.length,sourceBodyUtf8Bytes:Buffer.byteLength(body),orderedTextSha256:hash(body),structureManifestSha256:hash('structure'),
 parserWarnings:[],document:{name:'Original study',origin:'fixture',originKey:'audit',parserVersion:'fixture-v1'},hierarchy:[],
 nodes:[],images:[{attachmentId:'image',captionEvidenceId:'image-evidence',sha256:hash(bytes),byteLength:bytes.length,width:1,height:1}],
 imageInputTokenUpper:3,limits:COMPLETE_DOCUMENT_SOURCE_LIMITS,manifestSha256:hash('audit-manifest')}};}
const diagnostics=()=>({claimId:'c0',judgment:'supported',reason:'The cited text establishes the sample count.',
 citationFindings:{r0:{judgment:'supports',reason:'It says two samples.'},r1:{judgment:'unclear',reason:'No count is visible.'}},
 objectUnitScope:{claim:'two samples',evidence:'two samples',alignment:'same'}});
const response=(value=diagnostics())=>({status:'completed',model:'gpt-5.4-mini-2026-03-17',
 usage:{input_tokens:100,output_tokens:50},output_text:JSON.stringify(value)});
async function development<T>(work:()=>Promise<T>){
 const names=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN'] as const;
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
 process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
 try{return await work();}finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
}
const policy=(raw:DocumentCitationAuditResponse[],beforeAttempt:DocumentCitationAuditPolicy['beforeAttempt']=async()=>{}):DocumentCitationAuditPolicy=>({
 scope:'development',beforeAttempt,recordResponse:async value=>{raw.push(value);}});

test('audit restores the entire original selection object and only its actual selected references',()=>{
 const c=context(),original=binding(c),snapshot=JSON.stringify(original),prepared=prepareDocumentCitationAudit(question,c,original);
 const request=buildDocumentCitationAuditRequest(prepared.packet),content=request.input[1].content;
 assert.ok(Array.isArray(content));const input=JSON.parse(content[0].text!);
 assert.deepEqual(input,{question,claim:{claimId:'c0',text:'Two samples are compared.'},
  references:[{refId:'r0',kind:'text',quote:body},{refId:'r1',kind:'image'}]});
 assert.equal(request.model,'gpt-5.4-mini');assert.deepEqual(request.reasoning,{effort:'low'});assert.equal(request.max_output_tokens,1000);
 const image=content.find(item=>item.type==='input_image');assert.ok(image&&'image_url' in image);
 assert.equal(image.image_url,'data:image/png;base64,'+bytes.toString('base64'));assert.equal(image.detail,'high');
 assert.equal(prepared.binding.citations[0].evidence.sourceHash,source.sourceHash);
 assert.equal(prepared.binding.citations[0].quoteSha256,hash(body));assert.equal(prepared.binding.citations[1].evidence.sha256,hash(bytes));
 assert.equal(JSON.stringify(original),snapshot);
 for(const change of [
  {...original,claimIndex:1},{...original,inputFingerprint:hash('stale')},{...original,quoteUnitManifestSha256:hash('stale')},
  {...original,quote:body},
  {...original,providerSelections:{...original.providerSelections,claims:[{text:'Other.',citations:[{id:'outside'}]}]}},
  {...original,providerSelections:{...original.providerSelections,claims:[original.providerSelections.claims[0],{text:'Other.',citations:[{id:'outside'}]}]}},
  {...original,providerSelections:{...original.providerSelections,claims:[{text:'Other.',citations:[{id:'i0',quote:'forged'}]}]}}
 ])assert.throws(()=>prepareDocumentCitationAudit(question,c,change as DocumentCitationAuditBinding));
 const changed=context();changed.anchors[0].body+=' New text.';
 assert.throws(()=>prepareDocumentCitationAudit(question,changed,original),/source or context changed/);
 for(const change of [{...diagnostics(),extra:true},{...diagnostics(),claimId:'c1'},
  {...diagnostics(),citationFindings:{r0:diagnostics().citationFindings.r0}},
  {...diagnostics(),citationFindings:{...diagnostics().citationFindings,r2:diagnostics().citationFindings.r0}}])
  assert.throws(()=>validateDocumentCitationAudit(change,['r0','r1']));
});

test('Kernel policy and current-source binding fail before fetch; valid calls retain raw and diagnostic identity',async()=>{
 await database.prepare('SELECT count(*) n FROM ai_ledger').first();
 const kernel=new KernelService(),raw:DocumentCitationAuditResponse[]=[],originalFetch=globalThis.fetch;
 let reads=0,calls=0,attempts=0,changed=false;
 kernel.readCompleteDocumentSource=async(owner,expected)=>{
  assert.equal(owner,'owner');assert.deepEqual(expected,source);reads++;
  const c=context();if(changed)c.anchors[0].body+=' Changed.';return complete(c);
 };
 globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));
  assert.equal(request.max_output_tokens,1000);return Response.json(response());};
 try{
  await assert.rejects(kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),policy(raw)),/isolated administrator/);
  assert.equal(reads,0);assert.equal(calls,0);
  await development(async()=>{
   for(const invalid of [undefined,{...policy(raw),beforeAttempt:undefined},{...policy(raw),recordResponse:undefined},
    {...policy(raw),scope:'production'},{...policy(raw),model:'gpt-6-astra'}])
    await assert.rejects(kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),invalid as DocumentCitationAuditPolicy));
   assert.equal(reads,0);assert.equal(calls,0);
   const original=binding(),saved=JSON.stringify(original),identities:string[]=[];
   const result=await kernel.auditSelectedStudySourceClaim('owner',question,source,original,policy(raw,async identity=>{attempts++;identities.push(identity);}));
   assert.equal(result.status,'available');if(result.status!=='available')throw new Error('Expected audit');
   assert.deepEqual(result.result.diagnostics,diagnostics());assert.equal(reads,3);assert.equal(calls,1);assert.equal(attempts,1);
   assert.equal(result.result.requestIdentity,identities[0]);assert.equal(result.result.requestIdentity,raw[0].requestIdentity);
   assert.equal(result.result.providerRequestSha256,raw[0].providerRequestSha256);assert.equal(result.result.rawResponseSha256,hash(raw[0].rawBody));
   assert.equal(raw[0].httpStatus,200);assert.equal(JSON.stringify(original),saved);
   await assert.rejects(kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),policy(raw,async()=>{changed=true;})),/source or context changed/);
   assert.equal(calls,1,'change after the journal is detected before any provider call');changed=false;
   const bad=binding();bad.providerSelections.claims[0].citations[0].id='outside';
   await assert.rejects(kernel.auditSelectedStudySourceClaim('owner',question,source,bad,policy(raw)),/ungrounded/);
   assert.equal(calls,1);assert.equal(raw.length,1);
  });
 }finally{globalThis.fetch=originalFetch;}
});

test('raw failures are persisted once, source changes fail, and ambiguous timeouts retain reservations without retries',async()=>{
 const kernel=new KernelService(),raw:DocumentCitationAuditResponse[]=[],originalFetch=globalThis.fetch;
 let changed=false,calls=0;kernel.readCompleteDocumentSource=async()=>{
  const value=complete();if(changed)value.manifest.manifestSha256=hash('changed-manifest');return value;
 };
 const latest=()=>database.prepare('SELECT status,charged FROM ai_ledger ORDER BY rowid DESC LIMIT 1').first<{status:string;charged:number|null}>();
 try{await development(async()=>{
  const variants=[{raw:'not JSON',error:/JSON/},
   {raw:JSON.stringify({...response(),status:'incomplete'}),error:/incomplete/},
   {raw:JSON.stringify({...response(),model:'gpt-5-mini'}),error:/unverified/},
   {raw:JSON.stringify(response({...diagnostics(),claimId:'c1'})),error:/diagnostics/}];
  for(const [index,variant] of variants.entries()){
   globalThis.fetch=async()=>{calls++;return new Response(variant.raw,{status:200});};
   await assert.rejects(kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),policy(raw)),variant.error);
   assert.equal(raw.at(-1)?.rawBody,variant.raw);assert.equal(raw.at(-1)?.rawSha256,hash(variant.raw));
   assert.equal(calls,index+1);assert.equal(raw.length,index+1);
   if(index===2){assert.equal((await latest())?.status,'reserved');assert.equal((await latest())?.charged,null);}
  }
  globalThis.fetch=async()=>{calls++;changed=true;return Response.json(response());};
  await assert.rejects(kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),policy(raw)),/source changed/);
  assert.equal(raw.length,5,'the actual response survives the post-provider source recheck');changed=false;
  globalThis.fetch=async()=>{calls++;throw new DOMException('Timed out','TimeoutError');};
  await assert.rejects(kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),policy(raw)),/Timed out/);
  assert.equal((await latest())?.status,'reserved');assert.equal((await latest())?.charged,null);
  assert.equal(calls,6);assert.equal(raw.length,5,'timeout has no fabricated raw response and no paid retry');
 });}finally{globalThis.fetch=originalFetch;}
});

test('actual PostgreSQL owner/current-source reads restore text and PNG and reject a source hidden during audit',
 {skip:!postgresUrl},async()=>{
 await migrateKernel();const kernel=new KernelService(),tag=randomUUID(),owner='citation-owner-'+tag,id='citation-doc-'+tag,title='Citation fixture '+tag;
 const bodies=[body,'Figure 1: Sample comparison.'];
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:title,hash:hash(JSON.stringify(bodies)),mime:'text/plain',origin:'audit-fixture',originKey:id},
  bodies.map((text,index)=>({pageNumber:index+1,locator:'original:'+index,text})),{parserVersion:'audit-fixture-v1'});
 const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});assert.equal(resolution.status,'resolved');
 if(resolution.status!=='resolved')throw new Error('Source unresolved');const expected={...resolution.document,courseId:''};
 const nodes=(await kernel.readDocumentSourcePages(owner,expected)).nodes;
 await kernel.registerDocumentStructure(owner,expected,{rawSourceHash:expected.sourceHash,parserVersion:'fixture-structure-v1',parents:[],
  nodes:nodes.map((node,index)=>({evidenceId:node.evidenceId,locator:node.locator,ordinal:index,kind:index===1?'caption':'paragraph',parentId:null,bodySha256:node.bodySha256}))});
 await kernel.registerDocumentImage(owner,expected,{captionEvidenceId:nodes[1].evidenceId,originalReference:'fixture.png',
  provenance:{sourceUrl:'https://example.edu/fixture.png',revision:'fixture'},bytes});
 const current=await kernel.readCompleteDocumentSource(owner,expected);assert.equal(current.status,'available');
 if(current.status!=='available')throw new Error('Incomplete fixture');const original=binding(current.context),raw:DocumentCitationAuditResponse[]=[];
 const originalFetch=globalThis.fetch;let calls=0,hide=false;
 globalThis.fetch=async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body)),content=request.input[1].content,input=JSON.parse(content[0].text);
  assert.deepEqual(input.references,[{refId:'r0',kind:'text',quote:body},{refId:'r1',kind:'image'}]);
  assert.equal(content.find((item:{type:string})=>item.type==='input_image').image_url,'data:image/png;base64,'+bytes.toString('base64'));
  if(hide)await kernel.hideParsedDocument(owner,id);return Response.json(response());
 };
 try{await development(async()=>{
  await assert.rejects(kernel.auditSelectedStudySourceClaim('different-owner',question,expected,original,policy(raw)));
  assert.equal(calls,0);
  const result=await kernel.auditSelectedStudySourceClaim(owner,question,expected,original,policy(raw));assert.equal(result.status,'available');
  assert.equal(calls,1);hide=true;
  await assert.rejects(kernel.auditSelectedStudySourceClaim(owner,question,expected,original,policy(raw)),/current|source changed/);
  assert.equal(calls,2);assert.equal(raw.length,2,'raw retained even after a real source was hidden');
 });}finally{globalThis.fetch=originalFetch;}
});
