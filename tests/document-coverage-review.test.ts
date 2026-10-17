import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceManifest} from '../lib/kernel/document-context.ts';
import {freezeStudyQuestionContract,prepareCompleteStudyEvidenceRoute} from '../lib/kernel/document-study-contract.ts';
import {buildCompleteStudyCoverageReviewRequest,validateCompleteStudyCoverageReview,prepareDocumentCitationAudit,buildDocumentCitationAuditRequest,
 assessQuestionScopeWitness,validateQuestionScopeWitness,mapQuestionScopeWitness,restoreQuestionScopeDischarges,questionScopeRevisionSchema,QUESTION_SCOPE_REVIEW_VERSION,
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

// Synthetic protocol bindings only: quoted identity is not semantic verification.
function scopeLedger():QuestionScopeWitness{return {complete:true,requirements:{r0:{answerKind:'enumeration',questionSpan:'configuration',qualifiers:['metrics'],
 members:[{id:'m0',label:'configuration',status:'eligible',claimIds:[],witnesses:[
  {sourceId:'Source1',questionSpan:'configuration',quote:'The authors used one fixed configuration.',judgment:'supports'},
  {sourceId:'Source2',questionSpan:'metrics',quote:'The experiment reports precision and recall, with SECOND_ORIGINAL_FACT retained.',judgment:'supports'}]}]}}};}

test('question-scope-v1 opt-in preserves old wire, complete source bytes and settings while binding a distinct semantic identity',()=>{
 const f=fixture(),old=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias),
  unchanged=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,undefined),
  next=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,'question-scope-v1'),
  input=(r:typeof old.request)=>JSON.parse((r.input[1].content as {text:string}[])[0].text);
 assert.equal(JSON.stringify(old),JSON.stringify(unchanged));assert.deepEqual(next.request.input[1],old.request.input[1]);
 assert.deepEqual(input(next.request).questionContract,f.contract);assert.equal(next.request.max_output_tokens,old.request.max_output_tokens);
 assert.deepEqual(next.request.reasoning,old.request.reasoning);assert.equal(next.request.text.format.name,'complete_study_scope_witness_v1');
 assert.notEqual(studyPlanningRequestIdentity(QUESTION_SCOPE_REVIEW_VERSION,next.request,'binding').requestIdentity,
  studyPlanningRequestIdentity('complete-study-coverage-review-v1',old.request,'binding').requestIdentity);
 assert.throws(()=>buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,'bad' as 'question-scope-v1'),/Invalid question/);
});

test('question-scope-v1 enumeration, positive existence and selected qualification witnesses remain distinct',()=>{
 const f=fixture(),built=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,'question-scope-v1'),ledger=scopeLedger(),
  claims=[{text:'One fixed configuration; precision and recall.',citations:[{id:'Source1'},{id:'Source2'}]}];
 ledger.requirements.r0.members[0].claimIds=['c0'];validateQuestionScopeWitness(ledger,built.choices);
 assert.equal(assessQuestionScopeWitness(ledger,claims).status,'accounted-awaiting-independent-review');
 assert.equal(assessQuestionScopeWitness(ledger,[{...claims[0],citations:[{id:'Source1'}]}]).status,'incomplete');
 // Two different claims cannot pool their citations to discharge one qualified assertion.
 ledger.requirements.r0.members[0].claimIds=['c0','c1'];
 assert.equal(assessQuestionScopeWitness(ledger,[{...claims[0],citations:[{id:'Source1'}]},{...claims[0],citations:[{id:'Source2'}]}]).status,'incomplete');
 ledger.requirements.r0.members.push({id:'m1',label:'precision',status:'unclear',claimIds:[],witnesses:[
  {sourceId:'Source2',questionSpan:'metrics',quote:'precision and recall',judgment:'unclear'}]});
 assert.equal(assessQuestionScopeWitness(ledger,claims).status,'incomplete');
 ledger.requirements.r0.answerKind='existence';assert.equal(assessQuestionScopeWitness(ledger,claims).status,'accounted-awaiting-independent-review');
 ledger.complete=false;assert.equal(assessQuestionScopeWitness(ledger,claims).status,'incomplete');ledger.complete=true;
 ledger.requirements.r0.members[1].status='excluded';assert.throws(()=>validateQuestionScopeWitness(ledger,built.choices),/Invalid/);
 ledger.requirements.r0.members[1].witnesses[0].judgment='contradicts';validateQuestionScopeWitness(ledger,built.choices);
 ledger.requirements.r0.answerKind='enumeration';assert.equal(assessQuestionScopeWitness(ledger,claims,['m1']).status,'incomplete');
 for(const change of [
  (v:QuestionScopeWitness)=>{v.requirements.r0.questionSpan='invented question qualifier';},
  (v:QuestionScopeWitness)=>{v.requirements.r0.members[0].witnesses[0].sourceId='Source999';},
  (v:QuestionScopeWitness)=>{v.requirements.r0.members[0].witnesses[0].quote='invented source quote';},
  (v:QuestionScopeWitness)=>{v.requirements.r0.members[0].claimIds=['c99'];}
 ]){const wrong=structuredClone(ledger);change(wrong);assert.throws(()=>validateQuestionScopeWitness(wrong,built.choices),/Invalid/);}
});

