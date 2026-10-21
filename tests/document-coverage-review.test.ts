import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceManifest} from '../lib/kernel/document-context.ts';
import {freezeStudyQuestionContract,prepareCompleteStudyEvidenceRoute} from '../lib/kernel/document-study-contract.ts';
import {buildCompleteStudyCoverageReviewRequest,validateCompleteStudyCoverageReview,prepareDocumentCitationAudit,buildDocumentCitationAuditRequest,
 assessQuestionScopeWitness,validateQuestionScopeWitness,mapQuestionScopeWitness,restoreQuestionScopeBindings,restoreQuestionScopeDischarges,questionScopeRevisionSchema,QUESTION_SCOPE_REVIEW_VERSION,
 DOCUMENT_CITATION_AUDIT_VERSION,type QuestionScopeWitness,type DocumentCitationAuditResponse,type DocumentCitationAuditDiagnostics} from '../lib/kernel/document-citation-audit.ts';
import {preparePlannedStudyGeneration,preparePlannedStudyGenerationTransport,decodePlannedStudyGenerationSelections,
 reviewCompletePlannedStudyAnswer,answerPlannedStudyQuestion,type PlannedStudyAnswerReviewArtifact,type PlannedStudyAnswerPolicy,type PlannedStudyAnswerAttempt} from '../lib/kernel/document-planned-answer.ts';
import {DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,type DocumentAnswerContext,type DocumentAnswerSelections} from '../lib/kernel/document-answer.ts';
import {executeStudyPlanningRequest,studyAnswerPlanRequestBudget,studyPlanningRequestIdentity} from '../lib/kernel/document-answer-plan.ts';

process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='dummy-coverage-never-sent';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'coverage-empty-'+randomUUID());process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>sha(JSON.stringify(v)),
 canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),
 unknown={subject:null,attribute:null,unit:null,population:null,stage:null,configuration:null,time:null},
 image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
const response=(value:unknown)=>Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify(value)});
function fixture(refusal=false){
 const question='What configuration and metrics does the Synthetic report use?',source={documentId:'report',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:sha('source'),courseId:''},
  bodies=['The authors used one fixed configuration.','The experiment reports precision and recall, with SECOND_ORIGINAL_FACT retained.','Figure: original diagram.'],
  anchors=bodies.map((body,i)=>({id:`pg:v1:${i+1}`,document_id:'report',course_id:'',name:'Synthetic report',origin:'fixture',origin_key:'report',source_hash:source.sourceHash,
   source_version_id:'s1',body,locator:`node:${i}`,page_number:i+1,evidence_id:`node${i}`,parser_version:'fixture',score:1,evidence_body:'full-page' as const,
   parser_warnings:['Synthetic parsed source; fidelity unverified.']})),ctx:DocumentAnswerContext={sourceContentIsUntrusted:true,anchors,parents:[],
   images:[{attachmentId:'im0',assetId:sha(image),captionEvidenceId:'node2',sha256:sha(image),byteLength:image.length,width:1,height:1,mime:'image/png',bytes:image,source}]},
  unsigned:Omit<CompleteDocumentSourceManifest,'manifestSha256'>={method:'complete-current-source',nodeOrder:'original-source',complete:true,reason:null,source,
   sourceNodeCount:3,returnedNodeCount:3,sourceBodyCodepoints:bodies.reduce((n,b)=>n+Array.from(b).length,0),sourceBodyUtf8Bytes:bodies.reduce((n,b)=>n+Buffer.byteLength(b),0),
   orderedTextSha256:sha(JSON.stringify(bodies)),structureManifestSha256:sha('structure'),parserWarnings:['Synthetic parsed source; fidelity unverified.'],
   document:{name:'Synthetic report',origin:'fixture',originKey:'report',parserVersion:'fixture'},hierarchy:[],
   nodes:anchors.map((h,i)=>({documentId:'report',documentVersionId:'v1',sourceVersionId:'s1',sourceHash:source.sourceHash,evidenceId:h.evidence_id,locator:h.locator,
    ordinal:i,kind:i===2?'caption':'paragraph',bodySha256:sha(h.body)})),
   images:[{attachmentId:'im0',captionEvidenceId:'node2',sha256:sha(image),byteLength:image.length,width:1,height:1}],imageInputTokenUpper:3,limits:COMPLETE_DOCUMENT_SOURCE_LIMITS},
  manifest={...unsigned,manifestSha256:sha(canonical(unsigned))},context={...ctx,completeSourceProof:{policy:'selected-complete-initial-v1' as const,selectedDocumentTitle:'Synthetic report',manifest}},
  contract=freezeStudyQuestionContract(question,{requirements:[{id:'r0',aspect:'Configuration and metrics',requestedScope:{...unknown}}]},'a'.repeat(64)),
  route=prepareCompleteStudyEvidenceRoute(question,context,contract),packet=preparePlannedStudyGeneration(question,context,[],contract,route.binding,[]),transport=preparePlannedStudyGenerationTransport(packet),
  alias:DocumentAnswerSelections=refusal?{status:'insufficient-evidence',message:'I cannot provide a sufficiently supported answer.',claims:[]}:
   {status:'answered',message:'',claims:[{text:'The report tuned its configuration.',citations:[{id:'Source1'}]},
    {text:'The experiment reports precision and recall.',citations:[{id:'Source2'}]}]},
  rawBody=JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify(alias)}),
  originalRaw={requestIdentity:transport.requestIdentity,providerRequestSha256:transport.providerRequestSha256,httpStatus:200,rawBody,rawSha256:sha(rawBody)},
  artifact:PlannedStudyAnswerReviewArtifact={receipt:packet.receipt,providerSelections:decodePlannedStudyGenerationSelections(alias,packet,transport,transport),
   generation:{requestIdentity:transport.requestIdentity,providerRequestSha256:transport.providerRequestSha256,rawResponseSha256:originalRaw.rawSha256,sourceLabels:transport},originalRaw};
 return {question,context,contract,route,packet,transport,artifact,alias};
}
function journal(mode:'diagnostic'|'one-content-revision'='diagnostic'){
 const attempts:Readonly<PlannedStudyAnswerAttempt>[]=[],raw:(DocumentCitationAuditResponse&{phase?:string})[]=[],states:Record<string,unknown>[]=[];
 const policy:PlannedStudyAnswerPolicy={scope:'development',completeSourceReview:mode,
  beforeAttempt:async a=>{attempts.push(a);},recordResponse:async r=>{assert.equal(sha(r.rawBody),r.rawSha256);raw.push(r);},
  recordState:async s=>{states.push(structuredClone(s));}};return {attempts,raw,states,policy};
}
async function development<T>(work:()=>Promise<T>){
 await database.prepare('DELETE FROM ai_ledger').run();
 const names=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN'] as const,saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';
 try{return await work();}finally{for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
}
const diagnostic=(kind='configuration-role',claims=['c0'])=>({requirements:{r0:{status:'issue',reason:'The actual source describes a fixed setting.'}},
 issues:[{kind,requirementIds:['r0'],questionSpan:null,claimIds:claims,sourceIds:['Source1'],reason:'The original answer labels the fixed setting as tuned.'}]});
const uncertain={requirements:{r0:{status:'uncertain',reason:'No specific source-grounded problem established.'}},issues:[]};
const localUnsupported:DocumentCitationAuditDiagnostics={claimId:'c0',judgment:'unsupported',reason:'The selected configuration statement does not establish tuning.',
 citationFindings:{r0:{judgment:'does-not-establish',reason:'This selected statement says fixed configuration, not tuning.'}},
 objectUnitScope:{claim:'tuning',evidence:'fixed configuration',alignment:'different'}};
function savedLocal(f:ReturnType<typeof fixture>,diagnostics=localUnsupported){
 const local=prepareDocumentCitationAudit(f.question,f.packet.context,{inputFingerprint:f.packet.prepared.fingerprint,quoteUnitManifestSha256:f.packet.prepared.quoteUnitManifestSha256,
  providerSelections:f.artifact.providerSelections,claimIndex:0,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY}),request=buildDocumentCitationAuditRequest(local.packet),
  providerRequestSha256=digest(request),requestIdentity=digest({version:DOCUMENT_CITATION_AUDIT_VERSION,providerRequestSha256,bindingSha256:local.bindingSha256}),
  rawBody=JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify(diagnostics)}),
  originalRaw={providerRequestSha256,requestIdentity,httpStatus:200,rawBody,rawSha256:sha(rawBody)},
  result={version:DOCUMENT_CITATION_AUDIT_VERSION,diagnostics,requestedModel:request.model,model:'gpt-5.4-mini-2026-03-17',providerRequestSha256,requestIdentity,
   rawResponseSha256:originalRaw.rawSha256,binding:local.binding,bindingSha256:local.bindingSha256};
 return {claimIndex:0,result,originalRaw};
}

