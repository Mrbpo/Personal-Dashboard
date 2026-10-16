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
import {buildStudyQuestionContractRequest,freezeStudyQuestionContract,validateStudyQuestionContract,prepareContractStudyPlan,
 buildContractStudyPlanRequest,validateContractStudyPlan,bindContractStudyPlan,prepareStudyClusterCheck,buildStudyClusterCheckRequest,
 validateStudyClusterCheck,createStudyQuestionContract,planContractStudyAnswer,verifyStudyAnswerCluster,type ContractStudyPlan} from '../lib/kernel/document-study-contract.ts';
import {studySupplementQueries,preparePlannedStudyGeneration,buildPlannedStudyGenerationRequest,answerPlannedStudyQuestion,
 type PlannedStudyAnswerPolicy} from '../lib/kernel/document-planned-answer.ts';

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

const contract=()=>freezeStudyQuestionContract(question,{requirements:plan().requirements},'a'.repeat(64));
function contractPlan(ctx=context()):ContractStudyPlan{
 const units=prepareStudyAnswerPlan(question,ctx).prepared.quoteUnits;
 return {...plan(),clusters:[{id:'c0',requirementIds:['r0'],sourceIds:[units[0].id,'i0'],groundedScope:{...unknown},status:'sufficient'},
  {id:'c1',requirementIds:['r0'],sourceIds:[units[1].id],groundedScope:{...unknown},status:'needs-evidence'}],conflicts:[],
  sourceSubscopes:[{requirementId:'r0',scope:{...unknown,subject:'Second study'},sourceIds:[units[1].id],clusterIds:['c1'],status:'missing',reason:'Label provenance not established.'}]};
}
const rawContractPlan=(p:ContractStudyPlan)=>{const {requirements:_r,...raw}=p;return raw;};
function clusterFixture(ctx=context()){
 const c=contract(),prepared=prepareContractStudyPlan(question,ctx,c),p=contractPlan(ctx),body=buildContractStudyPlanRequest(prepared),
  binding=bindContractStudyPlan(prepared,p,sha(JSON.stringify(body)),'b'.repeat(64));
 return {c,prepared,p,binding,packet:prepareStudyClusterCheck(question,ctx,c,binding,'c0')};
}
function clusterResult(ids:string[]){return {scopeSupport:{support:'supported',sourceIds:ids,reason:'Selected references jointly ground the proposed scope.'},
 requirementFindings:{r0:{support:'supported',responsiveness:'answers',sourceIds:ids,reason:'The selected references jointly establish the requested relation.'}},gaps:[] as {requirementId:string;reason:string}[]};}

test('question-only contract fixes original requirements; source discoveries remain fallible sub-scopes under their original ID',()=>{
 const c=contract(),body=buildStudyQuestionContractRequest(question),content=body.input[1].content as {type:string;text:string}[];
 assert.deepEqual(JSON.parse(content[0].text),{question});assert.equal(content.length,1);
 assert.equal(c.providerRequestSha256,sha(JSON.stringify(body)));assert.equal(c.fallible,true);
 assert.deepEqual(validateStudyQuestionContract(question,JSON.parse(JSON.stringify(c))),c);
 assert.throws(()=>validateStudyQuestionContract(question+' different',c),/changed/);
 const changed=structuredClone(c);changed.requirements[0].aspect='Invented requirement';assert.throws(()=>validateStudyQuestionContract(question,changed),/changed/);
 const packet=prepareContractStudyPlan(question,context(),c),req=buildContractStudyPlanRequest(packet),p=contractPlan();
 assert.deepEqual(p.requirements,c.requirements);assert.equal(Object.hasOwn(req.text.format.schema.properties,'requirements'),false);
 assert.deepEqual(validateContractStudyPlan(rawContractPlan(p),c,packet.input.allowedSourceIds),p);
 assert.throws(()=>validateContractStudyPlan(p,c,packet.input.allowedSourceIds),/cannot rewrite/);
 const foreign=rawContractPlan(structuredClone(p));foreign.sourceSubscopes[0].requirementId='r1';
 assert.throws(()=>validateContractStudyPlan(foreign,c,packet.input.allowedSourceIds),/sub-scope/);
 const falseReady=rawContractPlan(structuredClone(p));falseReady.sourceSubscopes[0].status='covered';
 assert.throws(()=>validateContractStudyPlan(falseReady,c,packet.input.allowedSourceIds),/coverage/);
 assert.throws(()=>bindContractStudyPlan(packet,p,'f'.repeat(64),'b'.repeat(64)),/request\/raw identities differ/);
});

