import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {KernelService} from '../lib/kernel/service.ts';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {prepareStudyAnswerPlan,buildStudyAnswerPlanRequest,validateStudyAnswerPlan,planRetrievedStudyAnswer,
 type StudyAnswerPlan,type StudyAnswerPlanPolicy} from '../lib/kernel/document-answer-plan.ts';

process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='dummy-plan-never-sent';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'study-plan-empty-'+randomUUID());
process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex'),question='How are samples labeled in the two studies?';
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],anchors:[0,1].map(n=>({
 id:`pg:v${n}:1`,document_id:`study${n}`,course_id:'',name:`Synthetic study ${n}`,origin:'fixture',origin_key:`source${n}`,
 source_hash:`sha${n}`,source_version_id:`s${n}`,body:`Study ${n} assigns labels to its original samples.`,locator:'abstract',page_number:1,
 evidence_id:`evidence${n}`,parser_version:'fixture',score:1,evidence_body:'full-page'})),images:[{
 attachmentId:'image',assetId:sha(image),captionEvidenceId:'evidence0',sha256:sha(image),byteLength:image.length,width:1,height:1,
 mime:'image/png',bytes:image,source:{documentId:'study0',currentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0'}}]};}
const unknown={subject:null,attribute:null,unit:null,population:null,stage:null,configuration:null,time:null};
function plan():StudyAnswerPlan{
 const units=prepareStudyAnswerPlan(question,context()).prepared.quoteUnits;
 return {requirements:[{id:'r0',aspect:'Label provenance for both studies',requestedScope:{...unknown}}],
  clusters:units.map((unit,index)=>({id:`c${index}`,requirementIds:['r0'],sourceIds:[unit.id],groundedScope:{...unknown},status:'sufficient'})),
  conflicts:[{leftClusterId:'c0',rightClusterId:'c1',comparability:'different-context',leftSourceIds:[units[0].id],rightSourceIds:[units[1].id],reason:'Different studies; not the same target.'}],missing:[]};
}
async function development<T>(work:()=>Promise<T>){
 const names=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN'] as const,saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
 process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';try{return await work();}finally{for(const n of names){if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];}}
}
function journal(){const attempts:Parameters<StudyAnswerPlanPolicy['beforeAttempt']>[0][]=[],raw:Parameters<StudyAnswerPlanPolicy['recordResponse']>[0][]=[];
 const policy:StudyAnswerPlanPolicy={scope:'development',beforeAttempt:async a=>{attempts.push(a);},recordResponse:async r=>{assert.equal(sha(r.rawBody),r.rawSha256);raw.push(r);}};
 return {attempts,raw,policy};}
const response=(value:unknown)=>Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',
 usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify(value)});

test('plan retains the full existing input and real shared q/image IDs; scope and conflict sides cannot invent evidence',()=>{
 const ctx=context(),packet=prepareStudyAnswerPlan(question,ctx),request=buildStudyAnswerPlanRequest(packet),original=prepareDocumentAnswer(question,ctx);
 const {method:_m,allowedSourceIds:_ids,sourceIdNamespace:_namespace,...retained}=packet.input;
 assert.deepEqual(retained,original.input);assert.equal(packet.prepared.fingerprint,original.fingerprint);
 assert.equal(request.text.format.schema.$defs.sourceId.enum,packet.input.allowedSourceIds);
 const clusterSchema=request.text.format.schema.properties.clusters as {items:{properties:{sourceIds:{items:{$ref:string}}}}};
 assert.equal(clusterSchema.items.properties.sourceIds.items.$ref,'#/$defs/sourceId');
 const content=request.input[1].content as {type:string;detail?:string;image_url?:string}[];
 assert.equal(content.find(c=>c.type==='input_image')?.detail,'original');
 assert.equal(sha(Buffer.from(content.find(c=>c.type==='input_image')!.image_url!.split(',')[1],'base64')),sha(image));
 assert.deepEqual(validateStudyAnswerPlan(plan(),packet.input.allowedSourceIds),plan());
 const invalid=plan();invalid.clusters[0].sourceIds=['e0'];assert.throws(()=>validateStudyAnswerPlan(invalid,packet.input.allowedSourceIds),/Invalid/);
 const invented=plan();invented.clusters[0].sourceIds=[];invented.clusters[0].status='needs-evidence';invented.clusters[0].groundedScope.unit='samples';
 assert.throws(()=>validateStudyAnswerPlan(invented,packet.input.allowedSourceIds),/Invalid/);
 const foreignSide=plan();foreignSide.conflicts[0].leftSourceIds=foreignSide.clusters[1].sourceIds;
 assert.throws(()=>validateStudyAnswerPlan(foreignSide,packet.input.allowedSourceIds),/Invalid/);
 const dropped=plan();dropped.requirements.push({id:'r1',aspect:'Another required aspect',requestedScope:{...unknown}});
 assert.throws(()=>validateStudyAnswerPlan(dropped,packet.input.allowedSourceIds),/Invalid/);
 const overflow={...packet,input:{...packet.input,allowedSourceIds:Array.from({length:995},(_,i)=>'q:'+i)}};
 assert.throws(()=>buildStudyAnswerPlanRequest(overflow),/enum count/);
});

test('one development request journals actual bounds/raw, preserves oversized plans, and stops before paid work on source/billing/input failures',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const originalFetch=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return response(plan());};
 try{await development(async()=>{
  const flat=context(),hit=flat.anchors[0],provenance={method:'flat-persisted-text-v1' as const,manifestSha256:'a'.repeat(64),
   originalHierarchyVerified:false as const,originalFileCompletenessVerified:false as const};
  flat.parents=[{parentId:'flat-node',status:'available',sourceNodeCount:1,sourceBodyCodepoints:hit.body.length,structureProvenance:provenance,
   nodes:[{documentId:hit.document_id,documentVersionId:'v0',sourceVersionId:hit.source_version_id,sourceHash:hit.source_hash,
    evidenceId:hit.evidence_id,locator:hit.locator,body:hit.body,bodySha256:sha(hit.body)}]}];
  const j=journal(),result=await planRetrievedStudyAnswer(question,async()=>flat,j.policy);
  assert.equal(result.status,'planned');if(result.status!=='planned')throw Error('Expected planned');
  assert.deepEqual(result.flatTextContexts,[{parentId:'flat-node',structureProvenance:provenance}]);
  assert.equal(result.inputFingerprint,prepareDocumentAnswer(question,flat).fingerprint);
  assert.notEqual(result.inputFingerprint,prepareDocumentAnswer(question,context()).fingerprint);
  assert.equal(result.completion,'ready-for-review');assert.equal(result.semanticVerified,false);assert.equal(result.wholeAnswerVerified,false);
  assert.equal(calls,1);assert.equal(j.raw.length,1);assert.equal(j.attempts.length,1);assert.ok(j.attempts[0].fundingUpperUSD>=j.attempts[0].reservationUSD);
  assert.equal(j.attempts[0].providerRequestSha256,result.providerRequestSha256);
  const large=plan();large.conflicts=[];large.clusters=Array.from({length:7},(_,n)=>({...large.clusters[0],id:`c${n}`}));
  globalThis.fetch=async()=>{calls++;return response(large);};
  const capacity=await planRetrievedStudyAnswer(question,async()=>context(),journal().policy);
  assert.equal(capacity.status,'planned');if(capacity.status!=='planned')throw Error('Expected planned');
  assert.equal(capacity.completion,'capacity-exceeded');assert.equal(capacity.plan.clusters.length,7);
  const before=calls,changing=journal();let reads=0;
  await assert.rejects(()=>planRetrievedStudyAnswer(question,async()=>{const c=context();if(++reads>1)c.anchors[0].body+=' Changed.';return c;},changing.policy),/source changed/);
  assert.equal(calls,before);assert.equal(changing.attempts.length,1);
  const big=context();big.anchors[0].body='x'.repeat(310000);const limited=journal();
  await assert.rejects(()=>planRetrievedStudyAnswer(question,async()=>big,limited.policy),/input limit/);assert.equal(limited.attempts.length,0);assert.equal(calls,before);
  process.env.AI_BUDGET_TEST_BYPASS='true';await assert.rejects(()=>planRetrievedStudyAnswer(question,async()=>context(),journal().policy),/ordinary ledger/);
  process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MODEL_RATES='{"gpt-5.4-mini":{"input":1,"output":4.5,"context":400000}}';
  await assert.rejects(()=>planRetrievedStudyAnswer(question,async()=>context(),journal().policy),/frozen mini54/);delete process.env.AI_MODEL_RATES;
  globalThis.fetch=async()=>{calls++;return response({invalid:'raw retained'});};const failure=journal();
  await assert.rejects(()=>planRetrievedStudyAnswer(question,async()=>context(),failure.policy),/Invalid retrieved/);
  assert.equal(calls,before+1);assert.equal(failure.raw.length,1);assert.equal(failure.attempts.length,1);
  globalThis.fetch=async()=>{calls++;throw Error('synthetic timeout');};const timeout=journal();
  await assert.rejects(()=>planRetrievedStudyAnswer(question,async()=>context(),timeout.policy),/synthetic timeout/);
  assert.equal(calls,before+2);assert.equal(timeout.raw.length,0);assert.equal(timeout.attempts.length,1);
  const rows=(await database.prepare('SELECT status,charged FROM ai_ledger').all()).results;
  assert.equal(rows.filter(r=>r.status==='reserved'&&r.charged===null).length,1);
 });}finally{globalThis.fetch=originalFetch;process.env.AI_BUDGET_TEST_BYPASS='false';delete process.env.AI_MODEL_RATES;}
});

