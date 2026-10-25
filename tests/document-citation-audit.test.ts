import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {KernelService} from '../lib/kernel/service.ts';
import {migrateKernel,kernelPool} from '../lib/kernel/db.ts';
import {prepareDocumentAnswer,documentAnswerSettings,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceRead} from '../lib/kernel/document-context.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest,validateDocumentCitationAudit,documentCitationAuditRequestIdentity,
 type DocumentCitationAuditBinding,type DocumentCitationAuditPolicy,type DocumentCitationAuditResponse} from '../lib/kernel/document-citation-audit.ts';

const postgresUrl=process.env.KERNEL_DATABASE_URL;
process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'citation-audit-empty-vault-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-local-citation-audit-never-sent';
process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';
after(async()=>{if(postgresUrl)await kernelPool().end();});
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const source={documentId:'audit-source',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:'source-sha'};
const withoutSources=(refs:Array<Record<string,unknown>>)=>refs.map(({source:_source,...ref})=>ref);
function auditInput(request:ReturnType<typeof buildDocumentCitationAuditRequest>){
 const content=request.input[1].content;assert.ok(Array.isArray(content));
 return JSON.parse(content[0].text!);
}
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
test('opt-in discourse restores displayed answer text without adding another claims evidence or images',()=>{
 const c=context(),b=binding(c),id=b.providerSelections.claims[0].citations[0].id;
 b.providerSelections.claims=[{text:'First observation from a separate image.',citations:[{id:'i0'}]},
  {text:'But that does not describe the text observation.',citations:[{id}]}];b.claimIndex=1;
 const before=structuredClone(b),plain=prepareDocumentCitationAudit(question,c,b),enabled=prepareDocumentCitationAudit(question,c,{...b,answerTextContext:'bound-answer-v1'});
 const request=buildDocumentCitationAuditRequest(enabled.packet),input=auditInput(request);
 assert.deepEqual(b,before);assert.equal(input.answerTextContext.targetOriginalIndex,1);
 assert.deepEqual(input.answerTextContext.claims,b.providerSelections.claims.map((claim,originalIndex)=>({originalIndex,text:claim.text})));
 assert.equal(input.answerTextContext.isSourceEvidence,false);assert.deepEqual(enabled.packet.references,plain.packet.references);
 assert.equal(input.references.length,1);assert.equal(input.references[0].kind,'text');
 assert.equal(JSON.stringify(request).includes('data:image/png'),false,'other claims images are never added to target support');
 assert.equal(enabled.binding.answerTextContextSha256,hash(JSON.stringify(input.answerTextContext)));
 assert.notEqual(enabled.bindingSha256,plain.bindingSha256);
 const original=buildDocumentCitationAuditRequest(plain.packet);
 assert.equal(Object.hasOwn(auditInput(original),'answerTextContext'),false);
 assert.equal(typeof original.input[0].content,'string');assert.equal(String(original.input[0].content).includes('Other answer claims in answerTextContext'),false);
});
test('discourse target/index/shape must match the restored target and changes bind the request identity',()=>{
 const c=context(),b=binding(c);b.providerSelections.claims.push(structuredClone(b.providerSelections.claims[0]));b.claimIndex=1;
 const prepared=prepareDocumentCitationAudit(question,c,{...b,answerTextContext:'bound-answer-v1'}),discourse=prepared.packet.answerTextContext!;
 for(const bad of [{...discourse,targetOriginalIndex:-1},{...discourse,isSourceEvidence:true},
  {...discourse,claims:[{originalIndex:0,text:'Changed context.'},{originalIndex:1,text:'A different target.'}]},
  {...discourse,claims:[{originalIndex:1,text:discourse.claims[0].text},discourse.claims[1]]}])
  assert.throws(()=>buildDocumentCitationAuditRequest({...prepared.packet,answerTextContext:bad as typeof discourse}),/Invalid citation-local discourse/);
 const changed=structuredClone(b);changed.providerSelections.claims[0].text='A changed previous claim.';
 const after=prepareDocumentCitationAudit(question,c,{...changed,answerTextContext:'bound-answer-v1'});
 assert.equal(after.packet.claim,prepared.packet.claim);assert.deepEqual(after.packet.references,prepared.packet.references);
 assert.notEqual(after.binding.answerTextContextSha256,prepared.binding.answerTextContextSha256);
 assert.notEqual(after.bindingSha256,prepared.bindingSha256);
});
test('mentioned source attribution reaches the local audit when all actual citations are foreign',()=>{
 const c=context();c.images=[];c.anchors.push({...c.anchors[0],id:'pg:foreign-version:1',document_id:'foreign',
  name:'Different study',source_hash:'foreign-hash',source_version_id:'foreign-source-version',evidence_id:'foreign-evidence',body:'The different study tests six samples.'});
 const q='According to Original study, how many samples are compared?',p=prepareDocumentAnswer(q,c),
  foreign=p.quoteUnits.find(u=>u.supportId==='e1')!,local=prepareDocumentCitationAudit(q,c,{
   inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,claimIndex:0,
   providerSelections:{status:'answered',message:'',claims:[{text:'The paper tests six samples.',citations:[{id:foreign.id}]}]}}),
  input=auditInput(buildDocumentCitationAuditRequest(local.packet));
 assert.equal(input.mentionedSource.documentId,'audit-source');assert.equal(input.mentionedSource.title,'Original study');
 assert.equal(input.references.length,1);assert.equal(input.references[0].source.documentId,'foreign');
 assert.equal(input.references[0].quote,foreign.text);
 const invalid=structuredClone(local.packet);invalid.mentionedSource!.title='Not mentioned';
 assert.throws(()=>buildDocumentCitationAuditRequest(invalid),/mentioned source identity/);
 // Transport and binding are checked here; source correctness still requires content validation.
});

