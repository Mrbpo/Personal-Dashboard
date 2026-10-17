import {createHash} from 'node:crypto';
import {isGpt54MiniProviderModel} from '../ai-budget.ts';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,resolveDocumentAnswerSelections,DocumentAnswerRequestLimitError,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,type DocumentAnswerContext,type DocumentAnswerSelections} from './document-answer.ts';
import {validateCompleteStudySource} from './document-study-source.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest,auditDocumentCitationClaim,buildCompleteStudyCoverageReviewRequest,
 validateCompleteStudyCoverageReview,validateDocumentCitationAudit,documentCitationAuditRequestIdentity,evidenceAuditSettings,
 assertQuestionScopeWitnessPolicy,validateQuestionScopeWitness,assessQuestionScopeWitness,mapQuestionScopeWitness,restoreQuestionScopeBindings,questionScopeRevisionSchema,restoreQuestionScopeDischarges,QUESTION_SCOPE_REVIEW_VERSION,
 DOCUMENT_CITATION_AUDIT_VERSION,COMPLETE_STUDY_COVERAGE_REVIEW_VERSION,type DocumentCitationAuditResponse,type EvidenceAuditProfile,type QuestionScopeWitnessPolicy} from './document-citation-audit.ts';
import {reviseDocumentCitationClaim,type DocumentCitationRevisionAttempt} from './document-citation-revision.ts';
import {createDocumentImageBudget} from './document-image-budget.ts';
import {assertStudyAnswerPlanPolicy,executeStudyPlanningRequest,studyAnswerPlanRequestBudget,studyPlanningRequestIdentity,studyAnswerModelInput,type StudyAnswerPlanAttempt,type StudyAnswerPlanPolicy} from './document-answer-plan.ts';
import {planContractStudyAnswer,restoreContractStudyPlan,restoreCompleteStudyEvidenceRoute,isCompleteStudyEvidenceRoute,validateStudyQuestionContract,
 type StudyQuestionContract,type StudyContractPlanBinding,type CompleteStudyEvidenceRouteBinding} from './document-study-contract.ts';
import type {DocumentSourceResolution} from './document-source.ts';

export const PLANNED_STUDY_ANSWER_VERSION='contract-supplement-answer-v9';
export const COMPLETE_SOURCE_STUDY_ANSWER_VERSION='complete-source-evidence-answer-v1';
export const STUDY_CONTENT_REVISION_VERSION='complete-study-content-revision-v1';
export const QUESTION_SCOPE_REVISION_VERSION='complete-study-scope-id-revision-v2';
export const PLANNED_STUDY_SOURCE_LABEL_VERSION='request-local-source-labels-v1';
export const CAPTION_ALIAS_SOURCE_LABEL_VERSION='request-local-caption-alias-v2';
type SourceLabelPolicy='caption-alias-v2';
type PlanningProvenance={originalPlanSha256?:string;originalPlanRequestSha256?:string;originalPlanRawSha256?:string;
 evidenceRoute?:CompleteStudyEvidenceRouteBinding};
type SupplementalSource=Extract<DocumentSourceResolution,{status:'resolved'}>;
export type StudySupplementQuery={requirementId:string;origin:'plan-missing'|'plan-source-subscope'|'question-contract';query:string;
 originalQuery?:string;focusPolicy?:'resolved-exact-title-query-v2';sourceSubscopeIndex?:number;queryPolicy?:'parallel-source-subscopes-v1'};
type PlannedPhase=StudyAnswerPlanAttempt['phase']|DocumentCitationRevisionAttempt['phase'];
export type PlannedStudyAnswerAttempt=Omit<StudyAnswerPlanAttempt,'phase'>&{phase:PlannedPhase;claimIndex?:number};
export type PlannedStudyAnswerPolicy={scope:'development';dailyLimit?:number;auditProfile?:EvidenceAuditProfile;scopeWitnessPolicy?:QuestionScopeWitnessPolicy;citationRevision?:boolean;completeSourceReview?:'diagnostic'|'one-content-revision';sourceLabelPolicy?:SourceLabelPolicy;
 beforeAttempt:(attempt:Readonly<PlannedStudyAnswerAttempt>)=>Promise<void>;
 recordResponse:(raw:Readonly<DocumentCitationAuditResponse&{phase:PlannedPhase;claimIndex?:number}>)=>Promise<void>;
 recordState:(state:Readonly<Record<string,unknown>>)=>Promise<void>};
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>sha(JSON.stringify(v));
const journal=(policy:PlannedStudyAnswerPolicy,phase:StudyAnswerPlanAttempt['phase'],claimIndex?:number):StudyAnswerPlanPolicy=>({scope:policy.scope,dailyLimit:policy.dailyLimit,
 beforeAttempt:async attempt=>policy.beforeAttempt(Object.freeze({...attempt,phase,...(claimIndex!==undefined?{claimIndex}:{})})),
 recordResponse:async raw=>policy.recordResponse({...raw,phase,...(claimIndex!==undefined?{claimIndex}:{})})});
export async function assertPlannedStudyAnswerPolicy(policy:PlannedStudyAnswerPolicy){
 if(!policy||Object.keys(policy).some(k=>!['scope','dailyLimit','auditProfile','scopeWitnessPolicy','citationRevision','completeSourceReview','sourceLabelPolicy','beforeAttempt','recordResponse','recordState'].includes(k))||
  (policy.sourceLabelPolicy!==undefined&&policy.sourceLabelPolicy!=='caption-alias-v2')||
  (policy.citationRevision!==undefined&&typeof policy.citationRevision!=='boolean')||
  (policy.completeSourceReview!==undefined&&!['diagnostic','one-content-revision'].includes(policy.completeSourceReview))||
  (policy.completeSourceReview!==undefined&&policy.citationRevision===true)||
  typeof policy.recordState!=='function'||typeof policy.beforeAttempt!=='function'||typeof policy.recordResponse!=='function')
  throw Error('Planned answers require durable development state/attempt/raw journals');
 evidenceAuditSettings(policy.auditProfile);
 assertQuestionScopeWitnessPolicy(policy.scopeWitnessPolicy);
 if(policy.scopeWitnessPolicy&&!policy.completeSourceReview)throw Error('Scope witnesses require explicit complete-source review');
 if(policy.scopeWitnessPolicy&&policy.citationRevision===true)throw Error('Scope witnesses cannot enable the legacy citation-only revision protocol');
 if(policy.auditProfile!==undefined&&policy.citationRevision===true)throw Error('Reasoned evidence auditing cannot enable the legacy citation-only revision protocol');
 await assertStudyAnswerPlanPolicy(journal(policy,'contract-plan'));
}

/** One lexical batch, not a retry. Contract words fill unused slots even when
 * the fallible source plan asserts sufficient; no expected document IDs enter. */
