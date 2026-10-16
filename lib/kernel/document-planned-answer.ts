import {createHash} from 'node:crypto';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,resolveDocumentAnswerSelections,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,type DocumentAnswerContext,type DocumentAnswerSelections} from './document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest,auditDocumentCitationClaim,type DocumentCitationAuditResponse} from './document-citation-audit.ts';
import {createDocumentImageBudget} from './document-image-budget.ts';
import {assertStudyAnswerPlanPolicy,executeStudyPlanningRequest,studyAnswerPlanRequestBudget,studyPlanningRequestIdentity,type StudyAnswerPlanAttempt,type StudyAnswerPlanPolicy} from './document-answer-plan.ts';
import {planContractStudyAnswer,restoreContractStudyPlan,validateStudyQuestionContract,type StudyQuestionContract,type StudyContractPlanBinding} from './document-study-contract.ts';
import type {DocumentSourceResolution} from './document-source.ts';

export const PLANNED_STUDY_ANSWER_VERSION='contract-supplement-answer-v5';
export const PLANNED_STUDY_SOURCE_LABEL_VERSION='request-local-source-labels-v1';
type SupplementalSource=Extract<DocumentSourceResolution,{status:'resolved'}>;
export type StudySupplementQuery={requirementId:string;origin:'plan-missing'|'plan-source-subscope'|'question-contract';query:string;
 originalQuery?:string;focusPolicy?:'resolved-exact-title-scope-value-v1';sourceSubscopeIndex?:number;queryPolicy?:'parallel-source-subscopes-v1'};
export type PlannedStudyAnswerPolicy={scope:'development';dailyLimit?:number;
 beforeAttempt:(attempt:Readonly<StudyAnswerPlanAttempt&{claimIndex?:number}>)=>Promise<void>;
 recordResponse:(raw:Readonly<DocumentCitationAuditResponse&{phase:StudyAnswerPlanAttempt['phase'];claimIndex?:number}>)=>Promise<void>;
 recordState:(state:Readonly<Record<string,unknown>>)=>Promise<void>};
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>sha(JSON.stringify(v));
const journal=(policy:PlannedStudyAnswerPolicy,phase:StudyAnswerPlanAttempt['phase'],claimIndex?:number):StudyAnswerPlanPolicy=>({scope:policy.scope,dailyLimit:policy.dailyLimit,
 beforeAttempt:async attempt=>policy.beforeAttempt(Object.freeze({...attempt,phase,...(claimIndex!==undefined?{claimIndex}:{})})),
 recordResponse:async raw=>policy.recordResponse({...raw,phase,...(claimIndex!==undefined?{claimIndex}:{})})});
export async function assertPlannedStudyAnswerPolicy(policy:PlannedStudyAnswerPolicy){
 if(!policy||Object.keys(policy).some(k=>!['scope','dailyLimit','beforeAttempt','recordResponse','recordState'].includes(k))||
  typeof policy.recordState!=='function'||typeof policy.beforeAttempt!=='function'||typeof policy.recordResponse!=='function')
  throw Error('Planned answers require durable development state/attempt/raw journals');
 await assertStudyAnswerPlanPolicy(journal(policy,'contract-plan'));
}

/** One lexical batch, not a retry. Contract words fill unused slots even when
 * the fallible source plan asserts sufficient; no expected document IDs enter. */