// Synthetic ID bindings, never an expected semantic answer or entity inventory.
function scopeLedger():QuestionScopeWitness{return {complete:true,requirements:{r0:{findings:[{
 aspectIds:['r0.aspect'],sourceIds:['Source1','Source2'],claimIds:[],judgment:'supports'}]}}};}
function canonicalScope(f:ReturnType<typeof fixture>){
 const built=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,'question-scope-v1'),
  map=(id:string)=>{const entry=f.transport.mapping.entries.find(e=>e.label===id);if(!entry)throw Error('Unknown scope source alias');return entry.canonicalId;},
  data=built.choices.scopeWitness!,choices={...built.choices,sourceIds:built.choices.sourceIds.map(map),scopeWitness:{...data,
   textById:Object.fromEntries(Object.entries(data.textById).map(([id,text])=>[map(id),text])),imageIds:data.imageIds.map(map)}};
 return {built,map,choices};
}

test('ID-only scope protocol keeps default wire and full source, freezes contract aspects and rejects old copied witnesses',()=>{
 const f=fixture(),old=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias),
  unchanged=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,undefined),
  next=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,'question-scope-v1'),
  oldInput=JSON.parse((old.request.input[1].content as {text:string}[])[0].text),input=JSON.parse((next.request.input[1].content as {text:string}[])[0].text);
 assert.equal(JSON.stringify(old),JSON.stringify(unchanged));
 const {scopeBindingRegistry,...retained}=input;assert.deepEqual(retained,oldInput);
 assert.deepEqual(next.request.input[1].content.slice(1),old.request.input[1].content.slice(1));
 assert.deepEqual(scopeBindingRegistry.aspects,[{id:'r0.aspect',requirementId:'r0',field:'aspect',text:'Configuration and metrics'}]);
 assert.equal(scopeBindingRegistry.sha256,digest(scopeBindingRegistry.aspects));assert.deepEqual(input.questionContract,f.contract);
 assert.equal(next.request.max_output_tokens,old.request.max_output_tokens);assert.deepEqual(next.request.reasoning,old.request.reasoning);
 assert.equal(next.request.text.format.name,'complete_study_scope_id_bindings_v2');
 assert.notEqual(studyPlanningRequestIdentity(QUESTION_SCOPE_REVIEW_VERSION,next.request,'binding').requestIdentity,
  studyPlanningRequestIdentity('complete-study-coverage-review-v1',old.request,'binding').requestIdentity);
 const schema=next.request.text.format.schema as unknown as {$defs:Record<string,{properties:Record<string,unknown>}>};
 assert.deepEqual(Object.keys(schema.$defs.scopeFinding.properties),['aspectIds','sourceIds','claimIds','judgment']);
 assert.throws(()=>validateQuestionScopeWitness({complete:true,requirements:{r0:{answerKind:'enumeration',questionSpan:'configuration',qualifiers:[],members:[]}}},next.choices),/Invalid question scope ID/);
 const request=structuredClone(f.transport.request),part=(request.input[1].content as {text:string}[])[0],changed=JSON.parse(part.text);
 changed.questionContract.requirements[0].requestedScope.configuration='explicit fixed configuration';part.text=JSON.stringify(changed);
 const qualified=buildCompleteStudyCoverageReviewRequest(request,f.alias,undefined,'question-scope-v1');
 assert.equal(qualified.choices.scopeWitness!.aspects[1].id,'r0.configuration');
 assert.notEqual(qualified.choices.scopeWitness!.registrySha256,next.choices.scopeWitness!.registrySha256);
});