test('question-scope-v1 restores every typed discharge text/image alias and never carries old claim IDs into a candidate',()=>{
 const f=fixture(),built=buildCompleteStudyCoverageReviewRequest(f.transport.request,f.alias,undefined,'question-scope-v1'),
  toCanonical=(id:string)=>{const entry=f.transport.mapping.entries.find(e=>e.label===id);if(!entry)throw Error('Unknown scope source alias');return entry.canonicalId;},
  ledger=scopeLedger(),imageId=built.choices.scopeWitness!.imageIds[0];
 ledger.requirements.r0.members[0].witnesses.push({sourceId:imageId,questionSpan:'metrics',quote:null,judgment:'supports'});
 const canonical=mapQuestionScopeWitness(ledger,toCanonical),data=built.choices.scopeWitness!,choices={...built.choices,
  sourceIds:built.choices.sourceIds.map(toCanonical),scopeWitness:{...data,imageIds:data.imageIds.map(toCanonical),
   textById:Object.fromEntries(Object.entries(data.textById).map(([id,body])=>[toCanonical(id),body]))}},
  claims=[{text:'Configuration and metrics.',citations:[{id:toCanonical('Source1')},{id:toCanonical('Source2')},{id:toCanonical(imageId)}]}],
  proposal={answer:{},discharges:[{memberId:'m0',status:'eligible',witnesses:ledger.requirements.r0.members[0].witnesses,claimIds:['c0']}],unresolvedMemberIds:[]};
 const restored=restoreQuestionScopeDischarges(proposal,canonical,claims,choices,toCanonical);
 assert.deepEqual(restored.witness.requirements.r0.members[0].witnesses.map(w=>w.sourceId),['Source1','Source2',imageId].map(toCanonical));
 assert.equal(restored.assessment.status,'accounted-awaiting-independent-review');
 assert.equal(restoreQuestionScopeDischarges({...proposal,discharges:[]},canonical,claims,choices,toCanonical).assessment.status,'incomplete');
 const invalid=structuredClone(proposal);invalid.discharges[0].witnesses[2].sourceId='Source999';
 assert.throws(()=>restoreQuestionScopeDischarges(invalid,canonical,claims,choices,toCanonical),/Unknown scope/);
});