export function studySupplementQueries(question:string,contract:StudyQuestionContract,binding:StudyContractPlanBinding,resolvedSource?:SupplementalSource):StudySupplementQuery[]{
 validateStudyQuestionContract(question,contract);const out:StudySupplementQuery[]=[],used=new Set([question.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase()]);
 const focus=(values:(string|null)[])=>values.filter((v):v is string=>v!==null&&(!resolvedSource||
  v.normalize('NFKC')!==resolvedSource.selectedDocumentTitle.normalize('NFKC')));
 const add=(requirementId:string,origin:StudySupplementQuery['origin'],query:string,focused=query,sourceSubscopeIndex?:number)=>{
  const normalized=focused.normalize('NFKC').replace(/\s+/gu,' ').trim();
  if(out.length<2&&normalized&&!used.has(normalized.toLowerCase())){if(Array.from(normalized).length>4000)throw Error('Complete supplemental query exceeds limit');
   used.add(normalized.toLowerCase());out.push({requirementId,origin,query:normalized,
    ...(resolvedSource||sourceSubscopeIndex!==undefined?{originalQuery:query}:{}),
    ...(resolvedSource?{focusPolicy:'resolved-exact-title-scope-value-v1' as const}:{}),
    ...(sourceSubscopeIndex!==undefined?{sourceSubscopeIndex,queryPolicy:'parallel-source-subscopes-v1' as const}:{})});}
 };
 for(const gap of binding.plan.missing)if(gap.supplementQuery)add(gap.requirementId,'plan-missing',gap.supplementQuery);
 for(const r of contract.requirements){
  const distinct=new Map<string,{index:number;scope:typeof r.requestedScope}>();
  for(const [index,s]of binding.plan.sourceSubscopes.entries())if(s.requirementId===r.id){
   const key=JSON.stringify(Object.entries(s.scope).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,v?.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase()??null]));
   if(!distinct.has(key))distinct.set(key,{index,scope:s.scope});
  }
  if(distinct.size<2)continue; // A single or repeated scope keeps the original fallback behavior.
  for(const {index,scope}of distinct.values()){const values=Object.values(scope);
   add(r.id,'plan-source-subscope',[r.aspect,...values.filter(v=>v!==null)].join(' '),[r.aspect,...focus(values)].join(' '),index);}
 }
 for(const r of contract.requirements){const values=Object.values(r.requestedScope).filter(v=>v!==null);
  add(r.id,'question-contract',[r.aspect,...values].join(' '),[r.aspect,...focus(values)].join(' '));}
 return out;
}
function mergeContexts(initial:DocumentAnswerContext,extras:DocumentAnswerContext[]){
 if(initial.anchors.length>14||extras.length>2||extras.some(c=>c.anchors.length>4||(c.imageAnchors?.length??0)>0))throw Error('Invalid bounded supplemental context');
 const contexts=[initial,...extras],anchors=new Map<string,DocumentAnswerContext['anchors'][number]>(),parents=new Map<string,DocumentAnswerContext['parents'][number]>();
 const anchorIdentity=(h:DocumentAnswerContext['anchors'][number])=>[h.id,h.document_id,h.course_id,h.name,h.origin,h.origin_key,h.source_hash,h.source_version_id,h.evidence_id,h.locator,h.parser_version,h.parser_warnings??[],h.body];
 const parentIdentity=(p:DocumentAnswerContext['parents'][number])=>[p.status,p.sourceNodeCount,p.sourceBodyCodepoints,p.headingMetadata,p.structureProvenance,p.nodes];
 for(const c of contexts){if(c.sourceContentIsUntrusted!==true)throw Error('Unverified supplemental context');
  for(const h of c.anchors){const key=JSON.stringify([h.document_id,h.evidence_id]),old=anchors.get(key);
   if(old&&digest(anchorIdentity(old))!==digest(anchorIdentity(h)))throw Error('Supplemental source changed');if(!old)anchors.set(key,h);}
  for(const p of c.parents){const old=parents.get(p.parentId);if(old&&digest(parentIdentity(old))!==digest(parentIdentity(p)))throw Error('Supplemental parent changed');if(!old)parents.set(p.parentId,p);}
 }
 const budget=createDocumentImageBudget(),images:DocumentAnswerContext['images']=[];
 for(const c of contexts)for(const image of c.images)if(budget.include(image,images.length+1)&&!images.some(i=>i.attachmentId===image.attachmentId))images.push(image);
 const selection=budget.snapshot(),included=new Set(images.map(i=>i.attachmentId));
 const omitted=new Map([...contexts.flatMap(c=>c.imageSelection?.omitted??[]),...selection.omitted]
  .filter(i=>!included.has(i.attachmentId)).map(i=>[i.attachmentId,i]));
 return {anchors:[...anchors.values()],parents:[...parents.values()],images,imageAnchors:initial.imageAnchors??[],
  sourceContentIsUntrusted:true as const,imageSelection:{...selection,omitted:[...omitted.values()]}};
}