test('ID-only binding restores exact selected text/image and never rescues a legal wrong source or treats IDs as semantics',()=>{
 const f=fixture(),{built,map,choices}=canonicalScope(f),ledger=scopeLedger(),imageId=built.choices.scopeWitness!.imageIds[0];
 ledger.requirements.r0.findings[0]={aspectIds:['r0.aspect'],sourceIds:['Source1',imageId],claimIds:['c0'],judgment:'supports'};
 const canonical=mapQuestionScopeWitness(ledger,map),bound=restoreQuestionScopeBindings(canonical,choices,f.packet.selectedPrepared);
 assert.equal(bound.bindingsValid,true);assert.equal(bound.semanticVerified,false);assert.equal(bound.findings[0].id,'f0');
 assert.equal(bound.sources[0].kind,'text');assert.equal(bound.sources[0].unit?.text,'The authors used one fixed configuration.');
 assert.equal(bound.sources[1].kind,'image');assert.equal(bound.sources[1].support?.image?.sha256,sha(image));
 assert.equal(bound.sources[1].support?.captionMembers?.[0].text,'Figure: original diagram.');
 const wrong=scopeLedger();wrong.requirements.r0.findings[0].sourceIds=['Source2'];wrong.requirements.r0.findings[0].claimIds=['c0'];
 const restored=restoreQuestionScopeBindings(mapQuestionScopeWitness(wrong,map),choices,f.packet.selectedPrepared);
 assert.equal(restored.sources[0].unit?.text,'The experiment reports precision and recall, with SECOND_ORIGINAL_FACT retained.');
 assert.equal(restored.sources[0].sourceId,map('Source2'));assert.equal(restored.semanticVerified,false);
 assert.equal(assessQuestionScopeWitness(wrong,[{text:'Any claim',citations:[{id:'Source2'}]}]).semanticVerified,false);
 for(const change of [
  (v:QuestionScopeWitness)=>{v.requirements.r0.findings[0].sourceIds=['Source999'];},
  (v:QuestionScopeWitness)=>{v.requirements.r0.findings[0].aspectIds=['r9.aspect'];},
  (v:QuestionScopeWitness)=>{v.requirements.r0.findings[0].claimIds=['c99'];}
 ]){const bad=scopeLedger();change(bad);assert.throws(()=>validateQuestionScopeWitness(bad,built.choices),/Invalid question scope ID/);}
 const stale=structuredClone(built.choices);stale.scopeWitness!.aspects[0].text='changed';
 assert.throws(()=>validateQuestionScopeWitness(scopeLedger(),stale),/Invalid question scope ID/);
 const sourceChanged=structuredClone(f.packet.selectedPrepared);sourceChanged.quoteUnits.find(q=>q.id===map('Source1'))!.text='different';
 assert.throws(()=>restoreQuestionScopeBindings(canonical,choices,sourceChanged),/Scope text source changed/);
 const diagnostic={...uncertain,scopeWitness:ledger,requirements:{r0:{status:'issue',reason:'Fixed and tuned differ.'}},
  issues:[{kind:'configuration-role',aspectIds:['r0.aspect'],claimIds:['c0'],sourceIds:['Source1'],reason:'The chosen statement says fixed.'}]};
 assert.deepEqual(validateCompleteStudyCoverageReview(diagnostic,built.choices).issues[0].requirementIds,['r0']);
});

test('ID-only findings record parallel actual claim edges without pooling semantic support or adding citations',()=>{
 const witness=scopeLedger();witness.requirements.r0.findings[0].claimIds=['c0','c1'];
 const claims=[{text:'First requested case.',citations:[{id:'Source1'}]},
  {text:'Second requested case.',citations:[{id:'Source2'}]}],original=JSON.stringify({witness,claims}),
  assessment=assessQuestionScopeWitness(witness,claims);
 assert.equal(assessment.status,'bindings-linked-awaiting-independent-review');
 assert.deepEqual(assessment.requirements.r0.findings[0].selectedClaimBindings,
  [{claimId:'c0',sourceIds:['Source1']},{claimId:'c1',sourceIds:['Source2']}]);
 assert.equal(assessment.semanticVerified,false);assert.equal(assessment.questionCoverage,'unassessed');
 assert.equal(JSON.stringify({witness,claims}),original);
 assert.equal(assessQuestionScopeWitness(witness,[claims[0],{...claims[1],citations:[{id:'UnboundSource'}]}]).status,'incomplete');
 witness.requirements.r0.findings[0].sourceIds.push('UnselectedSource');
 assert.equal(assessQuestionScopeWitness(witness,claims).status,'incomplete');
});