export function studySupplementQueries(question:string,contract:StudyQuestionContract,binding:StudyContractPlanBinding,resolvedSource?:SupplementalSource):StudySupplementQuery[]{
 validateStudyQuestionContract(question,contract);const out:StudySupplementQuery[]=[],used=new Set([question.normalize('NFKC').replace(/\s+/gu,' ').trim().toLowerCase()]);
 const title=resolvedSource?.selectedDocumentTitle.normalize('NFKC');
 if(title&&!question.normalize('NFKC').includes(title))throw Error('Resolved supplemental title must occur in the complete question');
 const focus=(values:(string|null)[])=>values.filter((v):v is string=>v!==null&&(!resolvedSource||
  v.normalize('NFKC')!==resolvedSource.selectedDocumentTitle.normalize('NFKC')));
 const add=(requirementId:string,origin:StudySupplementQuery['origin'],query:string,focused=query,sourceSubscopeIndex?:number)=>{
  const normalized=(title?focused.normalize('NFKC').split(title).join(' '):focused.normalize('NFKC')).replace(/\s+/gu,' ').trim();
  if(out.length<2&&normalized&&!used.has(normalized.toLowerCase())){if(Array.from(normalized).length>4000)throw Error('Complete supplemental query exceeds limit');
   used.add(normalized.toLowerCase());out.push({requirementId,origin,query:normalized,
    ...(resolvedSource||sourceSubscopeIndex!==undefined?{originalQuery:query}:{}),
    ...(resolvedSource?{focusPolicy:'resolved-exact-title-query-v2' as const}:{}),
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
 // This separate bounded lane is licensed only by a complete reader manifest;
 // ranked retrieval and its original 14/4 limits are unchanged.
 if(initial.completeSourceProof){validateCompleteStudySource(initial);if(extras.length)throw Error('Complete initial source cannot import supplemental contexts');
  const budget=createDocumentImageBudget();for(const [i,image]of initial.images.entries())if(!budget.include(image,i+1))throw Error('Complete source image budget exceeded');
  return {...initial,imageAnchors:initial.imageAnchors??[],imageSelection:initial.imageSelection??budget.snapshot()};}
 if(initial.anchors.length>14||extras.length>2||extras.some(c=>c.anchors.length>4||(c.imageAnchors?.length??0)>0||c.sourceCaptionProof))throw Error('Invalid bounded supplemental context');
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
  ...(initial.sourceCaptionProof?{sourceCaptionProof:initial.sourceCaptionProof}:{}),
  sourceContentIsUntrusted:true as const,imageSelection:{...selection,omitted:[...omitted.values()]}};
}

/** Retain all original selectable text; the fallible plan is only advisory.
 * Supplemental text remains actual retrieved evidence. q IDs are source-stable;
 * original image order is retained. The extension is not a new model plan. */
export function preparePlannedStudyGeneration(question:string,initial:DocumentAnswerContext,extras:DocumentAnswerContext[],contract:StudyQuestionContract,
 binding:StudyContractPlanBinding|CompleteStudyEvidenceRouteBinding,queries:StudySupplementQuery[],supplementalSource?:SupplementalSource,sourceLabelPolicy?:SourceLabelPolicy){
 if(sourceLabelPolicy!==undefined&&(sourceLabelPolicy!=='caption-alias-v2'||!isCompleteStudyEvidenceRoute(binding)||!initial.completeSourceProof))
  throw Error('Caption aliases require the verified complete single-source evidence route');
 const deterministic=isCompleteStudyEvidenceRoute(binding),original=deterministic?restoreCompleteStudyEvidenceRoute(question,initial,contract,binding):restoreContractStudyPlan(question,initial,contract,binding),
  context=mergeContexts(initial,extras),prepared=prepareDocumentAnswer(question,context,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY);
 if(deterministic&&(queries.length||extras.length))throw Error('Complete evidence route cannot import supplemental contexts');
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
 const provenance:PlanningProvenance=deterministic?{evidenceRoute:binding}:{originalPlanSha256:binding.planSha256,
  originalPlanRequestSha256:binding.providerRequestSha256,originalPlanRawSha256:binding.rawResponseSha256};
 const receipt={version:deterministic?COMPLETE_SOURCE_STUDY_ANSWER_VERSION:PLANNED_STUDY_ANSWER_VERSION,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,contractSha256:contract.contractSha256,...provenance,
  ...(sourceLabelPolicy?{sourceLabelPolicy}:{}),
  originalInputFingerprint:binding.inputFingerprint,inputFingerprint:prepared.fingerprint,quoteUnitManifestSha256:prepared.quoteUnitManifestSha256,
  supplemental,initialImageSelection:initial.imageSelection??null,imageSelection:prepared.input.imageSelection,sourceCaptionProof:initial.sourceCaptionProof??null,
  initialRetrievalScope:initial.completeSourceProof?'selected-complete-source':'whole-library-query',
  ...(initial.completeSourceProof?{completeSourceProof:initial.completeSourceProof,selectedSourceInputCoverage:'complete',questionCoverage:'unassessed'}:{}),
  originalTextSelection:'all-original-selectable-v1',
  originalQuoteIds:original.prepared.quoteUnits.map(u=>u.id),selectedSourceIds:[...actualIds],
  imageIds:prepared.supports.filter(s=>s.kind==='image').map(s=>({id:s.id,sha256:s.sha256,sourceVersionId:s.sourceVersionId})),
  originalContextRetained:true,fullSourceCoverage:'unassessed',conflictExhaustiveness:'unassessed'};
 // Full planning/retrieval receipts stay journaled and bound; generation receives
 // their opaque identities and actual final sources, not coverage judgments.
 const selectedPrepared={...prepared,quoteUnits,supports,input:{...prepared.input,quoteUnits,evidence:prepared.input.evidence.filter(s=>supports.some(p=>p.id===s.id)),
  questionContract:original.contract,planningProvenance:provenance}};
 return {context,prepared,selectedPrepared,receipt,bindingSha256:digest(receipt)};
}
function buildPlannedStudyGenerationBody(prepared:ReturnType<typeof preparePlannedStudyGeneration>['selectedPrepared'],modelView:boolean){
 const body=buildDocumentAnswerRequest(prepared,{model:'gpt-5.4-mini',reasoningEffort:'medium',maxOutputTokens:4000});
 if(modelView){const sourceInput=body.input[1].content;
  if(!Array.isArray(sourceInput)||sourceInput[0].type!=='input_text'||!('text'in sourceInput[0]))throw Error('Missing planned source input');
  sourceInput[0].text=JSON.stringify(studyAnswerModelInput(prepared.input));}
 body.input[0].content+=' The complete original question, question-contract aspects and requested scope must all remain in force; the contract itself is fallible. '+
  'Answer every requested aspect and comparison family using all actual final quote units and images; planning provenance hashes are traceability metadata, not evidence of coverage. '+
  'Match the granularity actually requested: a positive existence answer can be supported by one explicit witness with the same requested subject and relation; do not require an exhaustive inventory or exact quantities unless asked. '+
  'Failure to retrieve such a witness does not establish a negative answer. '+
  'Keep every material action, its direction, negation, affected object and population qualifiers faithful to the cited source. '+
  'Preserve the source-stated counted object, unit, processing stage and qualifications in each quantity. Keep executed comparison settings, proposed methods, prior work and future work distinct. '+
  'Answer every requested parallel subject/configuration and preserve same-context genuine conflicts; do not substitute a subset for an explicit total. '+
  'Return at most six final atomic claims without dropping material requirements to meet that limit. If capacity or evidence prevents a complete answer, do not claim completeness. '+
  'This response will receive only citation-local support checks; those cannot certify complete coverage.';
 return body;
}

/** Typed citation-ID mapping precedes the request-only metadata projection.
 * Source text, semantic metadata, nonselectable caption members, image bytes
 * and order stay intact. Canonical q/i identities remain bound in the packet. */
export function preparePlannedStudyGenerationTransport(packet:ReturnType<typeof preparePlannedStudyGeneration>){
 if(!['contract-supplement-answer-v7','contract-supplement-answer-v8',PLANNED_STUDY_ANSWER_VERSION,COMPLETE_SOURCE_STUDY_ANSWER_VERSION].includes(packet.receipt.version))
  throw Error('Unsupported planned source version');
 if(Boolean(packet.receipt.evidenceRoute)!==(packet.receipt.version===COMPLETE_SOURCE_STUDY_ANSWER_VERSION))
  throw Error('Evidence route cannot be relabeled as a historical AI plan');
 const aliasPolicy=packet.receipt.sourceLabelPolicy;
 if(aliasPolicy!==undefined&&(aliasPolicy!=='caption-alias-v2'||packet.receipt.version!==COMPLETE_SOURCE_STUDY_ANSWER_VERSION))throw Error('Invalid caption-alias receipt');
 const aliases=new Map<string,string>();
 if(aliasPolicy){
  const proof=validateCompleteStudySource(packet.context),images=packet.selectedPrepared.supports.filter(s=>s.kind==='image'),
   prefixes=images.map(s=>{
    // Only the actual beginning of one verified author-caption visual unit.
    // Do not infer a table number from filenames, questions, image order or values.
    if(!s.captionMembers||s.image&&'anchorEvidenceId'in s.image||!proof.manifest.nodes.some(n=>n.evidenceId===s.evidenceId&&n.kind==='caption'))return null;
    const first=s.captionMembers.filter(u=>u.startUtf16===0);if(first.length!==1)return null;
    const match=/^[ \t\r\n]{0,8}(Table|Figure|Fig\.)[ \t]{1,4}([0-9]{1,4})(?:[ \t]{0,4}:|\.(?=[ \t\r\n]|$))/iu.exec(first[0].text.slice(0,64));
    if(!match)return null;const kind=match[1].toLowerCase()==='table'?'Table':'Figure';
    return {label:kind+match[2],key:kind+Number(match[2])};
   });
  for(const [index,prefix]of prefixes.entries())if(prefix&&prefixes.filter(p=>p?.key===prefix.key).length===1)
   aliases.set(images[index].id,`${prefix.label}_Image${index+1}`);
 }
 const prepared=packet.selectedPrepared,ids=[...prepared.quoteUnits.filter(u=>u.selectable).map(u=>u.id),
  ...prepared.supports.filter(s=>s.kind==='image').map(s=>s.id)];
 if(!ids.length||new Set(ids).size!==ids.length||digest(ids)!==digest(packet.receipt.selectedSourceIds))throw Error('Invalid planned source labels');
 const canonicalPacketSha256=digest({bindingSha256:packet.bindingSha256,input:prepared.input}),
  mapping={version:aliasPolicy?CAPTION_ALIAS_SOURCE_LABEL_VERSION:PLANNED_STUDY_SOURCE_LABEL_VERSION,canonicalPacketSha256,
   entries:ids.map((canonicalId,index)=>({label:aliases.get(canonicalId)??`Source${index+1}`,canonicalId}))},
  byId=new Map(mapping.entries.map(e=>[e.canonicalId,e.label]));
 const selectedId=(id:string)=>{const label=byId.get(id);if(!label)throw Error('Incomplete planned source label mapping');return label;};
 const quoteUnits=prepared.quoteUnits.map(u=>({...u,id:selectedId(u.id)})),
  supports=prepared.supports.map(s=>s.kind==='image'?{...s,id:selectedId(s.id)}:s),
  input={...prepared.input,quoteUnits,evidence:prepared.input.evidence.map(s=>s.kind==='image'?{...s,id:selectedId(s.id)}:s)},
  // Historical revisions compare their original unprojected body. New v9
  // generation projects only after the typed SourceN mapping above.
  request=buildPlannedStudyGenerationBody({...prepared,quoteUnits,supports,input},[PLANNED_STUDY_ANSWER_VERSION,COMPLETE_SOURCE_STUDY_ANSWER_VERSION].includes(packet.receipt.version)),mappingSha256=digest(mapping);
 if(aliasPolicy)request.input[0].content+=' Caption-derived image labels are navigation aliases, not evidence of numerical or semantic support. '+
  'ImageN is the actual image position, not the printed table/figure number. Inspect each selected original image and its row/column meanings; use only the actual allowed selection IDs.';
 const binding={version:mapping.version,canonicalBindingSha256:packet.bindingSha256,
   canonicalInputFingerprint:packet.prepared.fingerprint,canonicalPacketSha256,mappingSha256,providerRequestSha256:digest(request)},
  bindingSha256=digest(binding);
 return {request,mapping,binding,bindingSha256,...studyPlanningRequestIdentity(
  packet.receipt.version===COMPLETE_SOURCE_STUDY_ANSWER_VERSION?COMPLETE_SOURCE_STUDY_ANSWER_VERSION:PLANNED_STUDY_ANSWER_VERSION,request,bindingSha256)};
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
 return decodeStudySourceLabels(value,transport.mapping);
}
function decodeStudySourceLabels(value:unknown,mapping:{entries:{label:string;canonicalId:string}[]}){
 const exact=(v:unknown,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 if(!exact(value,['status','message','claims'])||!Array.isArray((value as DocumentAnswerSelections).claims))throw Error('Invalid planned source label response');
 const selections=value as DocumentAnswerSelections,byLabel=new Map(mapping.entries.map(e=>[e.label,e.canonicalId]));
 return {...selections,claims:selections.claims.map(claim=>{
  if(!exact(claim,['text','citations'])||!Array.isArray(claim.citations))throw Error('Invalid planned source label response');
  const seen=new Set<string>();return {...claim,citations:claim.citations.map(ref=>{
   if(!exact(ref,['id'])||typeof ref.id!=='string'||!byLabel.has(ref.id)||seen.has(ref.id))throw Error('Unknown or duplicate planned source label');
   seen.add(ref.id);return {id:byLabel.get(ref.id)!};
  })};
 })};
}

type PlannedCitationOriginal={receipt:ReturnType<typeof preparePlannedStudyGeneration>['receipt'];
 providerSelections:DocumentAnswerSelections;generation:{providerRequestSha256:string;rawResponseSha256:string;requestIdentity:string;
  sourceLabels:ReturnType<typeof preparePlannedStudyGenerationTransport>};
 audits:{claimIndex:number;localSupported:boolean;result:Awaited<ReturnType<typeof auditDocumentCitationClaim>>}[]};
export type PlannedStudyAnswerReviewArtifact=Omit<PlannedCitationOriginal,'audits'>&{originalRaw:DocumentCitationAuditResponse;
 originalLocalAudits?:{claimIndex:number;result:Awaited<ReturnType<typeof auditDocumentCitationClaim>>;originalRaw:DocumentCitationAuditResponse}[]};

/** Resume only citation selection. The reader must reconstruct the same final
 * Kernel packet; archived wire JSON is a comparison artifact, never a reader. */
export async function revisePlannedStudyCitation(question:string,readPacket:()=>Promise<ReturnType<typeof preparePlannedStudyGeneration>>,
 artifact:PlannedCitationOriginal,policy:PlannedStudyAnswerPolicy){
 await assertPlannedStudyAnswerPolicy(policy);
 if(policy.citationRevision!==true)throw Error('Planned citation revision requires explicit opt-in');
 const original=structuredClone(artifact);
 if(original.audits.length!==original.providerSelections.claims.length||original.audits.some((a,i)=>a.claimIndex!==i))
  throw Error('Original complete local audit sequence required');
 const failed=original.audits.find(a=>!a.localSupported&&a.result.diagnostics.judgment==='unsupported');
 if(!failed)return {status:'not-applicable' as const,reason:'no-original-unsupported-claim',wholeAnswerVerified:false};
 const checkedRead=async()=>{
  const packet=await readPacket(),receipt=original.receipt;
  // A historical version stays historical. Compare its original receipt and
  // actual body, without predicting an old runtime request identity.
  if(!['contract-supplement-answer-v7','contract-supplement-answer-v8',PLANNED_STUDY_ANSWER_VERSION,COMPLETE_SOURCE_STUDY_ANSWER_VERSION].includes(receipt.version)||
   digest({...packet.receipt,version:receipt.version})!==digest(receipt))throw Error('Planned revision final source changed');
  const current=preparePlannedStudyGenerationTransport({...packet,receipt,bindingSha256:digest(receipt)}),sent=original.generation.sourceLabels;
  if(digest(current.request)!==digest(sent.request)||digest(current.mapping)!==digest(sent.mapping)||digest(current.binding)!==digest(sent.binding)||
   current.bindingSha256!==sent.bindingSha256||current.providerRequestSha256!==original.generation.providerRequestSha256||
   sent.providerRequestSha256!==original.generation.providerRequestSha256||sent.requestIdentity!==original.generation.requestIdentity||
   !/^[a-f0-9]{64}$/u.test(original.generation.rawResponseSha256))throw Error('Original planned revision wire binding changed');
  return packet;
 };
 const packet=await checkedRead(),binding={inputFingerprint:packet.prepared.fingerprint,quoteUnitManifestSha256:packet.prepared.quoteUnitManifestSha256,
  providerSelections:original.providerSelections,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY,originalArtifact:{
   providerRequestSha256:original.generation.providerRequestSha256,rawResponseSha256:original.generation.rawResponseSha256,
   inputFingerprint:packet.prepared.fingerprint,answerVersion:original.receipt.version}} as const;
 return reviseDocumentCitationClaim(question,async()=>(await checkedRead()).context,binding,{
  scope:policy.scope,dailyLimit:policy.dailyLimit,
  beforeAttempt:async attempt=>policy.beforeAttempt(Object.freeze({...attempt,claimIndex:failed.claimIndex})),
  recordResponse:async raw=>policy.recordResponse({...raw,claimIndex:failed.claimIndex}),
  recordState:async state=>policy.recordState({event:'citation-revision',claimIndex:failed.claimIndex,state})},
 {claimIndex:failed.claimIndex,selectedSourceIds:packet.receipt.selectedSourceIds,originalAudit:failed.result});
}

/** Reuse the existing physically selected-only checker for final claims. */
async function auditStudySelections(question:string,packet:ReturnType<typeof preparePlannedStudyGeneration>,selections:DocumentAnswerSelections,
 readContext:()=>Promise<DocumentAnswerContext>,policy:PlannedStudyAnswerPolicy,phase:'claim-audit'|'revised-claim-audit'='claim-audit',
 captureRaw?:(claimIndex:number,raw:DocumentCitationAuditResponse)=>void){
 const audits=[],settings=evidenceAuditSettings(policy.auditProfile);
 for(let claimIndex=0;claimIndex<selections.claims.length;claimIndex++){
  const binding={inputFingerprint:packet.prepared.fingerprint,quoteUnitManifestSha256:packet.prepared.quoteUnitManifestSha256,
   providerSelections:selections,claimIndex,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY} as const,
   local=prepareDocumentCitationAudit(question,packet.context,binding),request=buildDocumentCitationAuditRequest(local.packet,policy.auditProfile),
   images=local.packet.references.flatMap(r=>r.kind==='image'?[{image:r.image}]:[]),bound=studyAnswerPlanRequestBudget(request,{prepared:{supports:images}},settings.maxOutputTokens),
   p=journal(policy,phase,claimIndex),requestSha=digest(request);
  const result=await auditDocumentCitationClaim(question,readContext,binding,{scope:'development',dailyLimit:policy.dailyLimit,...(policy.auditProfile?{auditProfile:policy.auditProfile}:{}),
   beforeAttempt:async requestIdentity=>p.beforeAttempt({phase,...(policy.auditProfile?{auditProfile:policy.auditProfile}:{}),requestIdentity,providerRequestSha256:requestSha,...bound}),
   recordResponse:async raw=>{await p.recordResponse(raw);const payload=JSON.parse(raw.rawBody);
    if(payload?.status!=='completed'||!Number.isSafeInteger(payload.usage?.input_tokens)||!Number.isSafeInteger(payload.usage?.output_tokens)||
     payload.usage.input_tokens<0||payload.usage.output_tokens<0||payload.usage.input_tokens>bound.inputTokenUpper||payload.usage.output_tokens>settings.maxOutputTokens)throw Error('Local audit incomplete/unknown usage');
    captureRaw?.(claimIndex,structuredClone(raw));}});
  const d=result.diagnostics,supported=d.judgment==='supported'&&Object.values(d.citationFindings).some(f=>f.judgment==='supports')&&
   !Object.values(d.citationFindings).some(f=>f.judgment==='contradicts')&&!['different','not-established'].includes(d.objectUnitScope.alignment);
  audits.push({claimIndex,localSupported:supported,result});await policy.recordState({event:phase,claimIndex,localSupported:supported,result});
 }
 return audits;
}

/** Diagnose an already-generated answer without generating a new baseline.
 * readPacket must reconstruct current Kernel evidence; an archived wire is not
 * a reader. The supplied actual original raw is checked against its wire and
 * canonical selections. No full-source finding upgrades a selected citation. */
export async function reviewCompletePlannedStudyAnswer(question:string,readPacket:()=>Promise<ReturnType<typeof preparePlannedStudyGeneration>>,
 artifact:PlannedStudyAnswerReviewArtifact,policy:PlannedStudyAnswerPolicy){
 policy={...policy};
 await assertPlannedStudyAnswerPolicy(policy);
 if(policy.citationRevision===true)throw Error('Content review and citation-only revision are mutually exclusive');
 const original=structuredClone(artifact),mode=policy.completeSourceReview??'diagnostic';
 if(policy.sourceLabelPolicy!==undefined&&policy.sourceLabelPolicy!==original.receipt.sourceLabelPolicy)throw Error('Original artifact source-label policy cannot change');
 const restore=async()=>{
  const current=await readPacket(),proof=validateCompleteStudySource(current.context),contract=validateStudyQuestionContract(question,current.selectedPrepared.input.questionContract);
  if(current.receipt.initialRetrievalScope!=='selected-complete-source'||digest({...current.receipt,version:original.receipt.version})!==digest(original.receipt))
   throw Error('Complete review original receipt/current source changed');
  const packet={...current,receipt:original.receipt,bindingSha256:digest(original.receipt)},transport=preparePlannedStudyGenerationTransport(packet),sent=original.generation.sourceLabels;
  if(digest(transport)!==digest(sent)||original.generation.providerRequestSha256!==transport.providerRequestSha256||
   original.generation.requestIdentity!==transport.requestIdentity)throw Error('Complete review original generation wire changed');
  const full=prepareDocumentAnswer(question,current.context,DOCUMENT_ANSWER_VISUAL_UNIT_POLICY),allIds=[...full.quoteUnits.filter(q=>q.selectable).map(q=>q.id),...full.supports.filter(s=>s.kind==='image').map(s=>s.id)];
  if(full.fingerprint!==current.prepared.fingerprint||digest(allIds)!==digest(current.receipt.selectedSourceIds))throw Error('Complete review cannot shrink source evidence');
  const raw=original.originalRaw;
  if(raw.rawSha256!==sha(raw.rawBody)||raw.rawSha256!==original.generation.rawResponseSha256||raw.providerRequestSha256!==transport.providerRequestSha256||
   raw.requestIdentity!==transport.requestIdentity||!Number.isInteger(raw.httpStatus)||raw.httpStatus<200||raw.httpStatus>=300)throw Error('Complete review original raw binding changed');
  const payload=JSON.parse(raw.rawBody),budget=studyAnswerPlanRequestBudget(transport.request,{prepared:packet.selectedPrepared});
  if(payload?.status!=='completed'||payload.error||!isGpt54MiniProviderModel(payload.model)||
   ![payload.usage?.input_tokens,payload.usage?.output_tokens].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||
   payload.usage.input_tokens>budget.inputTokenUpper||payload.usage.output_tokens>4000)throw Error('Complete review original raw is incomplete or unverified');
  const text=payload.output_text||(payload.output??[]).filter((p:{type:string})=>p.type==='message').flatMap((p:{content?:{type:string;text:string}[]})=>p.content??[])
   .filter((p:{type:string})=>p.type==='output_text').map((p:{text:string})=>p.text).join(''),alias=JSON.parse(text),
   decoded=decodePlannedStudyGenerationSelections(alias,packet,transport,original.generation);
  if(digest(decoded)!==digest(original.providerSelections))throw Error('Complete review answer does not match original provider raw');
  const restored=resolveDocumentAnswerSelections(decoded,packet.prepared.supports),localAudits=original.originalLocalAudits??[],seen=new Set<number>();
  if(!Array.isArray(localAudits)||localAudits.length>decoded.claims.length)throw Error('Invalid original selected-only audit sequence');
  const selectedReferenceFindings=localAudits.map(a=>{
   if(!Number.isInteger(a.claimIndex)||a.claimIndex<0||a.claimIndex>=decoded.claims.length||seen.has(a.claimIndex))throw Error('Invalid original selected-only claim index');
   seen.add(a.claimIndex);
   const result=a.result,settings=evidenceAuditSettings(result.auditProfile),
    local=prepareDocumentCitationAudit(question,current.context,{inputFingerprint:full.fingerprint,quoteUnitManifestSha256:full.quoteUnitManifestSha256,
    providerSelections:decoded,claimIndex:a.claimIndex,unitPolicy:DOCUMENT_ANSWER_VISUAL_UNIT_POLICY}),request=buildDocumentCitationAuditRequest(local.packet,result.auditProfile),
    {providerRequestSha256:requestSha,requestIdentity:identity}=documentCitationAuditRequestIdentity(request,local.bindingSha256,result.auditProfile),
    raw=a.originalRaw,bound=studyAnswerPlanRequestBudget(request,{prepared:{supports:local.packet.references.flatMap(r=>r.kind==='image'?[{image:r.image}]:[])}},settings.maxOutputTokens);
   if(result.version!==DOCUMENT_CITATION_AUDIT_VERSION||digest(result.binding)!==digest(local.binding)||result.bindingSha256!==local.bindingSha256||
    result.providerRequestSha256!==requestSha||result.requestIdentity!==identity||result.requestedModel!==request.model||
    raw.providerRequestSha256!==requestSha||raw.requestIdentity!==identity||raw.rawSha256!==sha(raw.rawBody)||result.rawResponseSha256!==raw.rawSha256||
    !Number.isInteger(raw.httpStatus)||raw.httpStatus<200||raw.httpStatus>=300)throw Error('Original selected-only audit raw/source binding changed');
   const payload=JSON.parse(raw.rawBody);
   if(payload?.status!=='completed'||payload.error||!isGpt54MiniProviderModel(payload.model)||result.model!==payload.model||
    ![payload.usage?.input_tokens,payload.usage?.output_tokens].every(n=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)||
    payload.usage.input_tokens>bound.inputTokenUpper||payload.usage.output_tokens>settings.maxOutputTokens)throw Error('Original selected-only audit raw is incomplete or unverified');
   const text=payload.output_text||(payload.output??[]).filter((p:{type:string})=>p.type==='message').flatMap((p:{content?:{type:string;text:string}[]})=>p.content??[])
    .filter((p:{type:string})=>p.type==='output_text').map((p:{text:string})=>p.text).join(''),
    diagnostics=validateDocumentCitationAudit(JSON.parse(text),local.packet.references.map(r=>r.refId));
   if(digest(diagnostics)!==digest(result.diagnostics))throw Error('Original selected-only audit diagnostics differ from raw');
   return {claimId:`c${a.claimIndex}`,claimIndex:a.claimIndex,...(result.auditProfile?{auditProfile:result.auditProfile}:{}),diagnostics,selectedReferences:local.binding.citations,
    providerRequestSha256:requestSha,requestIdentity:identity,rawResponseSha256:raw.rawSha256,bindingSha256:local.bindingSha256};
  }),binding={sourceManifestSha256:proof.manifest.manifestSha256,
   inputFingerprint:full.fingerprint,quoteUnitManifestSha256:full.quoteUnitManifestSha256,contractSha256:contract.contractSha256,
   originalAnswerSha256:digest({...restored.answer,message:decoded.message}),originalSelectionsSha256:digest(decoded),
   originalGenerationRequestSha256:transport.providerRequestSha256,originalGenerationRawSha256:raw.rawSha256,originalGenerationIdentity:transport.requestIdentity,
   originalSelectedReferenceFindingsSha256:digest(selectedReferenceFindings)};
  return {packet,transport,alias:alias as DocumentAnswerSelections,restored,binding,selectedReferenceFindings};
 };
 const initial=await restore(),bindingSha256=digest(initial.binding),originalRecord={...initial.binding,receipt:original.receipt,
  originalAnswer:{...initial.restored.answer,message:original.providerSelections.message},providerSelections:original.providerSelections,
  selectedReferenceFindings:initial.selectedReferenceFindings};
 await policy.recordState({event:'complete-review-original',...structuredClone(originalRecord)});
 const checked=async()=>{const current=await restore();if(digest(current.binding)!==bindingSha256)throw Error('Complete review source/answer changed');return current;};
 const readContext=async()=>(await checked()).packet.context;
 try{
  const prepared=buildCompleteStudyCoverageReviewRequest(initial.transport.request,initial.alias,policy.auditProfile,policy.scopeWitnessPolicy),requestSha=digest(prepared.request),
   reviewVersion=policy.scopeWitnessPolicy?QUESTION_SCOPE_REVIEW_VERSION:COMPLETE_STUDY_COVERAGE_REVIEW_VERSION,
   reviewBinding=prepared.choices.scopeWitness?{...initial.binding,scopeRegistrySha256:prepared.choices.scopeWitness.registrySha256}:initial.binding,
   reviewBindingSha256=digest(reviewBinding),budget=studyAnswerPlanRequestBudget(prepared.request,{prepared:initial.packet.selectedPrepared});
  await policy.recordState({event:'coverage-review-request',version:reviewVersion,...(policy.auditProfile?{auditProfile:policy.auditProfile}:{}),...(policy.scopeWitnessPolicy?{scopeWitnessPolicy:policy.scopeWitnessPolicy}:{}),binding:reviewBinding,request:prepared.request});
  const {value,...execution}=await executeStudyPlanningRequest(reviewVersion,'coverage-review',prepared.request,reviewBindingSha256,budget,
   journal(policy,'coverage-review'),async()=>{await checked();if(digest(prepared.request)!==requestSha)throw Error('Coverage request changed');},policy.auditProfile),
   aliasDiagnostics=validateCompleteStudyCoverageReview(value,prepared.choices),byLabel=new Map(initial.transport.mapping.entries.map(e=>[e.label,e.canonicalId])),
   canonicalId=(id:string)=>{const mapped=byLabel.get(id);if(!mapped)throw Error('Unknown scope source alias');return mapped;},
   scopeChoices=prepared.choices.scopeWitness?{...prepared.choices,sourceIds:prepared.choices.sourceIds.map(canonicalId),scopeWitness:{...prepared.choices.scopeWitness,
    textById:Object.fromEntries(Object.entries(prepared.choices.scopeWitness.textById).map(([id,text])=>[canonicalId(id),text])),
    imageIds:prepared.choices.scopeWitness.imageIds.map(canonicalId),claims:original.providerSelections.claims}}:undefined,
   scopeWitness=aliasDiagnostics.scopeWitness&&scopeChoices?validateQuestionScopeWitness(mapQuestionScopeWitness(aliasDiagnostics.scopeWitness,canonicalId),scopeChoices):undefined,
   scopeAssessment=scopeWitness?assessQuestionScopeWitness(scopeWitness,original.providerSelections.claims):undefined,
   scopeBindings=scopeWitness&&scopeChoices?restoreQuestionScopeBindings(scopeWitness,scopeChoices,initial.packet.selectedPrepared):undefined,
   diagnostics={...aliasDiagnostics,issues:aliasDiagnostics.issues.map(i=>({...i,sourceIds:i.sourceIds.map(id=>byLabel.get(id)!)})),...(scopeWitness?{scopeWitness}:{})},
   review={version:reviewVersion,...(policy.auditProfile?{auditProfile:policy.auditProfile}:{}),...(policy.scopeWitnessPolicy?{scopeWitnessPolicy:policy.scopeWitnessPolicy,scopeAssessment,scopeBindings}:{}),status:'diagnosed-awaiting-independent-review',binding:reviewBinding,bindingSha256:reviewBindingSha256,
    ...execution,aliasDiagnostics,diagnostics,localSupportUnassessed:true,semanticVerified:false,wholeAnswerVerified:false,
    questionCoverage:'unassessed',fullSourceCoverage:'unassessed',conflictExhaustiveness:'unassessed'};
  await policy.recordState({event:'complete-source-review',review});
  const localConcerns=initial.selectedReferenceFindings.filter(f=>{const d=f.diagnostics;
   return policy.scopeWitnessPolicy?d.judgment!=='supported'||!Object.values(d.citationFindings).some(v=>v.judgment==='supports')||
    Object.values(d.citationFindings).some(v=>v.judgment==='contradicts')||['different','not-established'].includes(d.objectUnitScope.alignment):d.judgment==='unsupported';});
  if(mode!=='one-content-revision'||!diagnostics.issues.length&&!localConcerns.length&&scopeAssessment?.status!=='incomplete')return {original:originalRecord,review,revisionCandidate:null};
  // A source-grounded model concern is still fallible. One proposal is a new
  // answer branch, never a verified correction or an overwrite of the old one.
  const base=initial.transport.request,user=base.input[1],content=user.content;
  if(!Array.isArray(content)||content[0]?.type!=='input_text'||typeof content[0].text!=='string')throw Error('Missing content revision source input');
  const sourceInputText=content[0].text;
  const toLabel=new Map(initial.transport.mapping.entries.map(e=>[e.canonicalId,e.label])),originalSelectedReferenceFindings=localConcerns.map(f=>({
   claimId:f.claimId,diagnostics:f.diagnostics,references:f.selectedReferences.map(r=>({refId:r.refId,sourceId:toLabel.get(r.selectionId)!})),
   providerRequestSha256:f.providerRequestSha256,rawResponseSha256:f.rawResponseSha256,bindingSha256:f.bindingSha256}));
   const revisionVersion=policy.scopeWitnessPolicy?QUESTION_SCOPE_REVISION_VERSION:STUDY_CONTENT_REVISION_VERSION,
    concernBinding:{originalConcernClaimIds?:string[];originalUnsupportedClaimIds?:string[]}=policy.scopeWitnessPolicy?
     {originalConcernClaimIds:localConcerns.map(f=>f.claimId)}:{originalUnsupportedClaimIds:localConcerns.map(f=>f.claimId)},
    revisionBinding={version:revisionVersion,parent:reviewBinding,coverageReviewRequestSha256:execution.providerRequestSha256,
   coverageReviewRawSha256:execution.rawResponseSha256,coverageDiagnosticsSha256:digest(aliasDiagnostics),
   ...concernBinding},revisionBindingSha256=digest(revisionBinding),
   request={...base,input:[{...base.input[0],content:base.input[0].content+
    ' This is one content revision of the supplied original answer, not a citation-only edit. Treat reviewer findings as fallible source-bound concerns. '+
    'Address actual omissions or errors using all the original question, fixed question contract, supplied source text and original images. '+
    'The separate original selected-reference findings concern only the references each original claim actually selected; unsupported does not prove a claim false in the full source. '+
    'Do not use the full-source diagnostic to excuse wrong selected references. A proposed claim must select its own actual supporting references and will receive a new selected-only audit. '+
    'Preserve correct useful facts, qualifications and material requested items. Do not delete them merely to obtain a favorable judgment or fit six claims. '+
    'Do not add outside facts, unasked counts, experiments or negative conclusions. Preserve genuine source ambiguity and conflicting roles or values. '+
    (initial.transport.mapping.version===CAPTION_ALIAS_SOURCE_LABEL_VERSION?
     'Return only the normal status/message/claims with the same actual allowed source-label selections. No new question plan or unsupported explanation.':
     'Return only the normal status/message/claims with the same actual SourceN selections. No new question plan or unsupported explanation.')},
    {...user,content:content.map((part,i)=>i?part:{...part,text:JSON.stringify({...JSON.parse(sourceInputText),
     originalAnswer:initial.alias,coverageReview:{version:review.version,diagnostics:aliasDiagnostics,fallible:true},
     originalSelectedReferenceFindings:{version:DOCUMENT_CITATION_AUDIT_VERSION,findings:originalSelectedReferenceFindings,fallible:true},
     parentAnswerSha256:initial.binding.originalAnswerSha256})})}]},
    revisionRequest=scopeWitness?{...request,input:[{...request.input[0],content:request.input[0].content+
     ' Return an answer plus discharges/unresolvedFindingIds for program-assigned fN findings in coverageReview.scopeBindings. '+
     'Each discharge contains findingId and a binding with exactly the original aspectIds, actual sourceIds, new cN claimIds and fallible judgment. '+
     'Select IDs only, never copy quotes, labels or question spans. Cite the actual supporting source IDs in the answer itself; no citation is added by a discharge. '+
     'Retain unresolved finding IDs when scope, evidence or capacity remains unclear. Neither valid bindings nor linked citations establish semantic coverage.'},
      {...request.input[1],content:content.map((part,i)=>i?part:{...part,text:JSON.stringify({...JSON.parse((request.input[1].content as {text:string}[])[0].text),
       coverageReview:{version:review.version,diagnostics:aliasDiagnostics,scopeBindings:aliasDiagnostics.scopeWitness?{
        registrySha256:prepared.choices.scopeWitness!.registrySha256,
        findings:Object.entries(aliasDiagnostics.scopeWitness.requirements).flatMap(([requirementId,r])=>r.findings.map(f=>({requirementId,...f}))).map((f,i)=>({id:`f${i}`,...f}))}:undefined,fallible:true}})})}],
     text:{format:{...request.text.format,name:'complete_study_scope_id_revision_v2',schema:questionScopeRevisionSchema(request.text.format.schema,aliasDiagnostics.scopeWitness!,prepared.choices)}}}:request,
    revisionRequestSha=digest(revisionRequest),revisionBudget=studyAnswerPlanRequestBudget(revisionRequest,{prepared:initial.packet.selectedPrepared});
   await policy.recordState({event:'content-revision-request',binding:revisionBinding,request:revisionRequest});
   const {value:proposal,...revisionExecution}=await executeStudyPlanningRequest(revisionVersion,'content-revision',revisionRequest,revisionBindingSha256,revisionBudget,
    journal(policy,'content-revision'),async()=>{await checked();if(digest(revisionRequest)!==revisionRequestSha)throw Error('Content revision request changed');});
   const identity=studyPlanningRequestIdentity(revisionVersion,revisionRequest,revisionBindingSha256);
  if(revisionExecution.requestIdentity!==identity.requestIdentity||revisionExecution.providerRequestSha256!==identity.providerRequestSha256)throw Error('Content revision execution changed');
   const aliasSelections=scopeWitness?(proposal as {answer:unknown})?.answer:proposal,
    selections=decodeStudySourceLabels(aliasSelections,initial.transport.mapping);
  await policy.recordState({event:'content-revision-proposal',aliasSelections,providerSelections:selections,binding:revisionBinding,...revisionExecution});
  if(selections.claims.length>6){const revisionCandidate={status:'capacity-exceeded',untruncatedValue:selections,binding:revisionBinding,...revisionExecution,
   semanticVerified:false,wholeAnswerVerified:false,questionCoverage:'unassessed'};
   await policy.recordState({event:'content-revision-result',revisionCandidate});return {original:originalRecord,review,revisionCandidate};}
   const revised=resolveDocumentAnswerSelections(selections,initial.packet.prepared.supports),
    scopeDischarges=scopeWitness&&scopeChoices?restoreQuestionScopeDischarges(proposal,scopeWitness,revised.providerSelections.claims,scopeChoices,canonicalId):undefined,
    revisedScopeBindings=scopeDischarges&&scopeChoices?restoreQuestionScopeBindings(scopeDischarges.witness,{...scopeChoices,claimIds:revised.providerSelections.claims.map((_,i)=>`c${i}`)},initial.packet.selectedPrepared):undefined,
    incompleteScope=scopeDischarges?.assessment.status==='incomplete';
   if(incompleteScope){const revisionCandidate={status:'incomplete-scope-witness',...revised,binding:revisionBinding,...revisionExecution,scopeDischarges,scopeBindings:revisedScopeBindings,
     semanticVerified:false,wholeAnswerVerified:false,questionCoverage:'incomplete',fullSourceCoverage:'unassessed'};
    await policy.recordState({event:'content-revision-result',revisionCandidate});return {original:originalRecord,review,revisionCandidate};}
   const audits=await auditStudySelections(question,initial.packet,revised.providerSelections,readContext,policy,'revised-claim-audit');
  await checked();
   const revisionCandidate={status:'revised-awaiting-independent-review',...revised,binding:revisionBinding,...revisionExecution,audits,...(scopeDischarges?{scopeDischarges,scopeBindings:revisedScopeBindings}:{}),
   localUnsupportedClaims:audits.filter(a=>!a.localSupported).map(a=>a.claimIndex),coverageReview:'not-performed-for-revised-candidate',
   semanticVerified:false,wholeAnswerVerified:false,questionCoverage:'unassessed',fullSourceCoverage:'unassessed',conflictExhaustiveness:'unassessed'};
  await policy.recordState({event:'content-revision-result',revisionCandidate});return {original:originalRecord,review,revisionCandidate};
 }catch(error){await policy.recordState({event:'complete-review-failed',original:originalRecord,error:error instanceof Error?error.message:String(error),
  noAutomaticRetry:true,wholeAnswerVerified:false});throw error;}
}

/** A complete selected source uses deterministic input routing; the ranked
 * lane retains its AI plan and lexical batch. Both keep generation and at most
 * six original claim audits, with optional citation-only revision. */
export async function answerPlannedStudyQuestion(question:string,readInitial:()=>Promise<DocumentAnswerContext>,
 readSupplement:(query:string)=>Promise<()=>Promise<DocumentAnswerContext>>,contract:StudyQuestionContract,policy:PlannedStudyAnswerPolicy,supplementalSource?:SupplementalSource,
 completeRoute?:CompleteStudyEvidenceRouteBinding){
 policy={...policy};
 await assertPlannedStudyAnswerPolicy(policy);const checked=validateStudyQuestionContract(question,contract);
 if(policy.completeSourceReview&&!completeRoute)throw Error('Integrated coverage review requires the verified complete-source route');
  if(policy.scopeWitnessPolicy&&(!completeRoute||!policy.completeSourceReview))throw Error('Scope witnesses require the explicit complete-source review route');
 if(policy.sourceLabelPolicy&&!completeRoute)throw Error('Caption aliases require the verified complete single-source evidence route');
 let plan:Omit<ReturnType<typeof restoreCompleteStudyEvidenceRoute>,'prepared'>|Awaited<ReturnType<typeof planContractStudyAnswer>>;
 if(completeRoute){const {prepared:_prepared,...receipt}=restoreCompleteStudyEvidenceRoute(question,await readInitial(),checked,completeRoute);plan=receipt;}
 else plan=await planContractStudyAnswer(question,readInitial,checked,journal(policy,'contract-plan'));
 await policy.recordState({event:completeRoute?'evidence-route':'plan',result:plan});
 if(plan.completion==='capacity-exceeded')return {status:'capacity-exceeded',plan,wholeAnswerVerified:false};
 const queries='kind'in plan||plan.completeSourceProof?[]:studySupplementQueries(question,checked,plan.binding,supplementalSource),readers:(()=>Promise<DocumentAnswerContext>)[]=[];
 for(const q of queries)readers.push(await readSupplement(q.query));
 const read=async()=>{const initial=await readInitial(),extras=[];for(const r of readers)extras.push(await r());return preparePlannedStudyGeneration(question,initial,extras,checked,plan.binding,queries,supplementalSource,policy.sourceLabelPolicy);};
 const packet=await read();await policy.recordState({event:'supplement',receipt:packet.receipt});
 if(!packet.selectedPrepared.supports.length)return {status:'unavailable',plan,receipt:packet.receipt,wholeAnswerVerified:false};
 const transport=preparePlannedStudyGenerationTransport(packet),body=transport.request,budget=studyAnswerPlanRequestBudget(body,{prepared:packet.selectedPrepared});
 const generationVersion=packet.receipt.version===COMPLETE_SOURCE_STUDY_ANSWER_VERSION?COMPLETE_SOURCE_STUDY_ANSWER_VERSION:PLANNED_STUDY_ANSWER_VERSION;
 await policy.recordState({event:'generation-request',version:generationVersion,transport});
 let generationRaw:DocumentCitationAuditResponse|undefined;
 const generationJournal=journal(policy,'generation'),captureGeneration={...generationJournal,
  recordResponse:async(raw:DocumentCitationAuditResponse)=>{await generationJournal.recordResponse(raw);generationRaw=structuredClone(raw);}};
 const checkedRead=async()=>{const current=await read();if(current.bindingSha256!==packet.bindingSha256||
   digest(preparePlannedStudyGenerationTransport(current))!==digest(transport))throw Error('Planned answer composite source changed');return current.context;},
  recheck=async()=>{await checkedRead();},
  {value:aliasSelections,...execution}=await executeStudyPlanningRequest(generationVersion,'generation',body,transport.bindingSha256,budget,captureGeneration,recheck),
  value=decodePlannedStudyGenerationSelections(aliasSelections,packet,transport,execution),generation={...execution,sourceLabels:transport};
 await policy.recordState({event:'generation',value,aliasSelections,...generation,receipt:packet.receipt});
 if(value&&typeof value==='object'&&Array.isArray((value as DocumentAnswerSelections).claims)&&(value as DocumentAnswerSelections).claims.length>6)
  return {status:'capacity-exceeded',plan,generation,untruncatedValue:value,receipt:packet.receipt,wholeAnswerVerified:false};
 const restored=resolveDocumentAnswerSelections(value,packet.prepared.supports),allowed=new Set(packet.receipt.selectedSourceIds);
 if(restored.providerSelections.claims.some(c=>c.citations.some(ref=>!allowed.has(ref.id))))throw Error('Answer used an unselected source');
 const originalLocalRaw=new Map<number,DocumentCitationAuditResponse>(),audits=await auditStudySelections(question,packet,restored.providerSelections,checkedRead,policy,'claim-audit',
  policy.completeSourceReview?(index,raw)=>{originalLocalRaw.set(index,raw);}:undefined);
 await recheck();const original={plan,generation,...restored,audits,receipt:packet.receipt},
  citationRevision=policy.citationRevision===true?await revisePlannedStudyCitation(question,read,original,policy):undefined,
  completeSourceReview=policy.completeSourceReview?await reviewCompletePlannedStudyAnswer(question,read,
   {receipt:packet.receipt,providerSelections:restored.providerSelections,generation,originalRaw:generationRaw!,
    originalLocalAudits:audits.map(a=>({claimIndex:a.claimIndex,result:a.result,originalRaw:originalLocalRaw.get(a.claimIndex)!}))},policy):undefined,
  result={status:'generated-awaiting-independent-review',...original,...(citationRevision?{citationRevision}:{}),
  ...(completeSourceReview?{completeSourceReview}:{}),
  ...('kind'in plan?{planningGapsAssessment:'unassessed' as const}:{unassessedPlanningGaps:plan.plan.missing}),localUnsupportedClaims:audits.filter(a=>!a.localSupported).map(a=>a.claimIndex),
  semanticVerified:false,wholeAnswerVerified:false,fullSourceCoverage:'unassessed',conflictExhaustiveness:'unassessed'};
 await policy.recordState({event:'result',...result});return result;
}

/** Only actual request/schema capacity failures are eligible for a capacity
 * receipt. Source drift, invalid evidence and provider errors must still fail. */
export function isStudyRequestCapacityError(error:unknown){
 return error instanceof DocumentAnswerRequestLimitError||error instanceof Error&&[
  'Contract plan enum count limit exceeded','Plan request input limit exceeded','Plan image budget exceeded',
 ].includes(error.message);
}
