import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {KernelService} from '../lib/kernel/service.ts';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,resolveDocumentAnswerSelections,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest} from '../lib/kernel/document-citation-audit.ts';
import {prepareStudyAnswerPlan,buildStudyAnswerPlanRequest,validateStudyAnswerPlan,planRetrievedStudyAnswer,
 studyPlanningRequestIdentity,type StudyAnswerPlan,type StudyAnswerPlanPolicy} from '../lib/kernel/document-answer-plan.ts';
import {buildStudyQuestionContractRequest,freezeStudyQuestionContract,validateStudyQuestionContract,prepareContractStudyPlan,
 buildContractStudyPlanRequest,validateContractStudyPlan,bindContractStudyPlan,prepareStudyClusterCheck,buildStudyClusterCheckRequest,
 validateStudyClusterCheck,createStudyQuestionContract,planContractStudyAnswer,verifyStudyAnswerCluster,type ContractStudyPlan} from '../lib/kernel/document-study-contract.ts';
import {studySupplementQueries,preparePlannedStudyGeneration,buildPlannedStudyGenerationRequest,preparePlannedStudyGenerationTransport,
 decodePlannedStudyGenerationSelections,PLANNED_STUDY_ANSWER_VERSION,answerPlannedStudyQuestion,
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
 attachmentId:'image',assetId:sha(image),captionEvidenceId:'unread-caption-evidence',sha256:sha(image),byteLength:image.length,width:1,height:1,
 mime:'image/png',bytes:image,source:{documentId:'study0',currentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0'}}]};}
function emptyTitleOutline(kernel:KernelService){kernel.readDocumentOutline=async(_owner,source)=>({
 source:{documentId:source.documentId,currentVersionId:source.currentVersionId,sourceVersionId:source.sourceVersionId,sourceHash:source.sourceHash},
 manifestSha256:'a'.repeat(64),parents:[],nodes:[],sourceContentIsUntrusted:true});}
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
 const schema=req.text.format.schema.properties as unknown as Record<string,{items:{properties:{sourceIds:{minItems:number}}}}>;
 assert.equal(schema.clusters.items.properties.sourceIds.minItems,1);assert.equal(schema.sourceSubscopes.items.properties.sourceIds.minItems,1);
 assert.deepEqual(validateContractStudyPlan(rawContractPlan(p),c,packet.input.allowedSourceIds),p);
 const emptyCluster=rawContractPlan(structuredClone(p));emptyCluster.clusters[0].sourceIds=[];emptyCluster.clusters[0].groundedScope={...unknown};
 emptyCluster.clusters[0].status='needs-evidence';assert.throws(()=>validateContractStudyPlan(emptyCluster,c,packet.input.allowedSourceIds),/actual evidence/);
 const emptySubscope=rawContractPlan(structuredClone(p));emptySubscope.sourceSubscopes[0].sourceIds=[];
 assert.throws(()=>validateContractStudyPlan(emptySubscope,c,packet.input.allowedSourceIds),/sub-scope/);
 const onlyMissing={clusters:[],conflicts:[],sourceSubscopes:[],missing:[{requirementId:'r0',reason:'No actual evidence was retrieved.',supplementQuery:null}]};
 assert.deepEqual(validateContractStudyPlan(onlyMissing,c,packet.input.allowedSourceIds),{requirements:c.requirements,...onlyMissing});
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
 p.clusters[0].sourceIds=p.clusters[0].sourceIds.filter(id=>!id.startsWith('i'));
 p.missing=[{requirementId:'r0',reason:'More direct support needed.',supplementQuery:'label judgments origin'}];
 const binding=bindContractStudyPlan(packet,p,sha(JSON.stringify(buildContractStudyPlanRequest(packet))),'b'.repeat(64)),queries=studySupplementQueries(question,c,binding);
 assert.equal(queries.length,2);assert.equal(queries[0].origin,'plan-missing');assert.equal(queries[1].origin,'question-contract');
 const extra={...context(),anchors:ctx.anchors,images:[{...ctx.images[0],attachmentId:'supplemental-image'}]},empty={...context(),anchors:[],images:[]};
 const combined=preparePlannedStudyGeneration(question,ctx,[extra,empty],c,binding,queries),body=buildPlannedStudyGenerationRequest(combined),wire=JSON.stringify(body),
  oldQuote=packet.prepared.quoteUnits[1];
 assert.ok(combined.receipt.originalQuoteIds.includes(oldQuote.id));assert.ok(combined.receipt.selectedSourceIds.includes(oldQuote.id));
 const advisory=preparePlannedStudyGeneration(question,ctx,[],c,binding,[]);
 assert.ok(advisory.receipt.selectedSourceIds.includes(oldQuote.id));assert.ok(JSON.stringify(buildPlannedStudyGenerationRequest(advisory)).includes(oldQuote.text));
 assert.equal(advisory.receipt.originalTextSelection,'all-original-selectable-v1');assert.equal(advisory.receipt.initialRetrievalScope,'whole-library-query');
 assert.ok(wire.includes(oldQuote.text));assert.equal(combined.context.images.length,64);
 assert.equal((body.input[1].content as {type:string}[]).filter(part=>part.type==='input_image').length,64);
 assert.equal(combined.context.images[0].attachmentId,'original-0');assert.equal(combined.context.imageAnchors.length,0);
 assert.equal(combined.context.imageSelection.omitted.find(i=>i.attachmentId==='supplemental-image')?.reason,'image-count-limit');
 assert.equal(combined.receipt.supplemental[0].extraNativeTableLane,false);
 assert.equal(JSON.parse((body.input[1].content as {text:string}[])[0].text).question,question);
 assert.throws(()=>preparePlannedStudyGeneration(question,ctx,[{...extra,imageAnchors:[{} as never]},empty],c,binding,queries),/bounded supplemental/);
 const stale=structuredClone(ctx);stale.anchors[0].body+=' changed';assert.throws(()=>preparePlannedStudyGeneration(question,stale,[extra,empty],c,binding,queries),/binding changed/);
});