test('question-scope-v1 uses one existing revision, restores witnesses and audits only the actual selected candidate references',async()=>{
 const f=fixture(),old=savedLocal(f),artifact={...f.artifact,originalLocalAudits:[old]},before=JSON.stringify(artifact),j=journal('one-content-revision'),
  ledger=scopeLedger(),proposal={answer:{status:'answered',message:'',claims:[{text:'The authors used one fixed configuration and report precision and recall.',citations:[{id:'Source1'},{id:'Source2'}]}]},
   discharges:[{memberId:'m0',status:'eligible',witnesses:ledger.requirements.r0.members[0].witnesses,claimIds:['c0']}],unresolvedMemberIds:[]},
  supported={...localUnsupported,judgment:'supported',citationFindings:{r0:{judgment:'supports',reason:'Selected original statement.'},r1:{judgment:'supports',reason:'Selected original metrics.'}},
   objectUnitScope:{claim:'selected statement',evidence:'selected statements',alignment:'same'}},saved=globalThis.fetch,wires:Record<string,unknown>[]=[];
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body));wires.push(body);
   return response([{...uncertain,scopeWitness:ledger},proposal,supported][wires.length-1]??assert.fail('Unexpected extra HTTP'));};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,artifact,{...j.policy,scopeWitnessPolicy:'question-scope-v1'});
  assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review','content-revision','revised-claim-audit']);assert.equal(j.raw.length,3);
  assert.equal(result.original.selectedReferenceFindings[0].rawResponseSha256,old.originalRaw.rawSha256);assert.equal(JSON.stringify(artifact),before);
  assert.equal(result.review.version,QUESTION_SCOPE_REVIEW_VERSION);assert.equal(result.review.scopeAssessment?.status,'incomplete');
  const candidate=result.revisionCandidate;assert.ok(candidate&&'scopeDischarges'in candidate&&'audits'in candidate);
  assert.equal(candidate.scopeDischarges?.assessment.status,'accounted-awaiting-independent-review');assert.equal(candidate.semanticVerified,false);
  assert.ok(candidate.scopeDischarges?.witness.requirements.r0.members[0].witnesses.every(w=>!w.sourceId.startsWith('Source')));
  const local=JSON.stringify(wires[2]);assert.ok(!local.includes('scopeWitness'));assert.ok(!local.includes(image.toString('base64')));
  assert.equal((wires[1].text as {format:{name:string}}).format.name,'complete_study_scope_revision_v1');
 });}finally{globalThis.fetch=saved;}
});

test('question-scope-v1 incomplete candidate cannot be upgraded by generic local support and invalid policies fail before source/provider',async()=>{
 const f=fixture(),j=journal('one-content-revision'),ledger=scopeLedger(),saved=globalThis.fetch;let calls=0;
 try{await development(async()=>{
  globalThis.fetch=async()=>{calls++;return response(calls===1?{...uncertain,scopeWitness:ledger}:{answer:f.alias,
   discharges:[{memberId:'m0',status:'eligible',witnesses:[],claimIds:['c0']}],unresolvedMemberIds:['m0']});};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,f.artifact,{...j.policy,scopeWitnessPolicy:'question-scope-v1'});
  assert.equal(calls,2);assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review','content-revision']);
  assert.equal(result.revisionCandidate?.status,'incomplete-scope-witness');assert.equal(result.revisionCandidate?.questionCoverage,'incomplete');
  assert.ok(result.revisionCandidate&&!('audits'in result.revisionCandidate));
  for(const policy of [{...j.policy,scopeWitnessPolicy:'invalid'}, {...j.policy,scopeWitnessPolicy:'question-scope-v1',completeSourceReview:undefined},
   {...j.policy,scopeWitnessPolicy:'question-scope-v1',citationRevision:true}])
   await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>{throw Error('Must not read source');},f.artifact,policy as PlannedStudyAnswerPolicy),/scope witness|Scope witnesses|durable development/);
  assert.equal(calls,2);
 });}finally{globalThis.fetch=saved;}
});