test('ID-only scope shares actual schema enums and preflights both complete phase schemas',()=>{
 const f=fixture(),build=(n:number)=>{const request=structuredClone(f.transport.request),ids=Array.from({length:n},(_,i)=>`Source${i+1}`);
  request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum=ids;
  const part=(request.input[1].content as {text:string}[])[0],input=JSON.parse(part.text);
  input.quoteUnits=ids.map(id=>({...input.quoteUnits[0],id}));input.evidence=[];
  input.questionContract.requirements=Array.from({length:10},(_,i)=>({...f.contract.requirements[0],id:`r${i}`}));part.text=JSON.stringify(input);
  const coverage=buildCompleteStudyCoverageReviewRequest(request,f.alias,undefined,'question-scope-v1');
  return {coverage,revision:()=>questionScopeRevisionSchema(request.text.format.schema,scopeLedger(),coverage.choices)};},
  enums=(value:unknown):unknown[][]=>!value||typeof value!=='object'?[]:[...(!Array.isArray(value)&&Object.hasOwn(value,'enum')?[(value as {enum:unknown[]}).enum]:[]),...Object.values(value).flatMap(enums)],
  wide=build(100);
 const defs=(wide.coverage.request.text.format.schema as unknown as {$defs:{scopeRequirement:{properties:{findings:{maxItems:number}}};scopeFinding:{properties:Record<string,{minItems?:number;maxItems:number}>}}}).$defs;
 assert.equal(defs.scopeRequirement.properties.findings.maxItems,3);
 assert.equal(defs.scopeFinding.properties.sourceIds.minItems,1);assert.equal(defs.scopeFinding.properties.aspectIds.minItems,1);
 assert.equal(defs.scopeFinding.properties.claimIds.maxItems,30);
 const tooMany={complete:true,requirements:Object.fromEntries(wide.coverage.choices.requirementIds.map(id=>[id,{findings:id==='r0'?Array.from({length:4},()=>scopeLedger().requirements.r0.findings[0]):[]}]))};
 assert.throws(()=>validateQuestionScopeWitness(tooMany,wide.coverage.choices),/Invalid question scope ID/);
 for(const schema of [wide.coverage.request.text.format.schema,wide.revision()]){
  const all=enums(schema);assert.equal(all.filter(e=>e.length===100).length,1);assert.ok(all.reduce((n,e)=>n+e.length,0)<200);
 }
 assert.throws(()=>build(1000),/enum count/);
 const larger=structuredClone(wide.coverage.choices);larger.sourceIds=Array.from({length:1000},(_,i)=>`Source${i+1}`);
 assert.throws(()=>questionScopeRevisionSchema(f.transport.request.text.format.schema,scopeLedger(),larger),/enum count/);
});

test('ID-only scope reuses historical raw, binds one revision and audits only new actual selected references',async()=>{
 const f=fixture(),old=savedLocal(f),artifact={...f.artifact,originalLocalAudits:[old]},before=JSON.stringify(artifact),j=journal('one-content-revision'),
  ledger=scopeLedger(),proposal={answer:{status:'answered',message:'',claims:[{text:'The authors used one fixed configuration and report precision and recall.',citations:[{id:'Source1'},{id:'Source2'}]}]},
   discharges:[{findingId:'f0',binding:{...ledger.requirements.r0.findings[0],claimIds:['c0']}}],unresolvedFindingIds:[]},
  supported={...localUnsupported,judgment:'supported',citationFindings:{r0:{judgment:'supports',reason:'Selected original statement.'},r1:{judgment:'supports',reason:'Selected original metrics.'}},
   objectUnitScope:{claim:'selected statement',evidence:'selected statements',alignment:'same'}},saved=globalThis.fetch,wires:Record<string,unknown>[]=[];
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));wires.push(body);
   return response([{...uncertain,scopeWitness:ledger},proposal,supported][wires.length-1]??assert.fail('Unexpected extra HTTP'));};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,artifact,{...j.policy,scopeWitnessPolicy:'question-scope-v1'});
  assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review','content-revision','revised-claim-audit']);assert.equal(j.raw.length,3);
  assert.equal(result.original.selectedReferenceFindings[0].rawResponseSha256,old.originalRaw.rawSha256);assert.equal(JSON.stringify(artifact),before);
  assert.equal(result.review.version,QUESTION_SCOPE_REVIEW_VERSION);assert.equal(result.review.scopeBindings?.bindingsValid,true);
  assert.equal(result.review.scopeBindings?.semanticVerified,false);assert.ok('scopeRegistrySha256'in result.review.binding);
  assert.equal(result.review.binding.scopeRegistrySha256,result.review.scopeBindings?.registrySha256);
  const candidate=result.revisionCandidate;assert.ok(candidate&&'scopeDischarges'in candidate&&'audits'in candidate);
  assert.equal(candidate.scopeDischarges?.assessment.status,'bindings-linked-awaiting-independent-review');assert.equal(candidate.semanticVerified,false);
  const local=JSON.stringify(wires[2]);assert.ok(!local.includes('scopeWitness'));assert.ok(!local.includes(image.toString('base64')));
  assert.equal((wires[1].text as {format:{name:string}}).format.name,'complete_study_scope_id_revision_v2');
 });}finally{globalThis.fetch=saved;}
});