/** Retain all original selectable text; the fallible plan is only advisory.
 * Supplemental text remains actual retrieved evidence. q IDs are source-stable;
 * original image order is retained. The extension is not a new model plan. */
export function preparePlannedStudyGeneration(question:string,initial:DocumentAnswerContext,extras:DocumentAnswerContext[],contract:StudyQuestionContract,
 binding:StudyContractPlanBinding,queries:StudySupplementQuery[],supplementalSource?:SupplementalSource){
 const original=restoreContractStudyPlan(question,initial,contract,binding),context=mergeContexts(initial,extras),prepared=prepareDocumentAnswer(question,context,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);
 if(queries.length!==extras.length)throw Error('Supplemental query/context mismatch');
 if(supplementalSource&&extras.some(c=>c.anchors.some(h=>h.document_id!==supplementalSource.document.documentId||
  h.source_hash!==supplementalSource.document.sourceHash||h.source_version_id!==supplementalSource.document.sourceVersionId||
  h.id!==`pg:${supplementalSource.document.currentVersionId}:${h.page_number}`)))throw Error('Selected supplemental source changed');
 const byUnit=new Map(prepared.quoteUnits.map(u=>[u.id,u]));
 for(const unit of original.prepared.quoteUnits){const current=byUnit.get(unit.id);if(!current||current.text!==unit.text||current.quoteSha256!==unit.quoteSha256||
  current.startUtf16!==unit.startUtf16||current.endUtf16!==unit.endUtf16)throw Error('Original quote unit lost during supplementation');}
 const originalImages=original.prepared.supports.filter(s=>s.kind==='image');
 if(originalImages.some(s=>!prepared.supports.some(p=>p.id===s.id&&p.kind==='image'&&p.sha256===s.sha256&&p.documentId===s.documentId&&
  p.documentVersionId===s.documentVersionId&&p.sourceVersionId===s.sourceVersionId&&p.sourceHash===s.sourceHash)))throw Error('Original image identity/order changed');
 const selected=new Set<string>(); // The old plan cannot reselect caption-only members of a new visual unit.
 for(const unit of original.prepared.quoteUnits)if(byUnit.get(unit.id)?.selectable)selected.add(unit.id);
 for(const image of originalImages)selected.add(image.id);
 for(const extra of extras){const actual=prepareDocumentAnswer(question,extra);
  for(const unit of actual.quoteUnits)if(byUnit.get(unit.id)?.selectable)selected.add(unit.id);
  for(const image of actual.supports.filter(s=>s.kind==='image')){const mapped=prepared.supports.find(s=>s.kind==='image'&&s.image!.attachmentId===image.image!.attachmentId&&s.sha256===image.sha256);if(mapped)selected.add(mapped.id);}
 }
 const quoteUnits=prepared.quoteUnits.filter(u=>u.selectable&&selected.has(u.id)),supportIds=new Set(quoteUnits.map(u=>u.supportId)),
  supports=prepared.supports.filter(s=>s.kind==='image'?selected.has(s.id):supportIds.has(s.id)),actualIds=new Set([...quoteUnits.map(u=>u.id),...supports.filter(s=>s.kind==='image').map(s=>s.id)]);
 if([...selected].some(id=>!actualIds.has(id)))throw Error('Plan selection is not in current composite source');
 const supplemental=extras.map((c,index)=>({...queries[index],ranking:'keyword-related-v1',limit:4,extraNativeTableLane:false,
  retrievalScope:supplementalSource?.scope??'whole-library-query',sourceSelection:supplementalSource??null,
  selections:c.anchors.map((h,rank)=>({rank:rank+1,id:h.id,documentId:h.document_id,sourceVersionId:h.source_version_id,sourceHash:h.source_hash,evidenceId:h.evidence_id,bodySha256:sha(h.body)})),
  imageSelection:c.imageSelection??null}));
 const receipt={version:PLANNED_STUDY_ANSWER_VERSION,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,contractSha256:contract.contractSha256,originalPlanSha256:binding.planSha256,
  originalPlanRequestSha256:binding.providerRequestSha256,originalPlanRawSha256:binding.rawResponseSha256,
  originalInputFingerprint:binding.inputFingerprint,inputFingerprint:prepared.fingerprint,quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,
  supplemental,initialImageSelection:initial.imageSelection??null,imageSelection:prepared.input.imageSelection,
  initialRetrievalScope:'whole-library-query',originalTextSelection:'all-original-selectable-v1',
  originalQuoteIds:original.prepared.quoteUnits.map(u=>u.id),selectedSourceIds:[...actualIds],
  imageIds:prepared.supports.filter(s=>s.kind==='image').map(s=>({id:s.id,sha256:s.sha256,sourceVersionId:s.sourceVersionId})),
  originalContextRetained:true,fullSourceCoverage:'unassessed',conflictExhaustiveness:'unassessed'};
 const selectedPrepared={...prepared,quoteUnits,supports,input:{...prepared.input,quoteUnits,evidence:prepared.input.evidence.filter(s=>supports.some(p=>p.id===s.id)),
  questionContract:original.contract,unverifiedEvidencePlan:binding.plan,supplementalRetrieval:receipt.supplemental}};
 return {context,prepared,selectedPrepared,receipt,bindingSha256:digest(receipt)};
}
function buildPlannedStudyGenerationBody(prepared:ReturnType<typeof preparePlannedStudyGeneration>['selectedPrepared']){
 const body=buildDocumentAnswerRequest(prepared,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:4000});
 body.input[0].content+=' The complete original question, question-contract aspects and requested scope must all remain in force; the contract itself is fallible. '+
  'The evidence plan is an unverified proposal, not factual evidence. Use only actual quote units and images to establish an answer. '+
  'Answer every requested parallel subject/configuration and preserve same-context genuine conflicts; do not substitute a subset for an explicit total. '+
  'Return at most six final atomic claims without dropping material requirements to meet that limit. If capacity or evidence prevents a complete answer, do not claim completeness. '+
  'This response will receive only citation-local support checks; those cannot certify complete coverage.';
 return body;
}