test('local requests retain restored text and image source identity without changing quotes',()=>{
 const c=context(),local=prepareDocumentCitationAudit(question,c,binding(c)),request=buildDocumentCitationAuditRequest(local.packet),
  input=auditInput(request);
 const common={documentId:source.documentId,documentVersionId:source.currentVersionId,sourceVersionId:source.sourceVersionId,
  sourceHash:source.sourceHash,title:'Original study'};
 assert.deepEqual(input.references[0].source,{...common,evidenceId:'original-evidence',locator:'original:1'});
 assert.deepEqual(input.references[1].source,{...common,evidenceId:'image-evidence',locator:'attachment:image'});
 assert.equal(input.references[0].quote,body);
 assert.equal(local.binding.citations[0].quoteSha256,hash(body));
 for(const changed of [undefined,{...input.references[0].source,documentId:''},
  {...input.references[0].source,sourceHash:''},{...input.references[0].source,extra:'unbound'}]){
  const packet=structuredClone(local.packet);packet.references[0].source=changed as any;
  assert.throws(()=>buildDocumentCitationAuditRequest(packet),/source identity/);
 }
 const changed=context();changed.anchors[0].name='Changed title';
 assert.throws(()=>prepareDocumentCitationAudit(question,changed,binding(c)),/source or context changed/);
});

test('a named question and a different cited document both remain visible to the existing audit',()=>{
 const scopedQuestion='According to Original study, how many samples are compared?',c=context();
 c.images=[];c.anchors[0].name='Different study';
 const p=prepareDocumentAnswer(scopedQuestion,c),local=prepareDocumentCitationAudit(scopedQuestion,c,{
  inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,claimIndex:0,
  providerSelections:{status:'answered',message:'',claims:[{text:'The paper compares two samples.',citations:[{id:p.quoteUnits[0].id}]}]}}),
  input=auditInput(buildDocumentCitationAuditRequest(local.packet));
 assert.equal(input.question,scopedQuestion);assert.equal(input.references[0].source.title,'Different study');
 assert.equal(input.references[0].source.documentId,source.documentId);assert.equal(input.references[0].quote,body);
 // This is a transport regression, not a claim that a model rejected the answer.
});