test('ID-only scope clears old claim links, preserves unresolved findings and rejects invalid policy before source/provider',async()=>{
 const f=fixture(),{built,map,choices}=canonicalScope(f),ledger=scopeLedger(),canonical=mapQuestionScopeWitness(ledger,map),j=journal('one-content-revision'),saved=globalThis.fetch;
 ledger.requirements.r0.findings[0].claimIds=['c0'];
 assert.equal(restoreQuestionScopeDischarges({answer:{},discharges:[],unresolvedFindingIds:[]},canonical,f.artifact.providerSelections.claims,choices,map).assessment.status,'incomplete');
 const changed={answer:{},discharges:[{findingId:'f0',binding:{...ledger.requirements.r0.findings[0],aspectIds:['r0.configuration']}}],unresolvedFindingIds:[]};
 assert.throws(()=>restoreQuestionScopeDischarges(changed,canonical,f.artifact.providerSelections.claims,choices,map),/Invalid question scope discharge/);
 let calls=0;try{await development(async()=>{
  globalThis.fetch=async()=>{calls++;return response(calls===1?{...uncertain,scopeWitness:scopeLedger()}:{answer:f.alias,discharges:[],unresolvedFindingIds:['f0']});};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,f.artifact,{...j.policy,scopeWitnessPolicy:'question-scope-v1'});
  assert.equal(calls,2);assert.equal(result.revisionCandidate?.status,'incomplete-scope-witness');assert.ok(result.revisionCandidate&&!('audits'in result.revisionCandidate));
  for(const policy of [{...j.policy,scopeWitnessPolicy:'invalid'}, {...j.policy,scopeWitnessPolicy:'question-scope-v1',completeSourceReview:undefined},
   {...j.policy,scopeWitnessPolicy:'question-scope-v1',citationRevision:true}])
   await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>{throw Error('Must not read source');},f.artifact,policy as PlannedStudyAnswerPolicy),/scope witness|Scope witnesses|durable development/);
  assert.equal(calls,2);
 });}finally{globalThis.fetch=saved;}
 assert.throws(()=>validateQuestionScopeWitness({complete:true,requirements:{r0:{findings:[{aspectIds:['r0.aspect'],sourceIds:['Source1'],claimIds:['c0'],judgment:'supports',quote:'copied'}]}}},built.choices),/Invalid question scope ID/);
});

test('reasoned-v1 coverage preserves all source bytes and only its exact explicit phase permits medium',async()=>{
 const f=fixture(),legacy=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias),
  next=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,'reasoned-v1');
 assert.equal(JSON.stringify(buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined)),JSON.stringify(legacy));
 assert.deepEqual(next,{...legacy,request:{...legacy.request,reasoning:{effort:'medium'}}});
 const identity=studyPlanningRequestIdentity('review',next.request,'binding','reasoned-v1');
 assert.notEqual(identity.requestIdentity,studyPlanningRequestIdentity('review',next.request,'binding').requestIdentity);
 assert.equal(studyPlanningRequestIdentity('review',legacy.request,'binding').requestIdentity,
  digest({version:'review',providerRequestSha256:digest(legacy.request),bindingSha256:'binding'}));
 const saved=globalThis.fetch;let calls=0,attempts=0;
 try{await development(async()=>{
  globalThis.fetch=async()=>{calls++;throw Error('No HTTP allowed');};
  const p={scope:'development' as const,beforeAttempt:async()=>{attempts++;},recordResponse:async()=>{}},
   bound=studyAnswerPlanRequestBudget(next.request,{prepared:f.packet.selectedPrepared});
  for(const [phase,profile,request]of [
   ['coverage-review',undefined,next.request],['contract-plan','reasoned-v1',next.request],['generation','reasoned-v1',next.request],
   ['coverage-review','reasoned-v1',legacy.request],['coverage-review','other',next.request]
  ]as const)await assert.rejects(()=>executeStudyPlanningRequest('review',phase,request,'binding',bound,p,async()=>{},profile as 'reasoned-v1'|undefined),/settings|profile/);
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>{throw Error('No source read');},f.artifact,
   {...journal().policy,completeSourceReview:undefined,auditProfile:'reasoned-v1',citationRevision:true}),/legacy citation-only/);
  assert.equal(attempts,0);assert.equal(calls,0);
 });}finally{globalThis.fetch=saved;}
});

