import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceManifest} from '../lib/kernel/document-context.ts';
import {prepareCompleteStudyEvidenceRoute,freezeStudyQuestionContract,prepareContractStudyPlan,validateContractStudyPlan,bindContractStudyPlan,buildContractStudyPlanRequest} from '../lib/kernel/document-study-contract.ts';
import {preparePlannedStudyGeneration,preparePlannedStudyGenerationTransport,decodePlannedStudyGenerationSelections,answerPlannedStudyQuestion,
 reviewCompletePlannedStudyAnswer,CAPTION_ALIAS_SOURCE_LABEL_VERSION,type PlannedStudyAnswerPolicy,type PlannedStudyAnswerReviewArtifact} from '../lib/kernel/document-planned-answer.ts';
import {studyAnswerPlanRequestBudget} from '../lib/kernel/document-answer-plan.ts';
import type {DocumentAnswerContext,DocumentAnswerSelections} from '../lib/kernel/document-answer.ts';

process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='dummy-never-sent';process.env.SERVICE_VAULT_DIR=join(tmpdir(),'caption-alias-'+randomUUID());
process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='5';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>sha(JSON.stringify(v)),
 canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x),
 unknown={subject:null,attribute:null,unit:null,population:null,stage:null,configuration:null,time:null},
 png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
function fixture(){
 const question='Explain the comparisons in Synthetic report.',title='Synthetic report',source={documentId:'report',currentVersionId:'v1',sourceVersionId:'s1',sourceHash:sha('original'),courseId:''},
  bodies=['Original source prose.','Table 1: original comparison.','Table 2: duplicate number.','Table 02: duplicate normalized number.',
   'Fig. 3. actual figure caption.','Other words mentioning Table 9: not its heading.','Table 7.2: unsupported compound number.','Table 8: not a caption node.'],
  anchors=bodies.map((body,i)=>({id:`pg:v1:${i+1}`,document_id:'report',course_id:'',name:title,origin:'fixture',origin_key:'report',source_hash:source.sourceHash,
   source_version_id:'s1',body,locator:`node:${i}`,page_number:i+1,evidence_id:`node${i}`,parser_version:'fixture',score:1,evidence_body:'full-page' as const,parser_warnings:['Fidelity unverified.']})),
  images=bodies.slice(1).map((_,i)=>({attachmentId:`im${i}`,assetId:sha(png),captionEvidenceId:`node${i+1}`,sha256:sha(png),byteLength:png.length,width:1,height:1,mime:'image/png' as const,bytes:png,source})),
  unsigned:Omit<CompleteDocumentSourceManifest,'manifestSha256'>={method:'complete-current-source',nodeOrder:'original-source',complete:true,reason:null,source,
   sourceNodeCount:8,returnedNodeCount:8,sourceBodyCodepoints:bodies.reduce((n,b)=>n+Array.from(b).length,0),sourceBodyUtf8Bytes:bodies.reduce((n,b)=>n+Buffer.byteLength(b),0),
   orderedTextSha256:sha(JSON.stringify(bodies)),structureManifestSha256:sha('structure'),parserWarnings:['Fidelity unverified.'],
   document:{name:title,origin:'fixture',originKey:'report',parserVersion:'fixture'},hierarchy:[],
   nodes:anchors.map((h,i)=>({documentId:'report',documentVersionId:'v1',sourceVersionId:'s1',sourceHash:source.sourceHash,evidenceId:h.evidence_id,locator:h.locator,
    ordinal:i,kind:i===0||i===7?'paragraph':'caption',bodySha256:sha(h.body)})),
   images:images.map(({bytes:_,source:__,assetId:___,mime:____,...r})=>r),imageInputTokenUpper:21,limits:COMPLETE_DOCUMENT_SOURCE_LIMITS},
  context:DocumentAnswerContext={anchors,images,parents:[],sourceContentIsUntrusted:true,completeSourceProof:{policy:'selected-complete-initial-v1',selectedDocumentTitle:title,
   manifest:{...unsigned,manifestSha256:sha(canonical(unsigned))}}},
  contract=freezeStudyQuestionContract(question,{requirements:[{id:'r0',aspect:'Comparisons',requestedScope:{...unknown}}]},'a'.repeat(64)),route=prepareCompleteStudyEvidenceRoute(question,context,contract),
  packet=preparePlannedStudyGeneration(question,context,[],contract,route.binding,[]),v2=preparePlannedStudyGeneration(question,context,[],contract,route.binding,[],undefined,'caption-alias-v2');
 return {question,context,contract,route,packet,v2};
}
const response=(v:unknown)=>Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify(v)});
async function development(work:()=>Promise<void>){
 await database.prepare('DELETE FROM ai_ledger').run();const keys=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN'] as const,saved=keys.map(k=>process.env[k]);
 process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';
 try{await work();}finally{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}
}
function journal(){const attempts:any[]=[],raw:any[]=[],states:any[]=[],policy:PlannedStudyAnswerPolicy={scope:'development',sourceLabelPolicy:'caption-alias-v2',
 beforeAttempt:async a=>{attempts.push(a);},recordResponse:async r=>{raw.push(r);},recordState:async s=>{states.push(s);}};return {attempts,raw,states,policy};}