function sourceLabelFixture(){
 const ctx=context(),literalId=prepareDocumentAnswer(question,ctx).quoteUnits[0].id,
  query=question+` Preserve literal ${literalId}, i0 and Source1.`,caption='Table 2: Original study values.',
  other=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 ctx.anchors[1].body+=` Literal IDs are ${literalId}, i0 and Source1.`;ctx.anchors[1].name=literalId;
 ctx.anchors.push({...ctx.anchors[1],id:'pg:v1:2',page_number:2,evidence_id:'caption2',body:caption});
 ctx.images.push({...ctx.images[0],attachmentId:'second-image',captionEvidenceId:'caption2',assetId:sha(other),sha256:sha(other),bytes:other,byteLength:other.length,
  source:{documentId:'study1',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:'sha1'}});
 const c=freezeStudyQuestionContract(query,{requirements:[{...plan().requirements[0],aspect:`Original aspect ${literalId} i0 Source1`}]},'a'.repeat(64)),
  original=prepareContractStudyPlan(query,ctx,c),p=contractPlan(ctx),captionId=original.prepared.quoteUnits[2].id;
 p.requirements=c.requirements;p.clusters[1].sourceIds.push(captionId);
 p.conflicts=[{leftClusterId:'c0',rightClusterId:'c1',comparability:'different-context',leftSourceIds:[literalId],
  rightSourceIds:[p.clusters[1].sourceIds[0]],reason:`Natural explanation ${literalId} and Source1.`}];
 const saved=bindContractStudyPlan(original,p,sha(JSON.stringify(buildContractStudyPlanRequest(original))),'b'.repeat(64)),
  packet=preparePlannedStudyGeneration(query,ctx,[],c,saved,[]);
 return {ctx,query,c,saved,packet,captionId};
}

test('planned SourceN transport is reversible across documents/images without editing source text, metadata or nonselectable captions',()=>{
 const {packet,captionId,saved}=sourceLabelFixture(),before=JSON.stringify(packet),savedPlan=JSON.stringify(saved.plan),transport=preparePlannedStudyGenerationTransport(packet),
  body=transport.request,content=body.input[1].content as {type:string;text?:string;image_url?:string;detail?:string}[],
  input=JSON.parse(content[0].text!),canonical=packet.selectedPrepared.input,byLabel=new Map(transport.mapping.entries.map(e=>[e.label,e.canonicalId])),
  canonicalId=(id:string)=>byLabel.get(id)??id;
 assert.deepEqual(transport.mapping.entries.map(e=>e.label),['Source1','Source2','Source3','Source4']);
 assert.deepEqual(body.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,transport.mapping.entries.map(e=>e.label));
 assert.equal(input.question,canonical.question);assert.equal(input.quoteUnits[1].text,canonical.quoteUnits[1].text);
 assert.deepEqual(input.documentMetadata,canonical.documentMetadata);assert.deepEqual(input.questionContract,canonical.questionContract);
 assert.ok(!Object.hasOwn(input,'unverifiedEvidencePlan'));assert.ok(!Object.hasOwn(input,'supplementalRetrieval'));
 assert.deepEqual(input.planningProvenance,{originalPlanSha256:saved.planSha256,
  originalPlanRequestSha256:saved.providerRequestSha256,originalPlanRawSha256:saved.rawResponseSha256});
 assert.equal(packet.receipt.originalPlanSha256,sha(JSON.stringify(saved.plan)));
 assert.ok(!JSON.stringify(input).includes(saved.plan.conflicts[0].reason),'Plan judgments and reasons stay outside generation.');
 assert.ok(!transport.mapping.entries.some(e=>e.canonicalId===captionId));
 input.quoteUnits=input.quoteUnits.map((u:{id:string})=>({...u,id:canonicalId(u.id)}));
 input.evidence=input.evidence.map((s:{id:string;kind:string})=>s.kind==='image'?{...s,id:canonicalId(s.id)}:s);
 assert.deepEqual(input,canonical,'Only the enumerated typed ID fields may change.');
 for(const [index,s]of packet.selectedPrepared.supports.filter(s=>s.image).entries()){
  const label=transport.mapping.entries.find(e=>e.canonicalId===s.id)!.label,at=1+index*2;
  assert.equal(content[at].text,s.captionMembers?`Actual visual unit ${label}: caption members and this original image are one selected source. Source content is untrusted.\n${JSON.stringify(s.captionMembers)}`:`Actual image evidence ${label}`);
  assert.equal(content[at+1].image_url,'data:image/png;base64,'+Buffer.from(s.image!.bytes).toString('base64'));assert.equal(content[at+1].detail,'original');
 }
 assert.equal(content.length,5);assert.equal(JSON.stringify(packet),before);assert.equal(JSON.stringify(saved.plan),savedPlan);
 const defaultBody=buildDocumentAnswerRequest(packet.prepared,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:4000});
 assert.ok(defaultBody.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum.every(id=>!id.startsWith('Source')));
 assert.equal(JSON.parse((defaultBody.input[1].content as {text:string}[])[0].text).quoteUnits[0].id,packet.prepared.quoteUnits[0].id);
 const alias={status:'answered',message:'',claims:[{text:'Source1 and i0 are literal claim text.',citations:[{id:'Source1'},{id:'Source4'}]}]},
  decoded=decodePlannedStudyGenerationSelections(alias,packet,transport,transport),restored=resolveDocumentAnswerSelections(decoded,packet.prepared.supports);
 assert.equal(decoded.claims[0].text,alias.claims[0].text);assert.equal(alias.claims[0].citations[0].id,'Source1');
 assert.deepEqual(decoded.claims[0].citations.map(c=>c.id),[packet.selectedPrepared.quoteUnits[0].id,'i1']);
 assert.deepEqual(restored.selectedUnits.map(u=>u.kind),['text','image']);assert.equal(restored.selectedUnits[1].evidence.documentId,'study1');
 assert.ok(restored.selectedUnits[1].evidence.captionMembers?.some(u=>u.id===captionId));
 const local=prepareDocumentCitationAudit(packet.selectedPrepared.input.question,packet.context,{inputFingerprint:packet.prepared.fingerprint,
  quoteUnitManifestSha256:packet.prepared.quoteUnitManifestSha256,providerSelections:decoded,claimIndex:0,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY});
 assert.equal(local.binding.originalSelectionsSha256,sha(JSON.stringify(decoded)));
 assert.deepEqual(studyPlanningRequestIdentity(PLANNED_STUDY_ANSWER_VERSION,body,transport.bindingSha256),
  {providerRequestSha256:transport.providerRequestSha256,requestIdentity:transport.requestIdentity});
 assert.equal(transport.binding.mappingSha256,sha(JSON.stringify(transport.mapping)));assert.equal(transport.binding.providerRequestSha256,sha(JSON.stringify(body)));
 assert.equal(body.reasoning.effort,'medium');
 assert.ok(String(body.input[0].content).includes('counted object, unit, processing stage'));
});

