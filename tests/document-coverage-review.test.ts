import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceManifest} from '../lib/kernel/document-context.ts';
import {freezeStudyQuestionContract,prepareCompleteStudyEvidenceRoute} from '../lib/kernel/document-study-contract.ts';
import {buildCompleteStudyCoverageReviewRequest,validateCompleteStudyCoverageReview,prepareDocumentCitationAudit,buildDocumentCitationAuditRequest,
 DOCUMENT_CITATION_AUDIT_VERSION,type DocumentCitationAuditResponse,type DocumentCitationAuditDiagnostics} from '../lib/kernel/document-citation-audit.ts';
import {preparePlannedStudyGeneration,preparePlannedStudyGenerationTransport,decodePlannedStudyGenerationSelections,
 reviewCompletePlannedStudyAnswer,answerPlannedStudyQuestion,type PlannedStudyAnswerReviewArtifact,type PlannedStudyAnswerPolicy,type PlannedStudyAnswerAttempt} from '../lib/kernel/document-planned-answer.ts';
import {DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,type DocumentAnswerContext,type DocumentAnswerSelections} from '../lib/kernel/document-answer.ts';

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