test('single-cluster actual wire excludes outside text and complete outside PNG; support, responsiveness and global coverage stay separate',()=>{
 const ctx=context(),poison='OUTSIDE_CLUSTER_UNCITED_PROVENANCE_POISON';ctx.anchors[1].body=poison;
 const outside=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 ctx.images.push({...ctx.images[0],attachmentId:'outside-image',assetId:sha(outside),sha256:sha(outside),bytes:outside,byteLength:outside.length});
 const f=clusterFixture(ctx),body=buildStudyClusterCheckRequest(f.packet),wire=JSON.stringify(body),local=JSON.parse((body.input[1].content as {text:string}[])[0].text);
 assert.ok(!wire.includes(poison));assert.ok(!wire.includes(outside.toString('base64')));assert.ok(wire.includes(image.toString('base64')));
 assert.ok(!wire.includes('study1'));assert.ok(!wire.includes(f.binding.planSha256));assert.ok(!Object.hasOwn(local,'documentMetadata'));
 assert.deepEqual(local.references.map((r:{sourceId:string})=>r.sourceId),f.p.clusters[0].sourceIds);
 assert.equal(f.packet.binding.originalPlanSha256,f.binding.planSha256);assert.equal(f.packet.binding.contractSha256,f.c.contractSha256);
 const ids=f.p.clusters[0].sourceIds,good=validateStudyClusterCheck(clusterResult(ids),f.packet);
 assert.equal(good.localReady,true);assert.equal(good.wholeAnswerVerified,false);assert.equal(good.fullSourceCoverage,'unassessed');assert.equal(good.conflictExhaustiveness,'unassessed');
 const partial=clusterResult(ids);partial.requirementFindings.r0.support='partial';partial.requirementFindings.r0.responsiveness='background-only';
 assert.throws(()=>validateStudyClusterCheck(partial,f.packet),/Invalid/);partial.gaps=[{requirementId:'r0',reason:'Background is not label provenance.'}];
 assert.equal(validateStudyClusterCheck(partial,f.packet).localReady,false);
 const unsupported=clusterResult(ids);unsupported.scopeSupport.support='unsupported';assert.equal(validateStudyClusterCheck(unsupported,f.packet).localReady,false);
 const foreign=clusterResult(['i1']);assert.throws(()=>validateStudyClusterCheck(foreign,f.packet),/Invalid/);
 const changed=structuredClone(f.binding);changed.plan.requirements[0].aspect='Changed';assert.throws(()=>prepareStudyClusterCheck(question,ctx,f.c,changed,'c0'),/binding changed/);
 const wrongRequest=structuredClone(f.binding);wrongRequest.providerRequestSha256='f'.repeat(64);
 assert.throws(()=>prepareStudyClusterCheck(question,ctx,f.c,wrongRequest,'c0'),/binding changed/);
 const imageOnly=context(),sourceHash='c'.repeat(64);imageOnly.anchors[1].parser_warnings=['outside-version-warning'];
 const {score:_score,...node}=imageOnly.anchors[0];imageOnly.imageAnchors=[{...node,id:'pg:iv:1',document_id:'image-only',source_hash:sourceHash,
  source_version_id:'image-version',evidence_id:'image-evidence',body:'UNSELECTED_IMAGE_ANCHOR_BODY',parser_warnings:['selected-image-only-warning'],
  reader_selection:'evidence-node-ids',retrieval_mode:'reader-selection',evidence_body:'full-page'}];
 imageOnly.images[0]={kind:'pdf-page',attachmentId:'selected-image',assetId:sha(image),anchorEvidenceId:'image-evidence',physicalPage:1,
  rawPdfSha256:sourceHash,manifestSha256:'d'.repeat(64),sha256:sha(image),byteLength:image.length,width:1,height:1,mime:'image/png',bytes:image,
  provenance:{rawPdfSha256:sourceHash,pageRenderSha256:sha(image),pageSizePoints:{width:1,height:1},rotation:0,
   rendererPolicy:'synthetic-fixture',sourcePageCropBox:{x:0,y:0,width:1,height:1}},
  source:{documentId:'image-only',currentVersionId:'iv',sourceVersionId:'image-version',sourceHash}};
 const selected=clusterFixture(imageOnly),selectedWire=JSON.stringify(buildStudyClusterCheckRequest(selected.packet));
 assert.deepEqual(selected.packet.warnings,['selected-image-only-warning']);assert.ok(selectedWire.includes('selected-image-only-warning'));
 assert.ok(!selectedWire.includes('outside-version-warning'));assert.ok(!selectedWire.includes('UNSELECTED_IMAGE_ANCHOR_BODY'));
});