test('planned SourceN decoding rejects unknown, duplicate, incomplete, stale and replayed mappings or canonical answers',()=>{
 const {ctx,query,c,saved,packet}=sourceLabelFixture(),transport=preparePlannedStudyGenerationTransport(packet),
  alias={status:'answered',message:'',claims:[{text:'An original claim.',citations:[{id:'Source1'}]}]},
  decode=(value:unknown,t=transport,p=packet,execution=transport)=>decodePlannedStudyGenerationSelections(value,p,t,execution);
 for(const id of ['Source0','Source01','Source999',packet.selectedPrepared.quoteUnits[0].id,'i0']){
  assert.throws(()=>decode({...alias,claims:[{...alias.claims[0],citations:[{id}]}]}),/Unknown or duplicate/);
 }
 assert.throws(()=>decode({...alias,claims:[{...alias.claims[0],citations:[{id:'Source1'},{id:'Source1'}]}]}),/duplicate/);
 assert.throws(()=>decode(decode(alias)),/Unknown/,'Canonical selections cannot be decoded a second time.');
 for(const mutate of [(t:typeof transport)=>{t.mapping.entries.pop();},(t:typeof transport)=>{t.mapping.entries[1].label='Source1';},
  (t:typeof transport)=>{t.mapping.entries[1].canonicalId=t.mapping.entries[0].canonicalId;},
  (t:typeof transport)=>{t.request.input[0].content+=' altered';},(t:typeof transport)=>{t.binding.canonicalInputFingerprint='0'.repeat(64);},
  (t:typeof transport)=>{t.mapping.entries.reverse();}]){
  const altered=structuredClone(transport);mutate(altered);assert.throws(()=>decode(alias,altered),/binding changed/);
 }
 assert.throws(()=>decode(alias,transport,packet,{...transport,requestIdentity:'0'.repeat(64)}),/binding changed/);
 const alteredProvenance=structuredClone(packet);alteredProvenance.selectedPrepared.input.planningProvenance.originalPlanSha256='0'.repeat(64);
 assert.throws(()=>decode(alias,transport,alteredProvenance),/binding changed/,'Opaque plan provenance remains part of the canonical packet binding.');
 // A legitimate new supplement changes the canonical packet while Source1
 // still exists. Replaying the prior mapping/identity must not select it.
 const extra={...context(),anchors:[{...ctx.anchors[0],id:'pg:new-version:1',document_id:'new-study',source_version_id:'new-source',source_hash:'new-hash',evidence_id:'new-evidence'}],images:[]},
  changed=preparePlannedStudyGeneration(query,ctx,[extra],c,saved,[{requirementId:'r0',origin:'question-contract',query:'original supplemental words'}]);
 assert.throws(()=>decode(alias,transport,changed),/binding changed/);
});