test('reasoned-v1 reuses untouched old low raw and only newly reviewed or revised evidence uses medium4000',async()=>{
 const f=fixture(),old=savedLocal(f),artifact={...f.artifact,originalLocalAudits:[old]},before=JSON.stringify(artifact),j=journal('one-content-revision'),
  proposal={...f.alias,claims:[{text:'The authors used one fixed configuration.',citations:[{id:'Source1'}]},f.alias.claims[1]]},
  supported={...localUnsupported,judgment:'supported',citationFindings:{r0:{judgment:'supports',reason:'The actual selected statement establishes this claim.'}},
   objectUnitScope:{claim:'selected claim',evidence:'selected statement',alignment:'same'}},saved=globalThis.fetch,wires:Record<string,unknown>[]=[];
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));wires.push(body);
   assert.equal(body.reasoning.effort,'medium');assert.equal(body.max_output_tokens,4000);
   const value=[diagnostic(),proposal,supported,supported][wires.length-1];if(!value)throw Error('Unexpected extra HTTP');
   return response(value);};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,artifact,{...j.policy,auditProfile:'reasoned-v1'});
  assert.equal(wires.length,4);assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review','content-revision','revised-claim-audit','revised-claim-audit']);
  assert.deepEqual(j.attempts.map(a=>a.auditProfile),['reasoned-v1',undefined,'reasoned-v1','reasoned-v1']);
  assert.ok(j.attempts.every(a=>a.maxOutputTokens===4000&&a.fundingUpperUSD>=a.reservationUSD&&a.fundingUpperUSD>=a.usageUpperUSD));
  assert.equal(result.review.auditProfile,'reasoned-v1');assert.equal(result.review.wholeAnswerVerified,false);
  assert.equal(result.original.selectedReferenceFindings[0].requestIdentity,old.result.requestIdentity);
  assert.equal(result.original.selectedReferenceFindings[0].rawResponseSha256,old.originalRaw.rawSha256);
  assert.equal(result.original.selectedReferenceFindings[0].auditProfile,undefined);
  assert.ok(result.revisionCandidate&&'audits'in result.revisionCandidate);if(!result.revisionCandidate||!('audits'in result.revisionCandidate))throw Error('Missing candidate');
  assert.ok(result.revisionCandidate.audits.every(a=>a.result.auditProfile==='reasoned-v1'));
  const local=JSON.stringify(wires[2]);assert.ok(!local.includes('SECOND_ORIGINAL_FACT'));assert.ok(!local.includes(image.toString('base64')));
  assert.ok(JSON.stringify(wires[0]).includes('SECOND_ORIGINAL_FACT'));assert.ok(JSON.stringify(wires[0]).includes(image.toString('base64')));
  assert.equal(JSON.stringify(artifact),before);
  const mislabeled={...artifact,originalLocalAudits:[{...old,result:{...old.result,auditProfile:'reasoned-v1' as const}}]};
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,mislabeled,{...j.policy,auditProfile:'reasoned-v1'}),/raw\/source binding changed/);
  assert.equal(wires.length,4,'Relabeling archived low raw cannot make a new medium execution');
 });}finally{globalThis.fetch=saved;}
});

test('coverage diagnostic keeps complete source input and requires real source/claim/question bindings without local-support judgments',()=>{
 const f=fixture(),before=JSON.stringify(f.transport),built=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias),
  input=JSON.parse((built.request.input[1].content as {text:string}[])[0].text);
 assert.equal(JSON.stringify(f.transport),before);assert.deepEqual(input.quoteUnits,JSON.parse((f.transport.request.input[1].content as {text:string}[])[0].text).quoteUnits);
 assert.deepEqual(input.questionContract,f.contract);assert.equal(input.originalAnswer.claims.length,2);assert.ok(JSON.stringify(input).includes('SECOND_ORIGINAL_FACT'));
 assert.deepEqual((built.request.input[1].content as unknown[]).slice(1),(f.transport.request.input[1].content as unknown[]).slice(1));
 assert.equal(built.request.reasoning.effort,'low');assert.equal(built.request.max_output_tokens,4000);assert.deepEqual(validateCompleteStudyCoverageReview(diagnostic(),built.choices),diagnostic());
 for(const wrong of [ {...diagnostic(),localSupport:{}}, {...diagnostic(),requirements:{}},
  {...diagnostic(),issues:[{...diagnostic().issues[0],sourceIds:['e0']}]}, {...diagnostic(),issues:[{...diagnostic().issues[0],claimIds:['c99']}]},
  {...diagnostic(),issues:[{...diagnostic().issues[0],sourceIds:[]}]}, {...diagnostic(),issues:[{...diagnostic().issues[0],questionSpan:'not in original question'}]},
  {...diagnostic(),requirements:uncertain.requirements}])assert.throws(()=>validateCompleteStudyCoverageReview(wrong,built.choices),/Invalid/);
});

test('standalone review reuses real baseline raw, does not regenerate and never treats uncertainty or refusal as verified',async()=>{
 const f=fixture(true),j=journal('one-content-revision'),before=JSON.stringify(f.artifact),saved=globalThis.fetch;let calls=0;
 try{await development(async()=>{
  globalThis.fetch=async()=>{calls++;return response(uncertain);};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,f.artifact,j.policy);
  assert.equal(calls,1);assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review']);assert.equal(j.raw.length,1);
  assert.equal(result.revisionCandidate,null);assert.equal(result.review.questionCoverage,'unassessed');assert.equal(result.review.wholeAnswerVerified,false);
  assert.equal(result.review.localSupportUnassessed,true);assert.equal(result.original.originalAnswer.status,'insufficient-evidence');
  assert.equal(JSON.stringify(f.artifact),before);assert.ok(j.states.some(s=>s.event==='complete-review-original'));
 });}finally{globalThis.fetch=saved;}
});