test('explicit phases journal raw independently, retain missing/capacity, and reject source changes before any mock paid request',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const savedFetch=globalThis.fetch;let calls=0;
 try{await development(async()=>{
  const j=journal();globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));assert.deepEqual(JSON.parse(body.input[1].content[0].text),{question});return response({requirements:plan().requirements});};
  const q=await createStudyQuestionContract(question,j.policy);assert.equal(q.questionOnly,true);assert.equal(q.semanticVerified,false);assert.equal(j.attempts[0].phase,'question-contract');
  assert.equal(q.contract.rawResponseSha256,j.raw[0].rawSha256);assert.equal(j.raw.length,1);
  const c=q.contract,p=contractPlan(),planned=journal();globalThis.fetch=async()=>{calls++;return response(rawContractPlan(p));};
  const mapped=await planContractStudyAnswer(question,async()=>context(),c,planned.policy);
  assert.equal(mapped.completion,'needs-evidence');assert.deepEqual(mapped.plan.requirements,c.requirements);assert.equal(planned.attempts[0].phase,'contract-plan');
  const capacity=structuredClone(p);capacity.sourceSubscopes=[];capacity.clusters=Array.from({length:7},(_,n)=>({...p.clusters[0],id:`c${n}`}));
  globalThis.fetch=async()=>{calls++;return response(rawContractPlan(capacity));};const large=await planContractStudyAnswer(question,async()=>context(),c,journal().policy);
  assert.equal(large.completion,'capacity-exceeded');assert.equal(large.plan.clusters.length,7);
  const local=journal();globalThis.fetch=async()=>{calls++;return response(clusterResult(p.clusters[0].sourceIds));};
  const checked=await verifyStudyAnswerCluster(question,async()=>context(),c,mapped.binding,'c0',local.policy);
  assert.equal(local.attempts[0].phase,'cluster-check');assert.equal(checked.localReady,true);assert.equal(checked.semanticVerified,false);
  const before=calls,stale=journal();let reads=0;
  await assert.rejects(()=>verifyStudyAnswerCluster(question,async()=>{const ctx=context();if(++reads>1)ctx.anchors[1].body+=' Source changed.';return ctx;},c,mapped.binding,'c0',stale.policy),/binding changed|source changed/);
  assert.equal(stale.attempts.length,1);assert.equal(calls,before);
  const oversized=context();oversized.anchors[0].body='x'.repeat(310000);const bound=journal();
  await assert.rejects(()=>planContractStudyAnswer(question,async()=>oversized,c,bound.policy),/input limit/);assert.equal(bound.attempts.length,0);assert.equal(calls,before);
  const raw=journal();globalThis.fetch=async()=>{calls++;return response({invalid:'Retain original raw, do not repair.'});};
  await assert.rejects(()=>verifyStudyAnswerCluster(question,async()=>context(),c,mapped.binding,'c0',raw.policy),/Invalid/);
  assert.equal(raw.raw.length,1);assert.equal(raw.attempts.length,1);assert.equal(calls,before+1);
  const kernel=new KernelService();let retrievals=0;
  (kernel as unknown as {studyAnswerContextReader:()=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async()=>{retrievals++;return async()=>context();};
  await assert.rejects(()=>kernel.planStudyAnswerWithContract('owner',question,c,{sourceHint:'oracle'} as never,journal().policy),/not document/);
  assert.equal(retrievals,0);
 });}finally{globalThis.fetch=savedFetch;}
});