test('short chain uses plan/generation/final local only, retains >6 raw claims and stops on post-response source change',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const savedFetch=globalThis.fetch,c=contract(),ctx=context(),p=contractPlan();p.clusters=p.clusters.slice(0,1);p.sourceSubscopes=[];
 ctx.anchors[1].body='OUTSIDE_FINAL_CLAIM_POISON';const q0=prepareDocumentAnswer(question,ctx).quoteUnits[0].id;
 const runJournal=()=>{const j=journal(),states:Record<string,unknown>[]=[];return {...j,states,policy:{...j.policy,
  recordState:async state=>{states.push(structuredClone(state));}} satisfies PlannedStudyAnswerPolicy};};
 const answer={status:'answered',message:'',claims:[{text:'The original study labels its samples.',citations:[{id:'Source1'}]}]},local={claimId:'c0',judgment:'supported',reason:'Actual selected text supports the claim.',
  citationFindings:{r0:{judgment:'supports',reason:'Original label statement.'}},objectUnitScope:{claim:'original study',evidence:'original study',alignment:'same'}};
 try{await development(async()=>{
  let calls=0;const wires:unknown[]=[],j=runJournal(),kernel=new KernelService(),options={courseId:'explicit-user-course'},reads:{options:unknown;nativeTables:unknown}[]=[];
  (kernel as unknown as {studyAnswerContextReader:(owner:string,q:string,o:unknown,native?:boolean)=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async(_owner,q,o,nativeTables)=>{
   reads.push({options:structuredClone(o),nativeTables});return async()=>q===question?ctx:{...ctx,anchors:[ctx.anchors[1]],images:[]};};
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));wires.push(body);Object.assign(options,{courseId:'mutated',documentId:'oracle'});
   if(calls===1)assert.ok(body.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum.includes(answer.claims[0].citations[0].id));
   if(calls===2){assert.equal(j.raw.length,2);assert.equal((j.states.find(s=>s.event==='generation')!.value as typeof answer).claims[0].citations[0].id,q0);}
   return response([rawContractPlan(p),answer,local][calls++]);};
  const result=await kernel.answerPlannedStudyContent('owner',question,c,options,j.policy);
  assert.equal(reads.length,2);assert.deepEqual(reads[1],{options:{courseId:'explicit-user-course',limit:4,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:true,includeParents:true,includeImages:true},nativeTables:false});
  assert.equal(calls,3);assert.deepEqual(j.attempts.map(a=>a.phase),['contract-plan','generation','claim-audit']);assert.deepEqual(j.attempts.map(a=>a.maxOutputTokens),[4000,4000,1000]);
  assert.equal(result.status,'generated-awaiting-independent-review');assert.equal(result.wholeAnswerVerified,false);
  if(result.status!=='generated-awaiting-independent-review'||!('audits' in result))throw Error('Expected generated result');
  assert.equal(result.audits.length,1);assert.equal(result.audits[0].localSupported,true);assert.equal(j.raw.length,3);
  assert.equal(result.providerSelections.claims[0].citations[0].id,q0);
  const sent=j.states.find(s=>s.event==='generation-request')!.transport as ReturnType<typeof preparePlannedStudyGenerationTransport>;
  assert.deepEqual(studyPlanningRequestIdentity(PLANNED_STUDY_ANSWER_VERSION,sent.request,sent.bindingSha256),
   {providerRequestSha256:j.attempts[1].providerRequestSha256,requestIdentity:j.attempts[1].requestIdentity});
  assert.deepEqual(JSON.parse(JSON.parse(j.raw[1].rawBody).output_text),answer,'Alias raw is retained before canonical restoration.');
  assert.equal((j.states.find(s=>s.event==='generation')!.value as typeof answer).claims[0].citations[0].id,q0);
  assert.ok(JSON.stringify(wires[1]).includes('OUTSIDE_FINAL_CLAIM_POISON'));assert.ok(!JSON.stringify(wires[2]).includes('OUTSIDE_FINAL_CLAIM_POISON'));
  assert.ok(!JSON.stringify(wires[2]).includes(image.toString('base64')));
  const opposite={...answer,claims:[{text:'The original study does not label its original samples.',citations:[{id:'Source1'}]}]},
   contradicted={...local,judgment:'unsupported',reason:'The claim denies labeling; the evidence says labels are assigned.',
    citationFindings:{r0:{judgment:'contradicts',reason:'Claim: does not label. Evidence: assigns labels.'}}},negative=runJournal();
  calls=0;globalThis.fetch=async()=>response([rawContractPlan(p),opposite,contradicted][calls++]);
  const unsupported=await answerPlannedStudyQuestion(question,async()=>ctx,async()=>async()=>({...ctx,anchors:[],images:[]}),c,negative.policy);
  if(!('localUnsupportedClaims' in unsupported))throw Error('Expected retained unsupported claim');
  assert.deepEqual(unsupported.localUnsupportedClaims,[0]);assert.equal(unsupported.audits[0].localSupported,false);
  assert.equal(unsupported.answer.claims[0].text,opposite.claims[0].text);assert.deepEqual(unsupported.audits[0].result.diagnostics,contradicted);
  assert.equal(negative.raw.length,3);assert.equal(calls,3,'Contradiction is retained without a new generation or repair.');
  const large=runJournal();calls=0;globalThis.fetch=async()=>response(calls++===0?rawContractPlan(p):{...answer,claims:Array.from({length:7},()=>answer.claims[0])});
  const capacity=await answerPlannedStudyQuestion(question,async()=>ctx,async()=>async()=>({...ctx,anchors:[],images:[]}),c,large.policy);
  assert.equal(capacity.status,'capacity-exceeded');assert.equal(calls,2);assert.equal(large.raw.length,2);
  if(!('untruncatedValue' in capacity))throw Error('Expected retained raw claims');assert.equal((capacity.untruncatedValue as typeof answer).claims.length,7);
  const changed=runJournal();let mutate=false;calls=0;
  globalThis.fetch=async()=>{if(calls++===0)return response(rawContractPlan(p));mutate=true;return response(answer);};
  await assert.rejects(()=>answerPlannedStudyQuestion(question,async()=>{const current=structuredClone(ctx);if(mutate)current.anchors[0].body+=' changed';return current;},
   async()=>async()=>({...ctx,anchors:[],images:[]}),c,changed.policy),/binding changed|source changed/);
  assert.equal(calls,2);assert.equal(changed.raw.length,2);
  const failedJournal=runJournal();calls=0;globalThis.fetch=async()=>response(calls++===0?rawContractPlan(p):answer);
  await assert.rejects(()=>answerPlannedStudyQuestion(question,async()=>ctx,async()=>async()=>({...ctx,anchors:[],images:[]}),c,
   {...failedJournal.policy,recordResponse:async raw=>{await failedJournal.policy.recordResponse(raw);if(raw.phase==='generation')throw Error('synthetic raw journal failure');}}),/raw journal failure/);
  assert.equal(calls,2);assert.equal(failedJournal.raw.length,2);assert.ok(!failedJournal.states.some(s=>s.event==='generation'));
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',question,c,{documentId:'oracle'} as never,runJournal().policy),/not document/);
 });}finally{globalThis.fetch=savedFetch;}
});