test('citation provenance retains distinct documents for legitimate complementary references',()=>{
 const c=context();c.images=[];c.anchors.push({...c.anchors[0],id:'pg:other-version:1',document_id:'other-document',
  name:'Other study',source_hash:'other-source-sha',source_version_id:'other-source-version',
  evidence_id:'other-evidence',body:'A second study compares three samples.'});
 const p=prepareDocumentAnswer(question,c),local=prepareDocumentCitationAudit(question,c,{
  inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,claimIndex:0,
  providerSelections:{status:'answered',message:'',claims:[{text:'The studies compare two and three samples respectively.',
   citations:p.quoteUnits.map(u=>({id:u.id}))}]}}),
  input=auditInput(buildDocumentCitationAuditRequest(local.packet));
 assert.deepEqual(input.references.map((r:any)=>[r.source.documentId,r.source.title,r.source.documentVersionId]),
  [[source.documentId,'Original study',source.currentVersionId],['other-document','Other study','other-version']]);
 assert.deepEqual(input.references.map((r:any)=>r.quote),[body,'A second study compares three samples.']);
});
function complete(c=context()):CompleteDocumentSourceRead{return {status:'available',context:{...c,parents:[],
 images:c.images.map(image=>'anchorEvidenceId' in image?image:({...image,originalReference:'source.png',provenance:{sourceUrl:'https://example.edu/source.png',revision:'fixture'}})),accounting:{
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
test('local diagnostics reject explicit contradictions while retaining complementary references',()=>{
 const v=diagnostics();assert.equal(validateDocumentCitationAudit(v,['r0','r1']).judgment,'supported');
 assert.throws(()=>validateDocumentCitationAudit({...v,citationFindings:{...v.citationFindings,r1:{judgment:'contradicts',reason:'Explicit opposite.'}}},['r0','r1']),/diagnostics/);
 assert.throws(()=>validateDocumentCitationAudit({...v,objectUnitScope:{...v.objectUnitScope,alignment:'different'}},['r0','r1']),/diagnostics/);
 assert.equal(validateDocumentCitationAudit({...v,judgment:'unsupported',objectUnitScope:{...v.objectUnitScope,alignment:'different'}},['r0','r1']).judgment,'unsupported');
});
async function development<T>(work:()=>Promise<T>){
 const names=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN'] as const;
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]]));
 process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
 process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
 try{return await work();}finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
}
const policy=(raw:DocumentCitationAuditResponse[],beforeAttempt:DocumentCitationAuditPolicy['beforeAttempt']=async()=>{}):DocumentCitationAuditPolicy=>({
 scope:'development',beforeAttempt,recordResponse:async value=>{raw.push(value);}});

test('reasoned-v1 local profile changes only execution settings and binds them without changing default bytes',async()=>{
 const local=prepareDocumentCitationAudit(question,context(),binding()),legacy=buildDocumentCitationAuditRequest(local.packet),
  request=buildDocumentCitationAuditRequest(local.packet,'reasoned-v1');
 assert.equal(JSON.stringify(buildDocumentCitationAuditRequest(local.packet,undefined)),JSON.stringify(legacy));
 assert.deepEqual(request,{...legacy,reasoning:{effort:'medium'},max_output_tokens:4000});
 const old=documentCitationAuditRequestIdentity(legacy,local.bindingSha256),next=documentCitationAuditRequestIdentity(request,local.bindingSha256,'reasoned-v1');
 assert.equal(old.requestIdentity,hash(JSON.stringify({version:'citation-local-audit-v4',providerRequestSha256:old.providerRequestSha256,bindingSha256:local.bindingSha256})));
 assert.notEqual(old.providerRequestSha256,next.providerRequestSha256);assert.notEqual(old.requestIdentity,next.requestIdentity);
 assert.throws(()=>documentCitationAuditRequestIdentity(legacy,local.bindingSha256,'reasoned-v1'),/settings changed/);
 assert.throws(()=>buildDocumentCitationAuditRequest(local.packet,'other' as 'reasoned-v1'),/profile/);
 await assert.rejects(()=>documentAnswerSettings({reasoningEffort:'medium'}),/isolated development/);
 await development(async()=>assert.equal((await documentAnswerSettings({scope:'development',model:'gpt-5.4-mini',reasoningEffort:'medium',
  beforeAttempt:async()=>{}})).effort,'medium'));
});