test('Kernel plan forbids oracle filters and fixes lexical method; default answer request and reader options remain unchanged',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const kernel=new KernelService(),ctx=context(),savedFetch=globalThis.fetch;
 const calls:{owner:string;query:string;options:unknown}[]=[];
 // Only the shared reader is mocked; real Kernel policy, builders, ordinary
 // ledger and actual request callbacks execute. PG/source reader is exercised
 // separately by the existing context tests in the final CI.
 (kernel as unknown as {studyAnswerContextReader:(owner:string,q:string,o:unknown)=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async(owner,q,options)=>{
  calls.push({owner,query:q,options});return async()=>ctx;};
 try{await development(async()=>{
  await assert.rejects(()=>kernel.planStudyAnswer('owner',question,{documentId:'oracle'} as never,journal().policy),/not document/);
  assert.equal(calls.length,0);globalThis.fetch=async()=>response(plan());
  await kernel.planStudyAnswer('owner',question,{},journal().policy);
  assert.deepEqual(calls[0],{owner:'owner',query:question,options:{limit:14,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:true,includeParents:true,includeImages:true}});
 });
 const prepared=prepareDocumentAnswer(question,ctx),expected=buildDocumentAnswerRequest(prepared,{model:'gpt-5-mini',reasoningEffort:'low',maxOutputTokens:4000});
 const options={limit:5,includeParents:true,includeImages:true};let actual:unknown;
 globalThis.fetch=async(_url,init)=>{actual=JSON.parse(String(init?.body));return Response.json({status:'completed',model:'gpt-5-mini',
  usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify({status:'answered',message:'',claims:[{text:'Synthetic sample labeling.',citations:[{id:prepared.quoteUnits[0].id}]}]})});};
 await kernel.answerStudyContent('owner',question,options);assert.deepEqual(actual,expected);assert.deepEqual(calls[1],{owner:'owner',query:question,options});
 }finally{globalThis.fetch=savedFetch;}
});