test('Kernel learning entry creates and journals the real contract before the existing SourceN chain, rejecting invalid options and changed explicit sources before the next request',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const savedFetch=globalThis.fetch,ctx=context(),title=ctx.anchors[0].name,
  query=`For "${title}", how are the original samples labeled?`,options={courseId:'explicit-course',sourceHint:{selectedDocumentTitle:title}},
  selected={scope:'selected-title-scoped' as const,selectedDocumentTitle:title,status:'resolved' as const,
   document:{documentId:'study0',title,currentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0'}},p=contractPlan(ctx),
  kernel=new KernelService(),j=journal(),states:Record<string,unknown>[]=[],reads:unknown[]=[],
  policy:PlannedStudyAnswerPolicy={...j.policy,recordState:async state=>{states.push(structuredClone(state));}};
 p.clusters=p.clusters.slice(0,1);p.sourceSubscopes=[];
 kernel.resolveDocumentSource=async()=>structuredClone(selected);emptyTitleOutline(kernel);
 (kernel as unknown as {studyAnswerContextReader:(owner:string,q:string,o:Record<string,unknown>)=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async(_owner,_q,o)=>{
  reads.push(structuredClone(o));return async()=>o.sourceHint?{...ctx,anchors:[ctx.anchors[0]],images:[]}:ctx;};
 const local={claimId:'c0',judgment:'supported',reason:'Actual selected text supports the claim.',citationFindings:{r0:{judgment:'supports',reason:'Original source text.'}},
  objectUnitScope:{claim:'original samples',evidence:'original samples',alignment:'same'}};
 let calls=0;
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)),phase=j.attempts.at(-1)!.phase;calls++;
   assert.equal(body.reasoning.effort,phase==='generation'?'medium':'low');
   Object.assign(options,{courseId:'mutated',documentId:'oracle'});options.sourceHint.selectedDocumentTitle='mutated';
   if(phase==='question-contract'){assert.deepEqual(JSON.parse(body.input[1].content[0].text),{question:query});return response({requirements:p.requirements});}
   assert.equal(states[0].event,'question-contract');assert.equal((states[0].result as {contract:{question:string}}).contract.question,query);
   if(phase==='contract-plan')return response(rawContractPlan(p));
   if(phase==='generation'){const labels=body.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum;
    assert.ok(labels.every((id:string)=>/^Source[1-9][0-9]*$/.test(id)));return response({status:'answered',message:'',claims:[{text:'The original study assigns sample labels.',citations:[{id:labels[0]}]}]});}
   assert.equal(phase,'claim-audit');return response(local);
  };
  const result=await kernel.answerLearningContent('owner',query,options,policy);
  assert.equal(result.status,'generated-awaiting-independent-review');assert.equal(result.questionContract.contract.question,query);
  assert.equal(result.questionContract.rawResponseSha256,j.raw[0].rawSha256);assert.equal(result.wholeAnswerVerified,false);
  assert.deepEqual(j.attempts.map(a=>a.phase),['question-contract','contract-plan','generation','claim-audit']);
  assert.deepEqual(j.raw.map(r=>(r as {phase?:string}).phase),j.attempts.map(a=>a.phase));assert.equal(calls,4);
  assert.deepEqual(reads,[{courseId:'explicit-course',limit:14,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:true,includeParents:true,includeImages:true},
   {courseId:'explicit-course',sourceHint:{selectedDocumentTitle:title},limit:4,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:true,includeParents:true,includeImages:true}]);
  const priorReads=reads.length,priorAttempts=j.attempts.length;
  for(const invalid of [{documentId:'oracle'},{semantic:true},{sourceHint:{selectedDocumentTitle:'not in question'}},[]])
   await assert.rejects(()=>kernel.answerLearningContent('owner',query,invalid as never,policy),/not document filters|original question/);
  assert.equal(calls,4);assert.equal(reads.length,priorReads);assert.equal(j.attempts.length,priorAttempts);
  kernel.resolveDocumentSource=async()=>({...selected,status:'not-found'});
  await assert.rejects(()=>kernel.answerLearningContent('owner',query,{sourceHint:{selectedDocumentTitle:title}},policy),/not found/);assert.equal(calls,4);
  const changed=journal(),changedStates:Record<string,unknown>[]=[];let sourceChanged=false;
  kernel.resolveDocumentSource=async()=>({...selected,document:{...selected.document,sourceHash:sourceChanged?'changed':'sha0'}});
  globalThis.fetch=async()=>{calls++;sourceChanged=true;return response({requirements:p.requirements});};
  await assert.rejects(()=>kernel.answerLearningContent('owner',query,{sourceHint:{selectedDocumentTitle:title}},
   {...changed.policy,recordState:async state=>{changedStates.push(structuredClone(state));}}),/changed|no longer current/);
  assert.equal(calls,5);assert.equal(changed.raw.length,1);assert.equal(changed.attempts.length,1);assert.equal(changedStates[0].event,'question-contract');
 });}finally{globalThis.fetch=savedFetch;}
});