test('bounded composite retains source q IDs/old images, exposes re-retrieved quotes, and records global image omissions without extra image anchors',()=>{
 const ctx=context();ctx.images=Array.from({length:64},(_,i)=>({...ctx.images[0],attachmentId:'original-'+i}));
 const c=contract(),packet=prepareContractStudyPlan(question,ctx,c),p=contractPlan(ctx);p.clusters=p.clusters.slice(0,1);p.sourceSubscopes=[];
 p.missing=[{requirementId:'r0',reason:'More direct support needed.',supplementQuery:'label judgments origin'}];
 const binding=bindContractStudyPlan(packet,p,sha(JSON.stringify(buildContractStudyPlanRequest(packet))),'b'.repeat(64)),queries=studySupplementQueries(question,c,binding);
 assert.equal(queries.length,2);assert.equal(queries[0].origin,'plan-missing');assert.equal(queries[1].origin,'question-contract');
 const extra={...context(),anchors:ctx.anchors,images:[{...ctx.images[0],attachmentId:'supplemental-image'}]},empty={...context(),anchors:[],images:[]};
 const combined=preparePlannedStudyGeneration(question,ctx,[extra,empty],c,binding,queries),body=buildPlannedStudyGenerationRequest(combined),wire=JSON.stringify(body),
  oldQuote=packet.prepared.quoteUnits[1];
 assert.ok(combined.receipt.originalQuoteIds.includes(oldQuote.id));assert.ok(combined.receipt.selectedSourceIds.includes(oldQuote.id));
 assert.ok(wire.includes(oldQuote.text));assert.equal(combined.context.images.length,64);
 assert.equal(combined.context.images[0].attachmentId,'original-0');assert.equal(combined.context.imageAnchors.length,0);
 assert.equal(combined.context.imageSelection.omitted.find(i=>i.attachmentId==='supplemental-image')?.reason,'image-count-limit');
 assert.equal(combined.receipt.supplemental[0].extraNativeTableLane,false);
 assert.equal(JSON.parse((body.input[1].content as {text:string}[])[0].text).question,question);
 assert.throws(()=>preparePlannedStudyGeneration(question,ctx,[{...extra,imageAnchors:[{} as never]},empty],c,binding,queries),/bounded supplemental/);
 const stale=structuredClone(ctx);stale.anchors[0].body+=' changed';assert.throws(()=>preparePlannedStudyGeneration(question,stale,[extra,empty],c,binding,queries),/binding changed/);
});