test('caption aliases bind genuine unique prefixes, fallback conservatively and retain all canonical sources/PNG/order/schema budget',()=>{
 const f=fixture(),before=JSON.stringify(f.context),old=preparePlannedStudyGenerationTransport(f.packet),v2=preparePlannedStudyGenerationTransport(f.v2),
  images=v2.mapping.entries.filter(e=>e.canonicalId.startsWith('i'));
 assert.deepEqual(images.map(e=>e.label),['Table1_Image1','Source3','Source4','Figure3_Image4','Source6','Source7','Source8']);
 assert.equal(v2.mapping.version,CAPTION_ALIAS_SOURCE_LABEL_VERSION);assert.equal(v2.binding.version,v2.mapping.version);
 assert.equal(f.v2.receipt.sourceLabelPolicy,'caption-alias-v2');assert.notEqual(v2.requestIdentity,old.requestIdentity);assert.equal(Object.hasOwn(f.packet.receipt,'sourceLabelPolicy'),false);
 assert.deepEqual(f.packet.prepared,f.v2.prepared);assert.deepEqual(f.packet.receipt.selectedSourceIds,f.v2.receipt.selectedSourceIds);assert.equal(JSON.stringify(f.context),before);
 const user=v2.request.input[1].content as {type:string;text?:string}[],oldUser=old.request.input[1].content as {type:string;text?:string}[],input=JSON.parse(user[0].text!);
 assert.deepEqual(user.filter(p=>p.type==='input_image'),oldUser.filter(p=>p.type==='input_image'));
 assert.deepEqual(input.quoteUnits,JSON.parse(oldUser[0].text!).quoteUnits);assert.deepEqual(input.evidence.filter((e:any)=>e.kind==='image').map((e:any)=>e.id),images.map(e=>e.label));
 assert.ok(user[1].text!.startsWith('Actual visual unit Table1_Image1:'));assert.deepEqual(v2.request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,v2.mapping.entries.map(e=>e.label));
 assert.ok(studyAnswerPlanRequestBudget(v2.request,{prepared:f.v2.selectedPrepared}).nonImageBodyUtf8Bytes>studyAnswerPlanRequestBudget(old.request,{prepared:f.packet.selectedPrepared}).nonImageBodyUtf8Bytes);
 const selection:DocumentAnswerSelections={status:'answered',message:'',claims:[{text:'Actual comparison.',citations:[{id:'Table1_Image1'}]}]};
 assert.equal(decodePlannedStudyGenerationSelections(selection,f.v2,v2,v2).claims[0].citations[0].id,'i0');
 assert.throws(()=>decodePlannedStudyGenerationSelections(selection,f.packet,v2,v2),/binding changed/);
 const unpaired=structuredClone(f.v2);delete unpaired.selectedPrepared.supports.find(s=>s.id==='i0')!.captionMembers;
 assert.equal(preparePlannedStudyGenerationTransport(unpaired).mapping.entries.find(e=>e.canonicalId==='i0')!.label,'Source2');
});