test('explicit title brings all14 original caption images outside global text hits into the actual initial/gen/local chain; over-cap and changed manifests stop',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const savedFetch=globalThis.fetch,ctx=context(),title=ctx.anchors[0].name,query=`For "${title}", explain the original table.`,
  source={documentId:'study0',currentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0'},kernel=new KernelService(),j=journal(),states:Record<string,unknown>[]=[],
  policy:PlannedStudyAnswerPolicy={...j.policy,recordState:async state=>{states.push(structuredClone(state));}};
 ctx.anchors.push(...Array.from({length:12},(_,i)=>({...ctx.anchors[1],id:`pg:v1:${i+2}`,page_number:i+2,evidence_id:`global-${i}`,body:`Protected original text${i}.`})));
 const {score:_score,...anchor}=ctx.anchors[0],captionHits=Array.from({length:15},(_,i)=>({...anchor,id:`pg:v0:${i+21}`,page_number:i+21,
  evidence_id:`caption-${i}`,body:`Original caption ${i+1}.`,evidence_body:'full-page' as const,reader_selection:'evidence-node-ids' as const,retrieval_mode:'reader-selection' as const}));
 let count=14,outlineReads=0,drift=false,nodeReads=0,calls=0;
 kernel.resolveDocumentSource=async()=>({scope:'selected-title-scoped',selectedDocumentTitle:title,status:'resolved',document:{...source,title}});
 kernel.readDocumentOutline=async()=>({source,manifestSha256:(drift&&++outlineReads>1?'b':'a').repeat(64),parents:[],sourceContentIsUntrusted:true,
  nodes:captionHits.slice(0,count).map((h,i)=>({documentId:'study0',documentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0',evidenceId:h.evidence_id,
   locator:h.locator,ordinal:i+20,kind:'caption',bodySha256:sha(h.body),bodyCodepoints:h.body.length,caption:h.body}))});
 kernel.readDocumentNodes=async(_owner,expected,ids)=>{nodeReads++;assert.deepEqual(expected,source);return ids.map(id=>captionHits.find(h=>h.evidence_id===id)!);};
 kernel.readDocumentParents=async(_owner,hits,_options,budget)=>{
  assert.ok(budget);const images=hits.flatMap((h,i)=>{const im={...ctx.images[0],attachmentId:`caption-image-${i}`,captionEvidenceId:h.evidence_id,
   originalReference:`Table${i+1}.png`,provenance:{sourceUrl:'https://example.invalid/fixture',revision:'fixture'}};return budget.include(im,15+i)?[im]:[];});
  return {anchors:hits,images,parents:hits.map((h,i)=>({parentId:'caption-parent-'+i,kind:'single-node',source,manifestSha256:'a'.repeat(64),
   firstAnchorRank:i+1,anchorRanks:[i+1],status:'available',sourceNodeCount:1,sourceBodyCodepoints:h.body.length,
   nodeManifest:[{evidenceId:h.evidence_id,locator:h.locator,bodySha256:sha(h.body)}],nodes:[{documentId:'study0',documentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0',
    evidenceId:h.evidence_id,locator:h.locator,ordinal:i+20,kind:'caption',body:h.body,bodySha256:sha(h.body)}]})),
   imageSelection:budget.snapshot(),accounting:{anchorCount:hits.length,parentCount:hits.length,contextNodeCount:hits.length,contextBodyCodepoints:0,imageCount:images.length,imageBytes:0},sourceContentIsUntrusted:true};
 };
 (kernel as unknown as {studyAnswerContextReader:(_owner:string,q:string)=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async(_owner,q)=>async()=>q===query?ctx:{...context(),anchors:[],images:[]};
 const p=contractPlan(ctx);p.clusters=p.clusters.slice(0,1);p.sourceSubscopes=[];
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body)),phase=j.attempts.at(-1)!.phase;
   if(phase==='question-contract')return response({requirements:p.requirements});
   if(phase==='contract-plan'){const input=JSON.parse(body.input[1].content[0].text);assert.equal(input.sourceCaptionProof.totalCaptions,14);
    assert.equal(body.input[1].content.filter((x:{type:string})=>x.type==='input_image').length,15);return response(rawContractPlan(p));}
   if(phase==='generation'){assert.equal(body.reasoning.effort,'medium');const labels=body.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum;
    return response({status:'answered',message:'',claims:[{text:'Original table statement.',citations:[{id:labels.at(-1)}]}]});}
   assert.equal(phase,'claim-audit');const wire=JSON.stringify(body);assert.ok(wire.includes('Original caption 14.'));assert.ok(!wire.includes('Original caption 1.'));
   return response({claimId:'c0',judgment:'supported',reason:'Synthetic image-boundary check.',citationFindings:{r0:{judgment:'supports',reason:'Selected original visual fixture.'}},objectUnitScope:{claim:'fixture',evidence:'fixture',alignment:'same'}});
  };
  const result=await kernel.answerLearningContent('owner',query,{sourceHint:{selectedDocumentTitle:title}},policy);
  assert.equal(calls,4);if(result.status!=='generated-awaiting-independent-review'||!('selectedUnits'in result))throw Error('Expected generated');
  assert.equal(ctx.anchors.length,14);assert.deepEqual(result.receipt.originalQuoteIds.slice(0,14),prepareDocumentAnswer(query,ctx).quoteUnits.map(q=>q.id));
  assert.equal(result.receipt.sourceCaptionProof?.totalCaptions,14);assert.equal(result.selectedUnits[0].selectionId,'i14');
  assert.equal(result.selectedUnits[0].evidence.captionMembers?.[0].text,'Original caption 14.');
  const preparedInput=JSON.parse((result.generation.sourceLabels.request.input[1].content as {text:string}[])[0].text);
  assert.equal(preparedInput.sourceCaptionProof.captions.length,14);
  const proofContext={...ctx,imageAnchors:captionHits.slice(0,3)};
  assert.throws(()=>prepareDocumentAnswer(query,proofContext),/anchor limit/,'Unproved default cap2 stays intact.');
  assert.throws(()=>prepareDocumentAnswer(query,{...proofContext,sourceCaptionProof:{...result.receipt.sourceCaptionProof!,source:{...source,sourceHash:'wrong'}}}),/caption proof/);
  count=15;const before=calls,reads=nodeReads,c=freezeStudyQuestionContract(query,{requirements:p.requirements},'a'.repeat(64));
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',query,c,{sourceHint:{selectedDocumentTitle:title}},policy),/caption capacity/);
  assert.equal(calls,before);assert.equal(nodeReads,reads);const capacity=states.at(-1)!;
  assert.equal(capacity.status,'capacity-exceeded');assert.equal((capacity.proof as {captions:unknown[]}).captions.length,15);
  count=14;drift=true;outlineReads=0;
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',query,c,{sourceHint:{selectedDocumentTitle:title}},policy),/changed|no longer current/);assert.equal(calls,before);
 });}finally{globalThis.fetch=savedFetch;}
});