test('short chain uses plan/generation/final local only, retains >6 raw claims and stops on post-response source change',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const savedFetch=globalThis.fetch,c=contract(),ctx=context(),p=contractPlan();p.clusters=p.clusters.slice(0,1);p.sourceSubscopes=[];
 ctx.anchors[1].body='OUTSIDE_FINAL_CLAIM_POISON';const q0=prepareDocumentAnswer(question,ctx).quoteUnits[0].id;
 const runJournal=()=>{const j=journal(),states:Record<string,unknown>[]=[];return {...j,states,policy:{...j.policy,
  recordState:async state=>{states.push(structuredClone(state));}} satisfies PlannedStudyAnswerPolicy};};
 const answer={status:'answered',message:'',claims:[{text:'The original study labels its samples.',citations:[{id:q0}]}]},local={claimId:'c0',judgment:'supported',reason:'Actual selected text supports the claim.',
  citationFindings:{r0:{judgment:'supports',reason:'Original label statement.'}},objectUnitScope:{claim:'original study',evidence:'original study',alignment:'same'}};
 try{await development(async()=>{
  let calls=0;const wires:unknown[]=[],j=runJournal(),kernel=new KernelService(),options={courseId:'explicit-user-course'},reads:{options:unknown;nativeTables:unknown}[]=[];
  (kernel as unknown as {studyAnswerContextReader:(owner:string,q:string,o:unknown,native?:boolean)=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async(_owner,q,o,nativeTables)=>{
   reads.push({options:structuredClone(o),nativeTables});return async()=>q===question?ctx:{...ctx,anchors:[ctx.anchors[1]],images:[]};};
  globalThis.fetch=async(_url,init)=>{wires.push(JSON.parse(String(init?.body)));Object.assign(options,{courseId:'mutated',documentId:'oracle'});return response([rawContractPlan(p),answer,local][calls++]);};
  const result=await kernel.answerPlannedStudyContent('owner',question,c,options,j.policy);
  assert.equal(reads.length,2);assert.deepEqual(reads[1],{options:{courseId:'explicit-user-course',limit:4,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:true,includeParents:true,includeImages:true},nativeTables:false});
  assert.equal(calls,3);assert.deepEqual(j.attempts.map(a=>a.phase),['contract-plan','generation','claim-audit']);assert.deepEqual(j.attempts.map(a=>a.maxOutputTokens),[4000,4000,1000]);
  assert.equal(result.status,'generated-awaiting-independent-review');assert.equal(result.wholeAnswerVerified,false);
  if(result.status!=='generated-awaiting-independent-review'||!('audits' in result))throw Error('Expected generated result');
  assert.equal(result.audits.length,1);assert.equal(result.audits[0].localSupported,true);assert.equal(j.raw.length,3);
  assert.ok(JSON.stringify(wires[1]).includes('OUTSIDE_FINAL_CLAIM_POISON'));assert.ok(!JSON.stringify(wires[2]).includes('OUTSIDE_FINAL_CLAIM_POISON'));
  assert.ok(!JSON.stringify(wires[2]).includes(image.toString('base64')));
  const large=runJournal();calls=0;globalThis.fetch=async()=>response(calls++===0?rawContractPlan(p):{...answer,claims:Array.from({length:7},()=>answer.claims[0])});
  const capacity=await answerPlannedStudyQuestion(question,async()=>ctx,async()=>async()=>({...ctx,anchors:[],images:[]}),c,large.policy);
  assert.equal(capacity.status,'capacity-exceeded');assert.equal(calls,2);assert.equal(large.raw.length,2);
  if(!('untruncatedValue' in capacity))throw Error('Expected retained raw claims');assert.equal((capacity.untruncatedValue as typeof answer).claims.length,7);
  const changed=runJournal();let mutate=false;calls=0;
  globalThis.fetch=async()=>{if(calls++===0)return response(rawContractPlan(p));mutate=true;return response(answer);};
  await assert.rejects(()=>answerPlannedStudyQuestion(question,async()=>{const current=structuredClone(ctx);if(mutate)current.anchors[0].body+=' changed';return current;},
   async()=>async()=>({...ctx,anchors:[],images:[]}),c,changed.policy),/binding changed|source changed/);
  assert.equal(calls,2);assert.equal(changed.raw.length,2);
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',question,c,{documentId:'oracle'} as never,runJournal().policy),/not document/);
 });}finally{globalThis.fetch=savedFetch;}
});