test('question-scope-v1 uncertain original local evidence triggers the existing content revision despite no coverage gap',async()=>{
 const f=fixture(),j=journal('one-content-revision'),ledger=scopeLedger(),saved=globalThis.fetch,
  old=savedLocal(f,{...localUnsupported,judgment:'uncertain',objectUnitScope:{claim:'tuning',evidence:'fixed setting',alignment:'not-established'}}),
  artifact={...f.artifact,originalLocalAudits:[old]},wires:Record<string,unknown>[]=[];
 ledger.requirements.r0.qualifiers=[];ledger.requirements.r0.members[0].witnesses.splice(1);ledger.requirements.r0.members[0].claimIds=['c0'];
 try{await development(async()=>{
  globalThis.fetch=async(_url,init)=>{wires.push(JSON.parse(String(init?.body)));return response(wires.length===1?{...uncertain,scopeWitness:ledger}:
   {answer:f.alias,discharges:[],unresolvedMemberIds:['m0']});};
  const result=await reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,artifact,{...j.policy,scopeWitnessPolicy:'question-scope-v1'});
  assert.equal(result.review.scopeAssessment?.status,'accounted-awaiting-independent-review');assert.equal(result.review.diagnostics.issues.length,0);
  assert.deepEqual(j.attempts.map(a=>a.phase),['coverage-review','content-revision']);assert.equal(wires.length,2);
  const input=JSON.parse(((wires[1].input as {content:{text:string}[]}[])[1].content)[0].text);
  assert.equal(input.originalSelectedReferenceFindings.findings[0].diagnostics.judgment,'uncertain');
  assert.equal(input.originalSelectedReferenceFindings.findings[0].rawResponseSha256,old.originalRaw.rawSha256);
  assert.equal(result.revisionCandidate?.status,'incomplete-scope-witness');
 });}finally{globalThis.fetch=saved;}
});

test('question-scope-v1 schema capacity shares source/claim definitions and preflights both actual phase schemas',()=>{
 const f=fixture(),members=scopeLedger(),ids=(n:number)=>Array.from({length:n},(_,i)=>`Source${i+1}`),
  build=(sourceIds:string[],requirements=10)=>{const request=structuredClone(f.transport.request);
   request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum=sourceIds;
   const part=(request.input[1].content as {text:string}[])[0],input=JSON.parse(part.text);
   input.questionContract.requirements=Array.from({length:requirements},(_,i)=>({...f.contract.requirements[0],id:`r${i}`}));part.text=JSON.stringify(input);
   return {request,coverage:()=>buildCompleteStudyCoverageReviewRequest(request,{...f.alias,claims:Array.from({length:6},()=>f.alias.claims[0])},undefined,'question-scope-v1'),
    revision:()=>questionScopeRevisionSchema(request.text.format.schema,members,sourceIds)};},
  enums=(schema:unknown)=>{const values:unknown[][]=[];const visit=(v:unknown)=>{if(!v||typeof v!=='object')return;
   if(!Array.isArray(v)&&Object.hasOwn(v,'enum'))values.push((v as {enum:unknown[]}).enum);for(const child of Object.values(v))visit(child);};visit(schema);return values;},
  wide=build(ids(100)),coverage=wide.coverage().request.text.format.schema,revision=wide.revision();
 for(const schema of [coverage,revision]){const actual=enums(schema);assert.equal(actual.filter(e=>JSON.stringify(e)===JSON.stringify(ids(100))).length,1);
  assert.ok(actual.reduce((n,e)=>n+e.length,0)<200);}
 assert.equal(enums(coverage).filter(e=>JSON.stringify(e)===JSON.stringify(['c0','c1','c2','c3','c4','c5'])).length,1);
 // Repeated rN and source references do not multiply the enum; actual provider gates still apply.
 for(const rejected of [build(ids(1000)),build(['Source1','Source2',...Array.from({length:249},(_,i)=>`Long${i}${'x'.repeat(70)}`)]),
  build(['Source1','Source2',...Array.from({length:248},(_,i)=>`Long${i}${'x'.repeat(500)}`)])])
  for(const phase of [rejected.coverage,rejected.revision])assert.throws(phase,/enum count|enum string/);
 const allowed=build(['Source1','Source2',...Array.from({length:248},(_,i)=>`Long${i}${'x'.repeat(70)}`)]);
 allowed.coverage();allowed.revision();assert.deepEqual(wide.request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,ids(100));
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