/** Only typed citation-ID fields cross this transport boundary. Source text,
 * metadata, nonselectable caption members, image bytes and order stay intact.
 * Canonical q/i identities remain in the packet, manifest and local audits. */
export function preparePlannedStudyGenerationTransport(packet:ReturnType<typeof preparePlannedStudyGeneration>){
 const prepared=packet.selectedPrepared,ids=[...prepared.quoteUnits.filter(u=>u.selectable).map(u=>u.id),
  ...prepared.supports.filter(s=>s.kind==='image').map(s=>s.id)];
 if(!ids.length||new Set(ids).size!==ids.length||digest(ids)!==digest(packet.receipt.selectedSourceIds))throw Error('Invalid planned source labels');
 const canonicalPacketSha256=digest({bindingSha256:packet.bindingSha256,input:prepared.input}),
  mapping={version:PLANNED_STUDY_SOURCE_LABEL_VERSION,canonicalPacketSha256,entries:ids.map((canonicalId,index)=>({label:`Source${index+1}`,canonicalId}))},
  byId=new Map(mapping.entries.map(e=>[e.canonicalId,e.label])),
  nonselectable=new Set(packet.prepared.quoteUnits.filter(u=>!u.selectable).map(u=>u.id));
 const selectedId=(id:string)=>{const label=byId.get(id);if(!label)throw Error('Incomplete planned source label mapping');return label;};
 // A saved plan may reference a caption that became a nonselectable member of
 // an actual visual unit. Keep that provenance without making it selectable.
 const planId=(id:string)=>byId.get(id)??(nonselectable.has(id)?id:selectedId(id)),plan=prepared.input.unverifiedEvidencePlan,
  quoteUnits=prepared.quoteUnits.map(u=>({...u,id:selectedId(u.id)})),
  supports=prepared.supports.map(s=>s.kind==='image'?{...s,id:selectedId(s.id)}:s),
  input={...prepared.input,quoteUnits,evidence:prepared.input.evidence.map(s=>s.kind==='image'?{...s,id:selectedId(s.id)}:s),
   unverifiedEvidencePlan:{...plan,clusters:plan.clusters.map(c=>({...c,sourceIds:c.sourceIds.map(planId)})),
    conflicts:plan.conflicts.map(c=>({...c,leftSourceIds:c.leftSourceIds.map(planId),rightSourceIds:c.rightSourceIds.map(planId)})),
    sourceSubscopes:plan.sourceSubscopes.map(s=>({...s,sourceIds:s.sourceIds.map(planId)}))}},
  request=buildPlannedStudyGenerationBody({...prepared,quoteUnits,supports,input}),mappingSha256=digest(mapping),
  binding={version:PLANNED_STUDY_SOURCE_LABEL_VERSION,canonicalBindingSha256:packet.bindingSha256,
   canonicalInputFingerprint:packet.prepared.fingerprint,canonicalPacketSha256,mappingSha256,providerRequestSha256:digest(request)},
  bindingSha256=digest(binding);
 return {request,mapping,binding,bindingSha256,...studyPlanningRequestIdentity(PLANNED_STUDY_ANSWER_VERSION,request,bindingSha256)};
}
export function buildPlannedStudyGenerationRequest(packet:ReturnType<typeof preparePlannedStudyGeneration>){
 return preparePlannedStudyGenerationTransport(packet).request;
}