test('one content proposal retains original/raw/all evidence and audits only revised selected references, never reuses original coverage',async()=>{
 const f=fixture(),j=journal('one-content-revision'),before=JSON.stringify(f.artifact),saved=globalThis.fetch,wires:unknown[]=[],
  proposal={...f.alias,claims:[{text:'The authors used one fixed configuration.',citations:[{id:'Source1'}]},f.alias.claims[1]]},
  local={claimId:'c0',judgment:'supported',reason:'Actual selected statement.',citationFindings:{r0:{judgment:'supports',reason:'Selected source only.'}},objectUnitScope:{claim:'experiment',evidence:'experiment',alignment:'same'}};
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));wires.push(body);return response([diagnostic(),proposal,local,local][wires.length-1]);};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,f.artifact,j.policy);
  assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review','content-revision','revised-claim-audit','revised-claim-audit']);
  assert.deepEqual(j.attempts.map(a=>a.maxOutputTokens),[4000,4000,1000,1000]);assert.equal(j.raw.length,4);assert.equal(JSON.stringify(f.artifact),before);
  const candidate=result.revisionCandidate;if(!candidate||!('audits'in candidate))throw Error('Missing content proposal');
  assert.equal(candidate.status,'revised-awaiting-independent-review');assert.equal(candidate.answer.claims[0].text,proposal.claims[0].text);
  assert.equal(candidate.answer.claims[1].text,f.alias.claims[1].text);assert.equal(candidate.audits.length,2);assert.equal(candidate.wholeAnswerVerified,false);
  assert.equal(candidate.coverageReview,'not-performed-for-revised-candidate');assert.equal(result.review.binding.originalAnswerSha256,result.original.originalAnswerSha256);
  assert.notEqual(candidate.binding.parent.originalAnswerSha256,digest(candidate.answer));assert.equal(candidate.binding.coverageReviewRawSha256,result.review.rawResponseSha256);
  assert.equal(JSON.parse(JSON.parse(j.raw[1].rawBody).output_text).claims[0].citations[0].id,'Source1','Proposal alias raw stays untouched');
  assert.ok(candidate.providerSelections.claims[0].citations[0].id.startsWith('q:'));
  const text=wires.map(w=>JSON.stringify(w));assert.ok(text[0].includes('SECOND_ORIGINAL_FACT'));assert.ok(text[1].includes('SECOND_ORIGINAL_FACT'));
  assert.ok(text[1].includes(image.toString('base64')));assert.ok(!text[2].includes('SECOND_ORIGINAL_FACT'));assert.ok(!text[2].includes(image.toString('base64')));
  assert.ok(text[3].includes('SECOND_ORIGINAL_FACT'));assert.equal((wires[1] as {reasoning:{effort:string}}).reasoning.effort,'medium');
 });}finally{globalThis.fetch=saved;}
});

test('raw-bound selected-only unsupported triggers one content revision independently of uncertain full-source review',async()=>{
 const f=fixture(),saved=globalThis.fetch,j=journal('one-content-revision'),audit=savedLocal(f),artifact={...f.artifact,originalLocalAudits:[audit]},before=JSON.stringify(artifact),
  corrected={...f.alias,claims:[{text:'The authors used one fixed configuration.',citations:[{id:'Source1'}]},f.alias.claims[1]]},
  supported={...localUnsupported,judgment:'supported',reason:'Actual selected statement.',citationFindings:{r0:{judgment:'supports',reason:'Selected statement establishes this revised claim.'}},
   objectUnitScope:{claim:'experiment',evidence:'experiment',alignment:'same'}},wires:{input:{content:unknown}[]}[]=[];
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{const wire=JSON.parse(String(init?.body));wires.push(wire);return response([uncertain,corrected,supported,supported][wires.length-1]);};
  const tampered=structuredClone(artifact);tampered.originalLocalAudits[0].result.diagnostics.reason+=' edited';
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,tampered,j.policy),/differ from raw/);assert.equal(wires.length,0);
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,artifact,j.policy);
  assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review','content-revision','revised-claim-audit','revised-claim-audit']);assert.equal(wires.length,4);
  assert.equal(result.review.diagnostics.issues.length,0);assert.equal(result.review.localSupportUnassessed,true);
  const candidate=result.revisionCandidate;if(!candidate||!('audits'in candidate))throw Error('Expected separately revised candidate');
  assert.deepEqual(candidate.binding.originalUnsupportedClaimIds,['c0']);assert.equal(candidate.audits.length,2);assert.equal(candidate.audits[0].localSupported,true);
  assert.equal(candidate.coverageReview,'not-performed-for-revised-candidate');assert.equal(candidate.wholeAnswerVerified,false);assert.equal(JSON.stringify(artifact),before);
  assert.equal(result.original.selectedReferenceFindings[0].rawResponseSha256,audit.originalRaw.rawSha256);
  const diagnosticInput=JSON.stringify(wires[0]),revisionInput=JSON.parse((wires[1].input[1].content as {text:string}[])[0].text);
  assert.ok(!diagnosticInput.includes('originalSelectedReferenceFindings'),'Full-source review cannot adjudicate selected-only failures');
  assert.equal(revisionInput.coverageReview.diagnostics.issues.length,0);assert.equal(revisionInput.originalSelectedReferenceFindings.findings[0].references[0].sourceId,'Source1');
  assert.equal(revisionInput.originalSelectedReferenceFindings.findings[0].diagnostics.judgment,'unsupported');
  // A previous uncertain local response is retained but is not an unsupported trigger.
  const uncertainLocal={...localUnsupported,judgment:'uncertain' as const},u=journal('one-content-revision');
  globalThis.fetch=async()=>response(uncertain);
  const noRevision=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,{...f.artifact,originalLocalAudits:[savedLocal(f,uncertainLocal)]},u.policy);
  assert.equal(noRevision.revisionCandidate,null);assert.deepEqual(u.attempts.map(a=>a.phase),['coverage-review']);
 });}finally{globalThis.fetch=saved;}
});