test('explicit complete user title scopes supplements only, freezes source identity and rejects unresolved or changed sources',async()=>{
 await database.prepare('DELETE FROM ai_ledger').run();const savedFetch=globalThis.fetch,ctx=context(),title=ctx.anchors[0].name,
  query=`For "${title}", where did its labels come from?`,c=freezeStudyQuestionContract(query,{requirements:[{...plan().requirements[0],requestedScope:{...unknown,subject:title}}]},'a'.repeat(64)),
  p=contractPlan(ctx),selected={scope:'selected-title-scoped' as const,selectedDocumentTitle:title,status:'resolved' as const,
   document:{documentId:'study0',title,currentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0'}};
 p.clusters=p.clusters.slice(0,1);p.sourceSubscopes=[];
 const kernel=new KernelService(),reads:Record<string,unknown>[]=[],options={sourceHint:{selectedDocumentTitle:title}},states:Record<string,unknown>[]=[],j=journal(),
  policy:PlannedStudyAnswerPolicy={...j.policy,recordState:async state=>{states.push(structuredClone(state));}};
 let resolutions=0,calls=0;kernel.resolveDocumentSource=async()=>{resolutions++;return structuredClone(selected);};emptyTitleOutline(kernel);
 (kernel as unknown as {studyAnswerContextReader:(owner:string,q:string,o:Record<string,unknown>)=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async(_owner,_q,o)=>{
  reads.push(structuredClone(o));return async()=>o.sourceHint?{...ctx,anchors:[ctx.anchors[0]],images:[]}:ctx;};
 try{await development(async()=>{
  globalThis.fetch=async()=>{options.sourceHint.selectedDocumentTitle='Changed caller title';return response(calls++===0?rawContractPlan(p):{status:'insufficient-evidence',message:'I cannot provide a sufficiently supported answer.',claims:[]});};
  const result=await kernel.answerPlannedStudyContent('owner',query,c,options,policy);
  assert.equal(calls,2);assert.equal(reads[0].sourceHint,undefined);assert.deepEqual(reads[1].sourceHint,{selectedDocumentTitle:title});
  if(!('receipt' in result)||!result.receipt)throw Error('Expected composite receipt');
  assert.equal(result.receipt.initialRetrievalScope,'whole-library-query');assert.equal(result.receipt.supplemental[0].retrievalScope,'selected-title-scoped');
  assert.deepEqual(result.receipt.supplemental[0].sourceSelection,selected);
  assert.equal(result.receipt.supplemental[0].query,c.requirements[0].aspect);assert.ok(result.receipt.supplemental[0].originalQuery?.includes(title));
  assert.equal(result.receipt.supplemental[0].focusPolicy,'resolved-exact-title-query-v2');
  const globalQueries=studySupplementQueries(query,c,result.plan.binding);assert.ok(globalQueries[0].query.includes(title));assert.equal(globalQueries[0].originalQuery,undefined);
  const before=calls,readCount=reads.length;
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',query,c,{sourceHint:{selectedDocumentTitle:'Absent title'}},policy),/original question/);
  assert.equal(reads.length,readCount);assert.equal(calls,before);
  kernel.resolveDocumentSource=async()=>({...selected,status:'ambiguous',matches:[selected.document,selected.document]});
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',query,c,{sourceHint:{selectedDocumentTitle:title}},policy),/ambiguous/);
  kernel.resolveDocumentSource=async()=>({...selected,status:'not-found'});
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',query,c,{sourceHint:{selectedDocumentTitle:title}},policy),/not found/);
  assert.equal(calls,before);resolutions=0;
  kernel.resolveDocumentSource=async()=>({...selected,document:{...selected.document,sourceHash:++resolutions===1?'sha0':'changed'}});
  const changed=journal();calls=0;globalThis.fetch=async()=>{calls++;return response(rawContractPlan(p));};
  await assert.rejects(()=>kernel.answerPlannedStudyContent('owner',query,c,{sourceHint:{selectedDocumentTitle:title}},
   {...changed.policy,recordState:async()=>{}}),/no longer current|changed/);
  assert.equal(calls,1);assert.equal(changed.raw.length,1);
 });}finally{globalThis.fetch=savedFetch;}
});

test('parallel source sub-scopes focus the existing two supplemental slots, preserving explicit gaps and single-scope fallbacks',()=>{
 const ctx=context(),c=contract(),packet=prepareContractStudyPlan(question,ctx,c),p=contractPlan(ctx);p.sourceSubscopes=[];p.missing=[];
 const bind=()=>bindContractStudyPlan(packet,p,sha(JSON.stringify(buildContractStudyPlanRequest(packet))),'b'.repeat(64)),fallback=studySupplementQueries(question,c,bind());
 const sub=(subject:string)=>({requirementId:'r0',scope:{...unknown,subject},sourceIds:[packet.input.allowedSourceIds[0]],clusterIds:[],status:'missing' as const,reason:'REASON_MUST_NOT_BECOME_QUERY'});
 p.sourceSubscopes=[sub('First corpus')];assert.deepEqual(studySupplementQueries(question,c,bind()),fallback);
 p.sourceSubscopes.push(structuredClone(p.sourceSubscopes[0]));assert.deepEqual(studySupplementQueries(question,c,bind()),fallback);
 p.sourceSubscopes.push(sub('Second corpus'));const queries=studySupplementQueries(question,c,bind());
 assert.deepEqual(queries.map(q=>q.origin),['plan-source-subscope','plan-source-subscope']);assert.deepEqual(queries.map(q=>q.sourceSubscopeIndex),[0,2]);
 assert.deepEqual(queries.map(q=>q.query),[c.requirements[0].aspect+' First corpus',c.requirements[0].aspect+' Second corpus']);
 assert.ok(queries.every(q=>q.originalQuery===q.query&&q.queryPolicy==='parallel-source-subscopes-v1'&&!q.query.includes('REASON_MUST_NOT_BECOME_QUERY')));
 const empty={...ctx,anchors:[],parents:[],images:[]},combined=preparePlannedStudyGeneration(question,ctx,[empty,empty],c,bind(),queries);
 assert.equal(combined.receipt.version,'contract-supplement-answer-v7');assert.deepEqual(combined.receipt.supplemental.map(q=>q.sourceSubscopeIndex),[0,2]);
 p.missing=[{requirementId:'r0',reason:'Actual gap.',supplementQuery:'explicit missing relation'}];
 const bounded=studySupplementQueries(question,c,bind());assert.equal(bounded.length,2);assert.equal(bounded[0].origin,'plan-missing');assert.equal(bounded[1].sourceSubscopeIndex,0);
 p.missing=[];p.sourceSubscopes[0].scope.configuration='Original Study 0';
 const resolved={status:'resolved' as const,scope:'selected-title-scoped' as const,selectedDocumentTitle:'Original Study 0',document:{documentId:'study0',title:'Original Study 0',currentVersionId:'v0',sourceVersionId:'s0',sourceHash:'sha0'}},
  focusQuestion=question+' Original Study 0',focusContract=freezeStudyQuestionContract(focusQuestion,{requirements:c.requirements},'a'.repeat(64)),
  focused=studySupplementQueries(focusQuestion,focusContract,bind(),resolved);
 assert.ok(focused[0].originalQuery?.includes('Original Study 0'));assert.ok(!focused[0].query.includes('Original Study 0'));
 p.missing=[{requirementId:'r0',reason:'Actual gap.',supplementQuery:'For Original Study 0 compare Original Study 0 methods'}];
 const allOrigins=studySupplementQueries(focusQuestion,focusContract,bind(),resolved);
 assert.equal(allOrigins[0].query,'For compare methods');assert.equal(allOrigins[0].originalQuery,p.missing[0].supplementQuery);
 assert.equal(allOrigins[0].focusPolicy,'resolved-exact-title-query-v2');
 assert.throws(()=>studySupplementQueries(question,c,bind(),resolved),/complete question/);
});

test('visual units keep exact caption members with their original image; legacy q-only answers and outside evidence stay separate',()=>{
 const ctx=context(),caption='Table 1: Results for the original study.',poison='UNSELECTED_VISUAL_CAPTION_POISON',
  outside=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 ctx.anchors[0].body=caption;ctx.anchors[1].body=poison;ctx.images[0]={...ctx.images[0],captionEvidenceId:'evidence0'};
 ctx.images.push({...ctx.images[0],attachmentId:'outside',captionEvidenceId:'evidence1',assetId:sha(outside),sha256:sha(outside),bytes:outside,byteLength:outside.length,
  source:{documentId:'study1',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:'sha1'}});
 const legacy=prepareDocumentAnswer(question,ctx),prepared=prepareDocumentAnswer(question,ctx,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY),old=legacy.quoteUnits[0],member=prepared.quoteUnits[0],
  body=buildDocumentAnswerRequest(prepared,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:4000}),content=body.input[1].content as {type:string;text?:string;image_url?:string}[];
 assert.deepEqual({...member,selectable:true},old);assert.equal(member.selectable,false);assert.equal(prepared.input.unitPolicy,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);
 assert.notEqual(prepared.fingerprint,legacy.fingerprint);assert.notEqual(prepared.quoteUnitManifestSha256,legacy.quoteUnitManifestSha256);
 assert.deepEqual(prepared.supports.find(s=>s.id==='i0')!.captionMembers,[member]);
 assert.equal(prepared.visualUnitManifest?.[0].sha256,sha(image));assert.deepEqual(prepared.visualUnitManifest?.[0].captionMembers,[member]);
 assert.deepEqual(body.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,['i0','i1']);
 const at=content.findIndex(part=>part.text?.startsWith('Actual visual unit i0:'));
 assert.ok(content[at].text!.includes(caption));assert.equal(content[at+1].image_url,'data:image/png;base64,'+image.toString('base64'));
 const selections=(id:string)=>({status:'answered',message:'',claims:[{text:'Original table results.',citations:[{id}]}]});
 const historical=resolveDocumentAnswerSelections(selections(old.id),legacy.supports);
 assert.equal(historical.selectedUnits[0].kind,'text');assert.equal(historical.selectedUnits[0].evidence.captionMembers,undefined);
 assert.throws(()=>resolveDocumentAnswerSelections(selections(old.id),prepared.supports),/ungrounded/);
 const restored=resolveDocumentAnswerSelections(selections('i0'),prepared.supports);
 assert.deepEqual(restored.selectedUnits[0].evidence.captionMembers,[member]);
 const binding={inputFingerprint:prepared.fingerprint,quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,providerSelections:restored.providerSelections,claimIndex:0,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY} as const,
  local=prepareDocumentCitationAudit(question,ctx,binding),request=buildDocumentCitationAuditRequest(local.packet),wire=JSON.stringify(request);
 assert.equal(local.binding.unitPolicy,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);assert.ok(wire.includes(caption));assert.ok(wire.includes(image.toString('base64')));
 assert.ok(!wire.includes(poison));assert.ok(!wire.includes(outside.toString('base64')));assert.equal(local.packet.references.length,1);
 const {unitPolicy:_policy,...noPolicy}=binding;assert.throws(()=>prepareDocumentCitationAudit(question,ctx,noPolicy),/context changed/);
 const changed=structuredClone(ctx);changed.anchors[0].body+=' changed';assert.throws(()=>prepareDocumentCitationAudit(question,changed,binding),/context changed/);
 for(const key of ['documentId','currentVersionId','sourceVersionId','sourceHash'] as const){const foreign=structuredClone(ctx);foreign.images[0].source[key]+='-other';
  const unpaired=prepareDocumentAnswer(question,foreign,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);
  assert.equal(unpaired.supports.find(s=>s.id==='i0')!.captionMembers,undefined);assert.equal(unpaired.quoteUnits[0].selectable,true);}
 for(const incomplete of [({...ctx,images:ctx.images.slice(1)}),({...ctx,anchors:ctx.anchors.slice(1)}),({...ctx,images:[...ctx.images,{...ctx.images[0],attachmentId:'ambiguous'}]})]){
  const unpaired=prepareDocumentAnswer(question,incomplete,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);
  assert.ok(!unpaired.supports.some(s=>s.captionMembers?.some(m=>m.text===caption)));}
 const pdf=structuredClone(ctx);pdf.anchors[0].source_hash='a'.repeat(64);pdf.images[0]={...pdf.images[0],anchorEvidenceId:'evidence0',kind:'pdf-page',physicalPage:1,
  rawPdfSha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),source:{...pdf.images[0].source,sourceHash:'a'.repeat(64)}};
 assert.equal(prepareDocumentAnswer(question,pdf,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY).supports.find(s=>s.id==='i0')!.captionMembers,undefined);
 const c=contract(),initial=prepareContractStudyPlan(question,ctx,c),p=contractPlan(ctx);p.clusters=[{...p.clusters[0],sourceIds:[old.id]}];p.sourceSubscopes=[];
 const saved=bindContractStudyPlan(initial,p,sha(JSON.stringify(buildContractStudyPlanRequest(initial))),'b'.repeat(64)),combined=preparePlannedStudyGeneration(question,ctx,[],c,saved,[]),
  generation=buildPlannedStudyGenerationRequest(combined);
 assert.equal(combined.receipt.unitPolicy,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);assert.ok(!combined.receipt.selectedSourceIds.includes(old.id));
 assert.ok(!generation.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum.includes(old.id));
 assert.ok(JSON.stringify(generation).includes(old.id),'Original caption ID is retained as a member and old advisory-plan provenance.');
});