/** Decode exactly once, after the original provider raw has been durably
 * journaled. A complete current packet and actual execution identity are
 * required; old canonical answers and stale/tampered mappings cannot decode. */
export function decodePlannedStudyGenerationSelections(value:unknown,packet:ReturnType<typeof preparePlannedStudyGeneration>,
 transport:ReturnType<typeof preparePlannedStudyGenerationTransport>,execution:{providerRequestSha256:string;requestIdentity:string}){
 const current=preparePlannedStudyGenerationTransport(packet);
 if(digest(transport)!==digest(current)||execution.providerRequestSha256!==current.providerRequestSha256||execution.requestIdentity!==current.requestIdentity)
  throw Error('Planned source label binding changed');
 const exact=(v:unknown,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 if(!exact(value,['status','message','claims'])||!Array.isArray((value as DocumentAnswerSelections).claims))throw Error('Invalid planned source label response');
 const selections=value as DocumentAnswerSelections,byLabel=new Map(transport.mapping.entries.map(e=>[e.label,e.canonicalId]));
 return {...selections,claims:selections.claims.map(claim=>{
  if(!exact(claim,['text','citations'])||!Array.isArray(claim.citations))throw Error('Invalid planned source label response');
  const seen=new Set<string>();return {...claim,citations:claim.citations.map(ref=>{
   if(!exact(ref,['id'])||typeof ref.id!=='string'||!byLabel.has(ref.id)||seen.has(ref.id))throw Error('Unknown or duplicate planned source label');
   seen.add(ref.id);return {id:byLabel.get(ref.id)!};
  })};
 })};
}

/** At most one plan, one lexical batch, one generation and six actual final
 * claim audits. No pre-audit, second plan, citation repair or model escalation. */
export async function answerPlannedStudyQuestion(question:string,readInitial:()=>Promise<DocumentAnswerContext>,
 readSupplement:(query:string)=>Promise<()=>Promise<DocumentAnswerContext>>,contract:StudyQuestionContract,policy:PlannedStudyAnswerPolicy,supplementalSource?:SupplementalSource){
 await assertPlannedStudyAnswerPolicy(policy);const checked=validateStudyQuestionContract(question,contract),plan=await planContractStudyAnswer(question,readInitial,checked,journal(policy,'contract-plan'));
 await policy.recordState({event:'plan',result:plan});
 if(plan.completion==='capacity-exceeded')return {status:'capacity-exceeded',plan,wholeAnswerVerified:false};
 const queries=studySupplementQueries(question,checked,plan.binding,supplementalSource),readers:(()=>Promise<DocumentAnswerContext>)[]=[];
 for(const q of queries)readers.push(await readSupplement(q.query));
 const read=async()=>{const initial=await readInitial(),extras=[];for(const r of readers)extras.push(await r());return preparePlannedStudyGeneration(question,initial,extras,checked,plan.binding,queries,supplementalSource);};
 const packet=await read();await policy.recordState({event:'supplement',receipt:packet.receipt});
 if(!packet.selectedPrepared.supports.length)return {status:'unavailable',plan,receipt:packet.receipt,wholeAnswerVerified:false};
 const transport=preparePlannedStudyGenerationTransport(packet),body=transport.request,budget=studyAnswerPlanRequestBudget(body,{prepared:packet.selectedPrepared});
 await policy.recordState({event:'generation-request',version:PLANNED_STUDY_ANSWER_VERSION,transport});
 const checkedRead=async()=>{const current=await read();if(current.bindingSha256!==packet.bindingSha256||
   digest(preparePlannedStudyGenerationTransport(current))!==digest(transport))throw Error('Planned answer composite source changed');return current.context;},
  recheck=async()=>{await checkedRead();},
  {value:aliasSelections,...execution}=await executeStudyPlanningRequest(PLANNED_STUDY_ANSWER_VERSION,'generation',body,transport.bindingSha256,budget,journal(policy,'generation'),recheck),
  value=decodePlannedStudyGenerationSelections(aliasSelections,packet,transport,execution),generation={...execution,sourceLabels:transport};
 await policy.recordState({event:'generation',value,aliasSelections,...generation,receipt:packet.receipt});
 if(value&&typeof value==='object'&&Array.isArray((value as DocumentAnswerSelections).claims)&&(value as DocumentAnswerSelections).claims.length>6)
  return {status:'capacity-exceeded',plan,generation,untruncatedValue:value,receipt:packet.receipt,wholeAnswerVerified:false};
 const restored=resolveDocumentAnswerSelections(value,packet.prepared.supports),allowed=new Set(packet.receipt.selectedSourceIds);
 if(restored.providerSelections.claims.some(c=>c.citations.some(ref=>!allowed.has(ref.id))))throw Error('Answer used an unselected source');
 const audits=[];
 for(let claimIndex=0;claimIndex<restored.providerSelections.claims.length;claimIndex++){
  const binding={inputFingerprint:packet.prepared.fingerprint,quoteUnitManifestSha256:packet.prepared.quoteUnitManifestSha256,providerSelections:restored.providerSelections,claimIndex,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY} as const,
   local=prepareDocumentCitationAudit(question,packet.context,binding),request=buildDocumentCitationAuditRequest(local.packet),
   images=local.packet.references.flatMap(r=>r.kind==='image'?[{image:r.image}]:[]),bound=studyAnswerPlanRequestBudget(request,{prepared:{supports:images}},1000),
   p=journal(policy,'claim-audit',claimIndex),requestSha=digest(request);
  const result=await auditDocumentCitationClaim(question,checkedRead,binding,{scope:'development',dailyLimit:policy.dailyLimit,
   beforeAttempt:async requestIdentity=>p.beforeAttempt({phase:'claim-audit',requestIdentity,providerRequestSha256:requestSha,...bound}),
   recordResponse:async raw=>{await p.recordResponse(raw);const payload=JSON.parse(raw.rawBody);
    if(payload?.status!=='completed'||!Number.isSafeInteger(payload.usage?.input_tokens)||!Number.isSafeInteger(payload.usage?.output_tokens)||
     payload.usage.input_tokens<0||payload.usage.output_tokens<0||payload.usage.input_tokens>bound.inputTokenUpper||payload.usage.output_tokens>1000)throw Error('Local audit incomplete/unknown usage');}});
  const d=result.diagnostics,supported=d.judgment==='supported'&&Object.values(d.citationFindings).some(f=>f.judgment==='supports')&&
   !Object.values(d.citationFindings).some(f=>f.judgment==='contradicts')&&!['different','not-established'].includes(d.objectUnitScope.alignment);
  audits.push({claimIndex,localSupported:supported,result});await policy.recordState({event:'claim-audit',claimIndex,localSupported:supported,result});
 }
 await recheck();const result={status:'generated-awaiting-independent-review',plan,generation,...restored,audits,receipt:packet.receipt,
  unassessedPlanningGaps:plan.plan.missing,localUnsupportedClaims:audits.filter(a=>!a.localSupported).map(a=>a.claimIndex),
  semanticVerified:false,wholeAnswerVerified:false,fullSourceCoverage:'unassessed',conflictExhaustiveness:'unassessed'};
 await policy.recordState({event:'result',...result});return result;
}