test('stale/tampered original raw, source drift and conflicting revision modes stop without losing original or recorded raw',async()=>{
 const f=fixture(),saved=globalThis.fetch;let calls=0;
 try{await development(async()=>{
  globalThis.fetch=async()=>{calls++;return response(uncertain);};
  const changed=structuredClone(f.artifact);changed.providerSelections.claims[0].text+=' altered';
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,changed,journal().policy),/does not match/);
  const badRaw=structuredClone(f.artifact);badRaw.originalRaw.rawBody+=' ';
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,badRaw,journal().policy),/raw binding/);
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,f.artifact,{...journal().policy,citationRevision:true}),/durable|exclusive/);
  const j=journal(),drifted=structuredClone(f.packet);drifted.context.anchors[0].body+=' source changed';let drift=false;
  globalThis.fetch=async()=>{calls++;drift=true;return response(uncertain);};
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>drift?drifted:f.packet,f.artifact,j.policy),/changed/);
  assert.equal(calls,1);assert.equal(j.raw.length,1);assert.ok(j.states.some(s=>s.event==='complete-review-failed'));
  assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review']);assert.equal(f.artifact.providerSelections.claims[0].text,'The report tuned its configuration.');
 });}finally{globalThis.fetch=saved;}
});

test('invalid revision IDs and more than six claims retain paid raw and never trigger a second proposal or extra audit',async()=>{
 const f=fixture(),saved=globalThis.fetch;
 try{await development(async()=>{
  const j=journal('one-content-revision');let calls=0;
  const bad={...f.alias,claims:[{text:'Replacement.',citations:[{id:'Source999'}]}]};
  globalThis.fetch=async()=>response([diagnostic(),bad][calls++]);
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,f.artifact,j.policy),/Unknown/);
  assert.equal(calls,2);assert.equal(j.raw.length,2);assert.ok(j.states.some(s=>s.event==='complete-review-failed'));
  const large=journal('one-content-revision');calls=0;const oversized={...f.alias,claims:Array.from({length:7},()=>f.alias.claims[0])};
  globalThis.fetch=async()=>response([diagnostic(),oversized][calls++]);
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,f.artifact,large.policy);
  assert.equal(result.revisionCandidate?.status,'capacity-exceeded');assert.equal(calls,2);assert.equal(large.raw.length,2);
  assert.deepEqual(large.attempts.map(a=>a.phase),['coverage-review','content-revision']);
  assert.deepEqual(JSON.parse(JSON.parse(large.raw[1].rawBody).output_text),oversized);
 });}finally{globalThis.fetch=saved;}
});

test('integrated opt-in uses current complete route and actual captured generation raw; ranked mode cannot enable it',async()=>{
 const f=fixture(true),j=journal(),saved=globalThis.fetch;let calls=0;
 try{await development(async()=>{
  globalThis.fetch=async()=>response([f.alias,uncertain][calls++]);
  const result=await answerPlannedStudyQuestion(f.question,async()=>f.context,async()=>{throw Error('No supplements');},f.contract,j.policy,undefined,f.route.binding);
  assert.equal(calls,2);assert.deepEqual(j.attempts.map(a=>a.phase),['generation','coverage-review']);
  if(!('completeSourceReview'in result))throw Error('Missing opt-in review');assert.equal(result.completeSourceReview?.revisionCandidate,null);
  assert.equal(result.providerSelections.status,'insufficient-evidence');assert.equal(result.wholeAnswerVerified,false);
  await assert.rejects(()=>answerPlannedStudyQuestion(f.question,async()=>{throw Error('No reader');},async()=>{throw Error('No supplements');},f.contract,journal().policy),/verified complete-source/);
  assert.equal(calls,2);
  const withClaims=fixture(),full=journal('one-content-revision'),proposal={...withClaims.alias,claims:[
   {text:'The authors used one fixed configuration.',citations:[{id:'Source1'}]},withClaims.alias.claims[1]]},
   supported={...localUnsupported,judgment:'supported',citationFindings:{r0:{judgment:'supports',reason:'Selected evidence establishes the claim.'}},
    objectUnitScope:{claim:'experiment',evidence:'experiment',alignment:'same'}};calls=0;
  globalThis.fetch=async()=>response([withClaims.alias,localUnsupported,supported,uncertain,proposal,supported,supported][calls++]);
  const revised=await answerPlannedStudyQuestion(withClaims.question,async()=>withClaims.context,async()=>{throw Error('No supplements');},withClaims.contract,full.policy,undefined,withClaims.route.binding);
  assert.deepEqual(full.attempts.map(a=>a.phase),['generation','claim-audit','claim-audit','coverage-review','content-revision','revised-claim-audit','revised-claim-audit']);assert.equal(calls,7);
  if(!('completeSourceReview'in revised)||!revised.completeSourceReview)throw Error('Missing revised review');
  assert.equal(revised.completeSourceReview.original.selectedReferenceFindings.length,2);
  assert.equal(revised.completeSourceReview.original.selectedReferenceFindings[0].rawResponseSha256,full.raw[1].rawSha256);
  assert.equal(revised.completeSourceReview.revisionCandidate?.status,'revised-awaiting-independent-review');
  assert.equal(revised.answer.claims[0].text,withClaims.alias.claims[0].text,'The original answer remains the primary result');
 });}finally{globalThis.fetch=saved;}
});