test('reasoned-v1 reaches the current-source Kernel audit with original selected PNG and durable medium identity',async()=>{
 await database.prepare('SELECT count(*) n FROM ai_ledger').first();
 const kernel=new KernelService(),raw:DocumentCitationAuditResponse[]=[],saved=globalThis.fetch;let calls=0,reads=0;
 kernel.readCompleteDocumentSource=async()=>{reads++;return complete();};
 globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));
  assert.equal(request.model,'gpt-5.4-mini');assert.equal(request.reasoning.effort,'medium');assert.equal(request.max_output_tokens,4000);
  const content=request.input[1].content;assert.equal(content.find((p:{type:string})=>p.type==='input_image').image_url,'data:image/png;base64,'+bytes.toString('base64'));
  assert.deepEqual(withoutSources(JSON.parse(content[0].text).references),[{refId:'r0',kind:'text',quote:body},{refId:'r1',kind:'image'}]);
  return Response.json({...response(),usage:{input_tokens:100,output_tokens:1500}});};
 try{await development(async()=>{
  await assert.rejects(()=>kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),{...policy(raw),auditProfile:'other'} as unknown as DocumentCitationAuditPolicy),/profile/);
  assert.equal(reads,0);assert.equal(calls,0);
  const result=await kernel.auditSelectedStudySourceClaim('owner',question,source,binding(),{...policy(raw),auditProfile:'reasoned-v1'});
  assert.equal(result.status,'available');if(result.status!=='available')throw Error('Missing audit');
  assert.equal(result.result.auditProfile,'reasoned-v1');assert.equal(calls,1);assert.equal(raw.length,1);
  assert.equal(result.result.requestIdentity,raw[0].requestIdentity);assert.equal(result.result.rawResponseSha256,hash(raw[0].rawBody));
  const local=prepareDocumentCitationAudit(question,context(),binding());
  assert.equal(result.result.requestIdentity,documentCitationAuditRequestIdentity(buildDocumentCitationAuditRequest(local.packet,'reasoned-v1'),local.bindingSha256,'reasoned-v1').requestIdentity);
 });}finally{globalThis.fetch=saved;}
});

test('audit restores the entire original selection object and only its actual selected references',()=>{
 const c=context(),original=binding(c),snapshot=JSON.stringify(original),prepared=prepareDocumentCitationAudit(question,c,original);
 const request=buildDocumentCitationAuditRequest(prepared.packet),content=request.input[1].content;
 assert.ok(Array.isArray(content));const input=JSON.parse(content[0].text!);
 assert.deepEqual(input,{question,claim:{claimId:'c0',text:'Two samples are compared.'},
  references:[{refId:'r0',kind:'text',quote:body,source:prepared.packet.references[0].source},{refId:'r1',kind:'image',source:prepared.packet.references[1].source}]});
 assert.equal(request.model,'gpt-5.4-mini');assert.deepEqual(request.reasoning,{effort:'low'});assert.equal(request.max_output_tokens,2000);
 const image=content.find(item=>item.type==='input_image');assert.ok(image&&'image_url' in image);
 assert.equal(image.image_url,'data:image/png;base64,'+bytes.toString('base64'));assert.equal(image.detail,'original');
 const legacyHigh=structuredClone(request),legacyContent=legacyHigh.input[1].content;
 assert.ok(Array.isArray(legacyContent));const legacyImage=legacyContent.find(item=>item.type==='input_image');
 assert.ok(legacyImage&&'detail' in legacyImage);legacyImage.detail='high';
 assert.notEqual(hash(JSON.stringify(request)),hash(JSON.stringify(legacyHigh)),'old audits do not replay the new image detail');
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
  assert.equal(request.max_output_tokens,2000);return Response.json(response());};
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
   assert.equal(result.result.version,'citation-local-audit-v4');
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
  assert.deepEqual(withoutSources(input.references),[{refId:'r0',kind:'text',quote:body},{refId:'r1',kind:'image'}]);
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