test('omitted policy and historical transports remain v1; wrong policy/route and raw relabeling reject before any request',async()=>{
 const f=fixture(),plain=preparePlannedStudyGenerationTransport(f.packet),again=preparePlannedStudyGenerationTransport(
  preparePlannedStudyGeneration(f.question,f.context,[],f.contract,f.route.binding,[],undefined,undefined));assert.deepEqual(again,plain);
 const prepared=prepareContractStudyPlan(f.question,f.context,f.contract),plan=validateContractStudyPlan({clusters:[],conflicts:[],sourceSubscopes:[],
  missing:[{requirementId:'r0',reason:'Synthetic unassessed',supplementQuery:null}]},f.contract,prepared.input.allowedSourceIds),
  binding=bindContractStudyPlan(prepared,plan,sha(JSON.stringify(buildContractStudyPlanRequest(prepared))),'b'.repeat(64)),packet=preparePlannedStudyGeneration(f.question,f.context,[],f.contract,binding,[]);
 for(const version of ['contract-supplement-answer-v7','contract-supplement-answer-v8','contract-supplement-answer-v9']){
  const receipt={...packet.receipt,version},historical=preparePlannedStudyGenerationTransport({...packet,receipt,bindingSha256:digest(receipt)});
  assert.equal(historical.mapping.version,'request-local-source-labels-v1');assert.ok(historical.mapping.entries.every(e=>/^Source\d+$/u.test(e.label)));
  assert.ok(!JSON.stringify(historical.request).includes('Caption-derived image labels'));assert.deepEqual(preparePlannedStudyGenerationTransport({...packet,receipt,bindingSha256:digest(receipt)}),historical);
 }
 assert.throws(()=>preparePlannedStudyGeneration(f.question,f.context,[],f.contract,binding,[],undefined,'caption-alias-v2'),/verified complete/);
 assert.throws(()=>preparePlannedStudyGeneration(f.question,f.context,[],f.contract,f.route.binding,[],undefined,'unknown' as never),/verified complete/);
 const j=journal(),saved=globalThis.fetch;let calls=0;
 try{await development(async()=>{
  globalThis.fetch=async()=>{calls++;throw Error('No provider allowed');};
  await assert.rejects(()=>answerPlannedStudyQuestion(f.question,async()=>f.context,async()=>{throw Error('No supplement');},f.contract,j.policy),/verified complete/);
  await assert.rejects(()=>answerPlannedStudyQuestion(f.question,async()=>f.context,async()=>{throw Error('No supplement');},f.contract,{...j.policy,sourceLabelPolicy:'unknown' as never},undefined,f.route.binding),/durable/);
  const alias:DocumentAnswerSelections={status:'insufficient-evidence',message:'I cannot provide a sufficiently supported answer.',claims:[]},rawBody=JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify(alias)}),
   artifact:PlannedStudyAnswerReviewArtifact={receipt:f.packet.receipt,providerSelections:alias,generation:{...plain,sourceLabels:plain,rawResponseSha256:sha(rawBody)},
    originalRaw:{requestIdentity:plain.requestIdentity,providerRequestSha256:plain.providerRequestSha256,httpStatus:200,rawBody,rawSha256:sha(rawBody)}};
  await assert.rejects(()=>reviewCompletePlannedStudyAnswer(f.question,async()=>f.packet,artifact,j.policy),/policy cannot change/);assert.equal(calls,0);
 });}finally{globalThis.fetch=saved;}
});

test('integrated aliases propagate through complete review and one content revision with true selected-only audits',async()=>{
 const f=fixture(),j=journal(),saved=globalThis.fetch,wires:any[]=[],initial={status:'answered',message:'',claims:[{text:'Original comparison.',citations:[{id:'Table1_Image1'}]}]},
  revision={...initial,claims:[{text:'Separately revised comparison.',citations:[{id:'Figure3_Image4'}]}]},
  local={claimId:'c0',judgment:'supported',reason:'Actual selected content.',citationFindings:{r0:{judgment:'supports',reason:'Actual selected content.'}},objectUnitScope:{claim:'comparison',evidence:'comparison',alignment:'same'}},
  diagnostic={requirements:{r0:{status:'issue',reason:'A concrete fallible comparison concern.'}},issues:[{kind:'subject-scope',requirementIds:['r0'],questionSpan:null,claimIds:['c0'],sourceIds:['Figure3_Image4'],reason:'Specific source-bound concern.'}]};
 try{await development(async()=>{
  globalThis.fetch=async(_u,init)=>{wires.push(JSON.parse(String(init?.body)));return response([initial,local,diagnostic,revision,local][wires.length-1]);};
  const result=await answerPlannedStudyQuestion(f.question,async()=>f.context,async()=>{throw Error('No supplement');},f.contract,{...j.policy,completeSourceReview:'one-content-revision'},undefined,f.route.binding);
  assert.deepEqual(j.attempts.map(a=>a.phase),['generation','claim-audit','coverage-review','content-revision','revised-claim-audit']);assert.equal(j.raw.length,5);
  if(!('completeSourceReview'in result)||!result.completeSourceReview)throw Error('Missing complete-source review');
  assert.equal(result.providerSelections.claims[0].citations[0].id,'i0');assert.equal(result.completeSourceReview.review.diagnostics.issues[0].sourceIds[0],'i3');
  const candidate=result.completeSourceReview.revisionCandidate;if(!candidate||!('audits'in candidate))throw Error('Missing independent proposal');
  assert.equal(candidate.providerSelections.claims[0].citations[0].id,'i3');assert.equal(candidate.audits.length,1);assert.equal(candidate.wholeAnswerVerified,false);
  for(const index of [0,2,3])assert.ok(JSON.stringify(wires[index]).includes('Table1_Image1'));
  assert.ok(!wires[3].input[0].content.includes('same actual SourceN selections'));assert.ok(wires[3].input[0].content.includes('same actual allowed source-label selections'));
  assert.ok(JSON.stringify(wires[1]).includes('Table 1: original comparison.'));assert.ok(!JSON.stringify(wires[1]).includes('actual figure caption.'));
  assert.ok(JSON.stringify(wires[4]).includes('actual figure caption.'));assert.ok(!JSON.stringify(wires[4]).includes('Table 1: original comparison.'));
 });}finally{globalThis.fetch=saved;}
});
