import { createHash, randomUUID } from 'node:crypto';
import {documentSourceName} from '../document-source-name.ts';
import type { PoolClient } from 'pg';
import type { CanvasSource, ExtractedAnalysis } from '../domain.ts';
import { kernelPool, kernelTransaction } from './db.ts';
import {contentTagIngestionMode,recordContentMetadataTags,readContentMetadataTags} from './content-tags.ts';
import {recordIngestedContentClassification} from './content-classification-ingestion.ts';
import {recordContentClassification,readContentClassifications} from './content-classifications.ts';
import {prepareControlledTopics,importControlledTopics} from './content-topic-classification.ts';
import {readContentTaxonomy,recordContentTaxonomy}from'./content-taxonomy-registry.ts';
import {contentTopicJobMode,queueIngestedTopicJobs,runDocumentTopicJob} from './content-topic-jobs.ts';
import {contentTagAnswerObservation} from './content-tag-routing.ts';
import {classificationShadowAnswerObservation} from './classification-route-shadow.ts';
import {classificationGuardAnswerObservation} from './classification-route-guard.ts';
import {observeLiteralCourseCodes} from './question-course-routing.ts';
import {normalizeDocumentRoutingScope,assertDocumentRoutingScope,documentRoutingScopeCounts,hasUnmappedCourseDocuments,type DocumentRoutingScope} from './document-routing-scope.ts';
import { canvasTaskIdentity, canvasTaskReference } from './task-identity.ts';
import {nativeWhitespaceFingerprint} from './native-whitespace.ts';
import { documentSearchText, splitDocumentText, searchDocumentText,projectDocumentOrigSearch,
 type DocumentOrigSearchProvenance,type DocumentSearchOptions } from './document-search.ts';
import {resolveDocumentSource,requireResolvedDocumentSource,mentionedOtherDocumentSources,findMentionedDocumentSources,documentTitleMention,type DocumentSourceHint,type DocumentSourceResolution} from './document-source.ts';
import {FOCUSED_TEXT_LIMITS,focusedDocumentTextQuery,focusedTextQueryHash,type FocusedDocumentText} from './document-focused-text.ts';
import {readFullDocumentEvidence,DocumentEvidenceChangedError,type DocumentEvidenceHit} from './document-evidence.ts';
import {readDocumentNodes} from './document-nodes.ts';
import {bindDocumentQuestionName} from './document-name-binding.ts';
import {synthesizeDocumentAnswer,prepareDocumentAnswer,prepareDocumentAnswerForPolicy,buildDocumentAnswerRequest,buildDocumentAnswerRuntimeRequest,documentAnswerSettings,planDocumentQueryScope,DocumentAnswerRequestLimitError,type DocumentAnswerPolicy,type DocumentAnswerContext} from './document-answer.ts';
import {auditDocumentCitationClaim,assertDocumentCitationAuditPolicy,checkApplicationDocumentCitations,type DocumentCitationAuditBinding,type DocumentCitationAuditPolicy} from './document-citation-audit.ts';
import {checkDocumentQuantityConsistency} from './document-quantity-consistency.ts';
import {reviseDocumentCitationClaim,assertDocumentCitationRevisionPolicy,type DocumentCitationRevisionBinding,type DocumentCitationRevisionPolicy} from './document-citation-revision.ts';
import {planRetrievedStudyAnswer,assertStudyAnswerPlanPolicy,studyAnswerPlanRequestBudget,type StudyAnswerPlanPolicy} from './document-answer-plan.ts';
import {createStudyQuestionContract,planContractStudyAnswer,verifyStudyAnswerCluster,prepareCompleteStudyEvidenceRoute,
 type StudyQuestionContract,type StudyContractPlanBinding} from './document-study-contract.ts';
import {answerPlannedStudyQuestion,assertPlannedStudyAnswerPolicy,isStudyRequestCapacityError,preparePlannedStudyGeneration,preparePlannedStudyGenerationTransport,type PlannedStudyAnswerPolicy} from './document-planned-answer.ts';
import {registerDocumentStructure,prepareDocumentImage,commitDocumentImage,readDocumentSourcePages,readDocumentPageRegions,readDocumentPageRegionsForImages,readDocumentOutline,readDocumentParents,readDocumentImages,documentImageBlobHashes,
 readCompleteDocumentSource,readCompleteDocumentText,COMPLETE_DOCUMENT_SOURCE_LIMITS,DocumentContextError,
 type DocumentContextSource,type DocumentStructureInput,type DocumentImageInput,type CompleteDocumentSourceManifest} from './document-context.ts';
import {prepareRecordingTranscript,type RecordingTranscript} from './recording-transcript.ts';
import {queueDocumentVectorJobs,documentVectorCoverage,runDocumentVectorJob,type DocumentVectorScope} from './document-vector.ts';
import {assertPreparedPdfVisualEvidence,commitPdfVisualEvidence,readPdfVisualEvidence,readPdfInternalLinkEvidence,pdfVisualBlobHashes,
 type PreparedPdfVisualEvidence} from './pdf-visual-evidence.ts';
import type {IngestionJob} from './jobs.ts';
import {readPdfNavigationTextContainers} from './pdf-navigation-text.ts';
import {pdfNavigationProjectionEnabled,withPdfNavigationContext} from './pdf-navigation-projection.ts';
import {createDocumentImageBudget} from './document-image-budget.ts';
import {prepareNativeTableCandidates,assertPreparedNativeTableCandidates,commitNativeTableCandidates,
 searchNativeTableCandidates,readNativeTableCandidateEvidence,nativeTableBlobHashes,
 prepareAuthorImageTableCandidate,commitAuthorImageTableCandidate,searchAuthorImageTableCandidates,readAuthorImageTableCandidateEvidence,
 type CompletedAuthorImageTableRun,
 type PreparedNativeTableCandidates,type DerivedTableCandidate} from './document-table-candidates.ts';
import {assertPreparedDoclingSourceMath,doclingMathBatchProvenance,type PreparedDoclingSourceMath} from './docling-source-math.ts';
import {prepareDoclingOrigSearchHints,assertPreparedDoclingOrigSearchHints,doclingOrigSearchHash,
 prepareDoclingTextContextWindows,type PreparedDoclingTextContextWindows,type OrigSearchInput,type PreparedDoclingOrigSearchHints} from './docling-source-regions.ts';
import {DoclingPageRegionError,type DoclingVisualLayout} from './docling-result.ts';
import type {OriginalDoclingRangeInput,CachedOriginalDoclingRenderer} from './docling-original-range.ts';
import type {NativeRegionIngestionInput,NativeRegionRenderer} from './native-region-ingestion.ts';
import {NATIVE_REGION_TEXT_VERSION,nativeRegionFingerprint,prepareNativeRegionWindows,readNativeRegionObservation,type PreparedNativeRegionWindows} from './native-region-text.ts';

type Json = Record<string, unknown>;
type OrigSearchPage={document_id:string;current_version_id:string;source_version_id:string;source_hash:string;course_id:string;
 raw_sha256:string;mime:string;parser_version:string;page_count:number;page_number:number;evidence_id:string;body:string;content_kind:string;
 search_text:string;search_hint_provenance:DocumentOrigSearchProvenance|null;progress:unknown;layout:DoclingVisualLayout|null};
/** One bounded source, no external IO. The publication read locks the same
 * current source and page rows after all registered CAS has been prepared. */
async function origSearchPages(db:Pick<PoolClient,'query'>,owner:string,id:string,page?:number,lock=false){
 const rows=(await db.query<OrigSearchPage>(`SELECT d.id document_id,d.current_version_id,v.source_version_id,d.source_hash,
  coalesce(d.course_id,'') course_id,s.raw_sha256,s.raw_value->>'mime' mime,v.parser_version,v.page_count,
  p.page_number,p.evidence_id,p.body,p.content_kind,p.search_text,p.search_hint_provenance,s.raw_value->'batchProvenance' progress,
  pv.manifest->'content'->'layout' layout
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
  JOIN document_text_pages p ON p.version_id=v.id
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id AND e.source_item_id=d.source_item_id
  LEFT JOIN document_pdf_visual_manifests pv ON pv.version_id=v.id AND pv.source_version_id=v.source_version_id AND pv.source_hash=d.source_hash
  WHERE d.owner_id=$1 AND d.id=$2 AND d.hidden=false AND ($3::integer IS NULL OR p.page_number=$3)
  AND NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key
   AND newer.hidden=false AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY p.page_number ${lock?'FOR UPDATE OF d,p,v,s':''}`,[owner,id,page??null])).rows;
 if(!rows.length||rows.some(r=>r.mime==='application/pdf'&&(r.raw_sha256!==r.source_hash||r.content_kind!=='page')))throw new DocumentEvidenceChangedError();
 if(page===undefined&&(rows.length!==rows[0].page_count||rows.some((r,i)=>r.page_number!==i+1)))throw new DocumentEvidenceChangedError();
 return rows;
}
function origSearchInput(owner:string,row:OrigSearchPage):OrigSearchInput{
 return {owner,documentId:row.document_id,sourceHash:row.source_hash,pageCount:row.page_count,physicalPage:row.page_number,
  body:row.body,parserVersion:row.parser_version,progress:row.progress,layout:row.layout};
}
function origSearchBinding(owner:string,row:OrigSearchPage){return {owner,documentId:row.document_id,sourceHash:row.source_hash,
 pageCount:row.page_count,physicalPage:row.page_number,currentVersionId:row.current_version_id,sourceVersionId:row.source_version_id,
 evidenceId:row.evidence_id,parserVersion:row.parser_version};}
function assertOrigSearchSource(row:OrigSearchPage,source:DocumentContextSource){
 if(row.document_id!==source.documentId||row.current_version_id!==source.currentVersionId||row.source_version_id!==source.sourceVersionId||
  row.source_hash!==source.sourceHash||(source.courseId!==undefined&&source.courseId!==row.course_id))throw new DocumentEvidenceChangedError();
}
/** Supplement a named source without discarding the original cross-source recall. */
export function mergeStudyEvidence(base:DocumentAnswerContext,added:DocumentAnswerContext):DocumentAnswerContext|null{
 const anchors=new Map(base.anchors.map(n=>[n.id,n]));
 for(const node of added.anchors){const old=anchors.get(node.id);
  if(old&&JSON.stringify([old.document_id,old.source_version_id,old.source_hash,old.evidence_id,old.locator,old.body])!==
   JSON.stringify([node.document_id,node.source_version_id,node.source_hash,node.evidence_id,node.locator,node.body]))throw new DocumentEvidenceChangedError();
  if(!old)anchors.set(node.id,node);
 }
 const parents=new Map(base.parents.map(p=>[p.parentId,p]));
 for(const parent of added.parents){const old=parents.get(parent.parentId);
  if(old&&JSON.stringify([old.status,old.nodes])!==JSON.stringify([parent.status,parent.nodes]))throw new DocumentEvidenceChangedError();
  if(!old)parents.set(parent.parentId,parent);
 }
 const budget=createDocumentImageBudget(),images=new Map<string,DocumentAnswerContext['images'][number]>();
 for(const [i,image]of [...base.images,...added.images].entries()){
  if(!budget.include(image,i+1))return null;
  if(!images.has(image.attachmentId))images.set(image.attachmentId,image);
 }
 return {...base,anchors:[...anchors.values()],parents:[...parents.values()],images:[...images.values()],
  imageSelection:{...budget.snapshot(),omitted:[...base.imageSelection?.omitted??[],...added.imageSelection?.omitted??[]]},
  imageAnchors:[...new Map([...base.imageAnchors??[],...added.imageAnchors??[]].map(n=>[n.evidence_id,n])).values()]};
}
function studyContextInputUpper(request:ReturnType<typeof buildDocumentAnswerRuntimeRequest>,context:DocumentAnswerContext){
 const nonImageRequest=JSON.stringify(request,(key,value)=>key==='image_url'&&typeof value==='string'&&value.startsWith('data:image/png;base64,')?'data:image/png;base64,':value);
 return Buffer.byteLength(nonImageRequest)+COMPLETE_DOCUMENT_SOURCE_LIMITS.framingTokens+(context.imageSelection?.accounting.imageInputTokens??0);
}
type CandidateInput = {
  entityId: string; attribute: string; value: unknown; sourceVersionId: string;
  source: string; sourceItemId: string; originalExcerpt: string;
  confidence: number; authority: string; locator: string;
  acquiredAt: string; publishedAt?: string | null; validFrom?: string | null;
  pendingReason?: string;
};

const stableId = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex');
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value == null ? null : String(value);
const dateOnly = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value == null ? null : String(value);
const safeDate = (value: unknown) => {
  if(typeof value!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value))return null;
  const parsed=Date.parse(value);
  return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
};
const realCalendarDate=(value:string)=>{
  const parsed=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
};

export type Deadline = {
  date: string | null; at: string | null; localTime: string | null;
  timezone: string | null; precision: 'date' | 'hour' | 'minute' | 'second' | null;
  original: string | null;
};

export function parseDeadline(raw: string | null, timezone: string | null = null): Deadline {
  if (!raw) return { date: null, at: null, localTime: null, timezone: null, precision: null, original: null };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  if (date) return realCalendarDate(date)
    ? { date, at: null, localTime: null, timezone: null, precision: 'date', original: raw }
    : { date: null, at: null, localTime: null, timezone: null, precision: null, original: raw };
  // Only an explicit offset or Z establishes an instant. A local time without a zone stays a candidate.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})(?::(\d{2}))?(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.exec(raw);
  const normalized=match && match[3]===undefined ? raw.replace(/T(\d{2})(?=[Zz]|[+-])/,'T$1:00') : raw;
  if (!match || !Number.isFinite(Date.parse(normalized))) return { date: null, at: null, localTime: null, timezone: null, precision: null, original: raw };
  const precision = match[4] !== undefined ? 'second' : match[3] !== undefined ? 'minute' : 'hour';
  const instant = new Date(normalized).toISOString();
  if(!realCalendarDate(match[1]) || (!timezone && !/^[Zz]$/.test(match[5])))
    return {date:null,at:null,localTime:null,timezone:null,precision:null,original:raw};
  // An explicit offset identifies the instant. Preserve local wall time in a trusted IANA zone;
  // A Z suffix explicitly identifies UTC. A numeric offset alone is not an IANA zone.
  if(timezone){
    try{
      const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',
        day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));
      const part=(type:string)=>parts.find(item=>item.type===type)?.value||'';
      const localDate=`${part('year')}-${part('month')}-${part('day')}`;
      const localTime=`${part('hour')}:${part('minute')}:${part('second')}`;
      if(!/^[Zz]$/.test(match[5]) &&
        `${localDate}T${localTime}`!==`${match[1]}T${match[2]}:${match[3]??'00'}:${match[4]??'00'}`)
        return {date:null,at:null,localTime:null,timezone:null,precision:null,original:raw};
      return {date:localDate,at:instant,localTime,timezone,precision,original:raw};
    }catch{return {date:null,at:null,localTime:null,timezone:null,precision:null,original:raw};}
  }
  if(`${match[1]}T${match[2]}:${match[3]??'00'}:${match[4]??'00'}`!==instant.slice(0,19))
    return {date:null,at:null,localTime:null,timezone:null,precision:null,original:raw};
  return {date:instant.slice(0,10),at:instant,localTime:instant.slice(11,19),
    timezone:'Etc/UTC',precision,original:raw};
}

export type MailDeadlineInput={at:string|null;text:string;confidence:number;evidence:string;sourceTimezone?:string|null};

function canvasDeadline(raw:string,source:CanvasSource){
  const due=parseDeadline(raw,source.sourceTimezone??null);
  return source.sourceTimezoneUnavailable&&due.precision!=='date'
    ? {...parseDeadline(null),original:raw} : due;
}

/** A proposed zone is not trusted merely because extraction supplied it. Only a
 * directly paired ISO time (IANA zone), or ISO time [IANA zone], in a verbatim
 * original-body excerpt is supported here. Other natural-language forms remain
 * candidates; do not infer a zone from sender, thread, UI or machine settings. */
function mailDeadlineSource(body:string,claim:MailDeadlineInput){
  const excerpt=(claim.evidence||claim.text).slice(0,4000),zone=claim.sourceTimezone??null;
  const pairs=(text:string)=>Array.from(text.matchAll(/\b(\d{4}-\d{2}-\d{2}T\d{2}(?::\d{2})?(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)\s*(?:\(([A-Za-z0-9_+\-/]+)\)|\[([A-Za-z0-9_+\-/]+)\])/g))
    .map(match=>({at:match[1],zone:match[2]??match[3]}));
  const quoted=pairs(excerpt),sameTime=pairs(body).filter(pair=>pair.at===claim.at);
  const verified=typeof zone==='string'&&Boolean(zone)&&Boolean(excerpt)&&body.includes(excerpt)&&
    quoted.length===1&&quoted[0].at===claim.at&&quoted[0].zone===zone&&
    sameTime.length>0&&sameTime.every(pair=>pair.zone===zone);
  const due=zone&&!verified&&!/^\d{4}-\d{2}-\d{2}$/.test(claim.at??'')
    ? {...parseDeadline(null),original:claim.at} : parseDeadline(claim.at,verified?zone:null);
  return {at:claim.at,text:claim.text,confidence:claim.confidence,excerpt,sourceTimezone:zone,
    sourceTimezoneVerified:verified,due};
}

async function sourceVersion(client: PoolClient, input: {
  id: string; source: string; scope: string; externalId: string; courseId?: string | null;
  sourceUrl?: string | null; contentHash: string; raw: unknown; publishedAt?: string | null;
  remoteUpdatedAt?: string | null; acquiredAt: string; rawUri?: string | null; rawSha256?: string | null;
}): Promise<string> {
  await client.query(
    `INSERT INTO source_items(id,source,scope,external_id,source_url,course_id,last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO UPDATE SET
     source_url=excluded.source_url,course_id=excluded.course_id,state='active',missing_at=NULL,last_seen_at=excluded.last_seen_at`,
    [input.id,input.source,input.scope,input.externalId,input.sourceUrl ?? null,input.courseId ?? null,input.acquiredAt]);
  const id = stableId(input.id, input.contentHash);
  await client.query(
    `INSERT INTO source_item_versions(id,source_item_id,content_hash,raw_value,raw_uri,raw_sha256,published_at,remote_updated_at,acquired_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(source_item_id,content_hash) DO NOTHING`,
    [id,input.id,input.contentHash,JSON.stringify(input.raw),input.rawUri ?? null,input.rawSha256 ?? null,
      safeDate(input.publishedAt),safeDate(input.remoteUpdatedAt),input.acquiredAt]);
  return id;
}

async function acceptCandidate(client: PoolClient, candidateId: string, reason: string): Promise<void> {
  const candidate = (await client.query<{entity_id:string;attribute:string;value:unknown;evidence_id:string;valid_from:Date|null}>(
    `SELECT c.entity_id,c.attribute,c.value,c.evidence_id,e.valid_from FROM candidate_facts c
     JOIN evidence e ON e.id=c.evidence_id WHERE c.id=$1 FOR UPDATE OF c`, [candidateId])).rows[0];
  if (!candidate) throw new Error('Candidate not found');
  const factId = stableId(candidate.entity_id,candidate.attribute);
  const previous = (await client.query<{version:number}>(
    'SELECT version FROM facts WHERE id=$1 FOR UPDATE', [factId])).rows[0];
  const version = (previous?.version ?? 0) + 1;
  if(previous?.version && candidate.valid_from)await client.query(
    `UPDATE fact_versions SET valid_to=$3 WHERE fact_id=$1 AND version=$2
     AND valid_to IS NULL AND (valid_from IS NULL OR valid_from<=$3)`,
    [factId,previous.version,candidate.valid_from]);
  await client.query(
    `INSERT INTO facts(id,entity_id,attribute,canonical_value,chosen_candidate_id,version)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
     canonical_value=excluded.canonical_value,chosen_candidate_id=excluded.chosen_candidate_id,
     version=excluded.version,updated_at=now()`,
    [factId,candidate.entity_id,candidate.attribute,JSON.stringify(candidate.value),candidateId,version]);
  await client.query(
    `INSERT INTO fact_versions(fact_id,version,value,candidate_id,reason,valid_from)
     VALUES ($1,$2,$3,$4,$5,$6)`, [factId,version,JSON.stringify(candidate.value),candidateId,
      reason,candidate.valid_from]);
  await client.query('UPDATE candidate_facts SET status=\'accepted\',reason=$2,decided_at=now() WHERE id=$1', [candidateId,reason]);
  await client.query('INSERT INTO fact_evidence(fact_id,evidence_id,candidate_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [factId,candidate.evidence_id,candidateId]);
}

async function recordCandidate(client: PoolClient, input: CandidateInput): Promise<string> {
  if(!Number.isFinite(input.confidence)||input.confidence<0||input.confidence>1)
    throw new Error('Candidate confidence must be between 0 and 1');
  if(!['course_payload','enabled','task_payload','due','cancelled','local_status','event_payload'].includes(input.attribute))
    throw new Error('Unsupported canonical attribute');
  if(input.attribute==='due'){
    const due=input.value as Deadline;
    if(!due||typeof due.original!=='string'||
      (due.precision==='date'&&(!due.date||due.at!==null))||
      (due.precision!==null&&due.precision!=='date'&&(!due.at||!due.timezone||!due.localTime)))
      throw new Error('Invalid deadline candidate');
  }
  if(input.attribute==='task_payload'){
    const value=input.value as Json | null;
    if(!value||typeof value!=='object'||Array.isArray(value)||
      !['id','courseId','sourceType','sourceId','title','action'].every(key=>typeof value[key]==='string'&&String(value[key]).trim())||
      !Array.isArray(value.requirements)||!value.requirements.every(item=>typeof item==='string')||
      (value.startAt!=null&&safeDate(value.startAt)===null)||
      (value.estimatedMinutes!=null&&(!Number.isFinite(value.estimatedMinutes)||Number(value.estimatedMinutes)<0)))
      throw new Error('Invalid task candidate');
  }
  await client.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE',[input.entityId]);
  const evidenceId = stableId(input.sourceVersionId,input.locator);
  await client.query(
    `INSERT INTO evidence(id,source_version_id,source,source_item_id,acquired_at,published_at,original_excerpt,
      parsed_value,confidence,valid_from,locator)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
    [evidenceId,input.sourceVersionId,input.source,input.sourceItemId,input.acquiredAt,safeDate(input.publishedAt),
      input.originalExcerpt,JSON.stringify(input.value),input.confidence,
      safeDate(input.validFrom)??safeDate(input.publishedAt)??input.acquiredAt,input.locator]);
  const candidateId = stableId(input.entityId,input.attribute,evidenceId);
  await client.query(
    `INSERT INTO candidate_facts(id,entity_id,attribute,value,evidence_id,status,authority,reason)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,$7) ON CONFLICT(id) DO NOTHING`,
    [candidateId,input.entityId,input.attribute,JSON.stringify(input.value),evidenceId,input.authority,input.pendingReason??null]);
  const existing = (await client.query<{id:string;canonical_value:unknown;chosen_candidate_id:string;same_value:boolean}>(
    `SELECT id,canonical_value,chosen_candidate_id,canonical_value=$3::jsonb AS same_value
     FROM facts WHERE entity_id=$1 AND attribute=$2 FOR UPDATE`,
    [input.entityId,input.attribute,JSON.stringify(input.value)])).rows[0];
  const status = (await client.query<{status:string}>('SELECT status FROM candidate_facts WHERE id=$1',[candidateId])).rows[0].status;
  if (status !== 'pending') return candidateId;
  if (existing?.same_value) {
    if(input.authority==='canvas' && ['task_payload','due'].includes(input.attribute)){
      const types=(await client.query<{chosen_type:string;incoming_type:string}>(
        `SELECT split_part(chosen.external_id,':',1) chosen_type,
         split_part(incoming.external_id,':',1) incoming_type
         FROM candidate_facts c JOIN evidence e ON e.id=c.evidence_id
         JOIN source_items chosen ON chosen.id=e.source_item_id
         JOIN source_items incoming ON incoming.id=$2 WHERE c.id=$1`,
        [existing.chosen_candidate_id,input.sourceItemId])).rows[0];
      if(types?.chosen_type==='planner'&&types.incoming_type!=='planner'){
        await acceptCandidate(client,candidateId,'direct Canvas item has priority over planner summary');
        return candidateId;
      }
    }
    await client.query('UPDATE candidate_facts SET status=\'accepted\',reason=\'corroborating evidence\',decided_at=now() WHERE id=$1',[candidateId]);
    await client.query('INSERT INTO fact_evidence(fact_id,evidence_id,candidate_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [existing.id,evidenceId,candidateId]);
    return candidateId;
  }
  if (!existing && ['canvas','piazza','verified_official','legacy_import','calendar_import'].includes(input.authority)) {
    await acceptCandidate(client,candidateId,'first validated evidence');
    return candidateId;
  }
  if (existing && ['canvas','piazza','calendar_import'].includes(input.authority)) {
    const prior = (await client.query<{source:string;source_item_id:string;remote_updated_at:Date|null;acquired_at:Date}>(
      `SELECT e.source,e.source_item_id,v.remote_updated_at,e.acquired_at FROM candidate_facts c JOIN evidence e ON e.id=c.evidence_id
       JOIN source_item_versions v ON v.id=e.source_version_id WHERE c.id=$1`,[existing.chosen_candidate_id])).rows[0];
    const priorType=(await client.query<{external_id:string}>(
      'SELECT external_id FROM source_items WHERE id=$1',[prior?.source_item_id])).rows[0]?.external_id.split(':')[0];
    const incomingType=(await client.query<{external_id:string}>(
      'SELECT external_id FROM source_items WHERE id=$1',[input.sourceItemId])).rows[0]?.external_id.split(':')[0];
    if (prior?.source === 'legacy_import' && input.authority === 'canvas') {
      await acceptCandidate(client,candidateId,'current Canvas evidence supersedes legacy import');
    } else if (input.authority === 'canvas' && prior?.source === 'canvas' &&
      priorType === 'planner' && incomingType !== 'planner' &&
      ['task_payload','due'].includes(input.attribute)) {
      await acceptCandidate(client,candidateId,'direct Canvas item supersedes planner summary');
    } else if (input.authority === 'calendar_import' && prior?.source === 'calendar_import') {
      await acceptCandidate(client,candidateId,'new explicitly imported calendar version');
    } else if (prior?.source === input.source && prior.source_item_id===input.sourceItemId &&
      (safeDate(input.publishedAt)&&prior.remote_updated_at
        ?Date.parse(input.publishedAt!)>prior.remote_updated_at.getTime()
        :Date.parse(input.acquiredAt)>prior.acquired_at.getTime())) {
      await acceptCandidate(client,candidateId,'newer version of the same source item');
    }
  }
  // Different sources, uncertain authority, and ambiguous date changes remain pending for review.
  return candidateId;
}

async function entity(client: PoolClient, id: string, kind: string, identityKey: string, courseId: string | null, termId: string | null): Promise<void> {
  await client.query(
    `INSERT INTO entities(id,owner_id,kind,identity_key,course_id,term_id)
     VALUES ($1,'local-owner',$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,[id,kind,identityKey,courseId,termId]);
}

async function canvasTaskEntity(client: PoolClient, source: CanvasSource, index: number): Promise<string> {
  const identityKey=canvasTaskIdentity(source,index);
  const ref=canvasTaskReference(source);
  if (!ref) {
    const id=stableId('task',identityKey);
    await entity(client,id,'task',identityKey,source.courseId,null);
    return id;
  }
  // Serialize this typed reference so planner-first and assignment-first scans choose one entity.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[identityKey]);
  if(source.sourceType==='planner'){
    const separation=(await client.query<{planner_entity_id:string}>(
      `SELECT s.planner_entity_id FROM canvas_task_separations s
       JOIN entities e ON e.id=s.planner_entity_id AND e.merged_into IS NULL
       WHERE s.planner_source_item_id=$1 AND s.action_index=$2`,[source.id,index])).rows[0];
    if(separation)return separation.planner_entity_id;
  }
  const mapped=(await client.query<{entity_id:string}>(
    `SELECT entity_id FROM canvas_task_identity WHERE course_id=$1 AND reference_type=$2
     AND reference_id=$3 AND action_index=$4`,[source.courseId,ref.type,ref.id,index])).rows[0];
  if (mapped) return mapped.entity_id;
  const existing=index===0?(await client.query<{entity_id:string}>(
    `SELECT t.entity_id FROM tasks t JOIN entities e ON e.id=t.entity_id
     WHERE t.course_id=$1 AND e.merged_into IS NULL AND
       ((t.source_type=$2 AND t.source_id=$3) OR
        (t.source_type='planner' AND t.source_item_id=$4))
     ORDER BY CASE WHEN t.source_type=$2 THEN 0 ELSE 1 END,t.id LIMIT 1`,
    [source.courseId,ref.type,ref.id,source.id])).rows[0]:undefined;
  const byKey=(await client.query<{id:string}>(
    `SELECT id FROM entities WHERE owner_id='local-owner' AND kind='task' AND identity_key=$1
     AND merged_into IS NULL`,[identityKey])).rows[0];
  const id=existing?.entity_id||byKey?.id||stableId('task',identityKey);
  if (!existing && !byKey) await entity(client,id,'task',identityKey,source.courseId,null);
  await client.query(
    `INSERT INTO canvas_task_identity(course_id,reference_type,reference_id,action_index,entity_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[source.courseId,ref.type,ref.id,index,id]);
  return id;
}

async function projectTask(client: PoolClient, entityId: string, sourceItemId: string): Promise<void> {
  const merged=(await client.query<{merged_into:string|null}>(
    'SELECT merged_into FROM entities WHERE id=$1',[entityId])).rows[0]?.merged_into;
  if (merged) return;
  const result = await client.query<{attribute:string;canonical_value:unknown;updated_at:Date}>(
    'SELECT attribute,canonical_value,updated_at FROM facts WHERE entity_id=$1',[entityId]);
  const facts = Object.fromEntries(result.rows.map(row=>[row.attribute,row.canonical_value]));
  const payload = facts.task_payload as Json | undefined;
  if (!payload) return;
  const existingTask=(await client.query<{id:string;source_item_id:string}>(
    'SELECT id,source_item_id FROM tasks WHERE entity_id=$1',[entityId])).rows[0];
  const chosenSource=(await client.query<{source_item_id:string}>(
    `SELECT e.source_item_id FROM facts f JOIN candidate_facts c ON c.id=f.chosen_candidate_id
     JOIN evidence e ON e.id=c.evidence_id WHERE f.entity_id=$1 AND f.attribute='task_payload'`,[entityId])).rows[0];
  const primarySourceItemId=chosenSource?.source_item_id||existingTask?.source_item_id||sourceItemId;
  const sourceState=(await client.query<{state:string}>(
    'SELECT state FROM source_items WHERE id=$1',[primarySourceItemId])).rows[0]?.state;
  const due = (facts.due as Deadline | undefined) ?? parseDeadline(null);
  const cancelled = facts.cancelled === true;
  const cancelledAt=cancelled?result.rows.find(row=>row.attribute==='cancelled')?.updated_at??null:null;
  const localStatus=['active','completed','ignored'].includes(String(facts.local_status))
    ?String(facts.local_status):'active';
  await client.query(
    `INSERT INTO tasks(id,entity_id,course_id,source_item_id,source_type,source_id,source_url,title,action,requirements,
      start_at,due_date,due_at,due_local_time,due_timezone,due_precision,due_original,unlock_at,lock_at,canvas_status,
      urgency,confidence,evidence_excerpt,estimated_minutes,points_possible,prerequisite_blocked,cancelled_at,source_missing,local_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
       $27,$28,$29)
     ON CONFLICT(id) DO UPDATE SET source_item_id=excluded.source_item_id,source_type=excluded.source_type,
       source_id=excluded.source_id,source_url=excluded.source_url,title=excluded.title,action=excluded.action,requirements=excluded.requirements,
       start_at=excluded.start_at,due_date=excluded.due_date,due_at=excluded.due_at,due_local_time=excluded.due_local_time,
       due_timezone=excluded.due_timezone,due_precision=excluded.due_precision,due_original=excluded.due_original,
       unlock_at=excluded.unlock_at,lock_at=excluded.lock_at,canvas_status=excluded.canvas_status,
       urgency=excluded.urgency,confidence=excluded.confidence,evidence_excerpt=excluded.evidence_excerpt,
       estimated_minutes=excluded.estimated_minutes,points_possible=excluded.points_possible,
       prerequisite_blocked=excluded.prerequisite_blocked,cancelled_at=excluded.cancelled_at,
       source_missing=excluded.source_missing,local_status=excluded.local_status,updated_at=now()`,
    [existingTask?.id||String(payload.id),entityId,payload.courseId,primarySourceItemId,
      payload.sourceType,payload.sourceId,payload.sourceUrl,
      payload.title,payload.action,JSON.stringify(payload.requirements ?? []),safeDate(payload.startAt),due.date,due.at,
      due.localTime,due.timezone,due.precision,due.original,safeDate(payload.unlockAt),safeDate(payload.lockAt),
      cancelled ? 'possibly_superseded' : payload.canvasStatus,payload.urgency,payload.confidence,payload.evidence,
      payload.estimatedMinutes,payload.pointsPossible,payload.prerequisiteBlocked,cancelledAt,
      sourceState==='missing',localStatus]);
}

export class KernelService {
  async canvasDuplicateReport() {
    const rows=(await kernelPool().query<{
      id:string;entity_id:string;course_id:string;source_id:string;source_item_id:string;
      source_url:string|null;local_status:string;raw_value:CanvasSource|null;
      separation_reason:string|null;
    }>(`SELECT t.id,t.entity_id,t.course_id,t.source_id,t.source_item_id,t.source_url,t.local_status,
       v.raw_value,sep.reason separation_reason FROM tasks t JOIN entities en ON en.id=t.entity_id
       LEFT JOIN canvas_task_separations sep ON sep.planner_source_item_id=t.source_item_id
         AND t.id=t.source_item_id||':'||sep.action_index::text
       LEFT JOIN LATERAL (SELECT raw_value FROM source_item_versions
         WHERE source_item_id=t.source_item_id ORDER BY acquired_at DESC,id DESC LIMIT 1) v ON true
       WHERE t.source_type='planner' AND en.merged_into IS NULL ORDER BY t.course_id,t.id`)).rows;
    const direct=(await kernelPool().query<{id:string;entity_id:string;course_id:string;source_type:string;source_id:string;local_status:string}>(
      `SELECT t.id,t.entity_id,t.course_id,t.source_type,t.source_id,t.local_status FROM tasks t
       JOIN entities en ON en.id=t.entity_id WHERE t.source_type IN ('assignment','quiz','discussion','page')
       AND en.merged_into IS NULL`)).rows;
    const verified:Array<{plannerTaskId:string;directTaskId:string;courseId:string;reference:string}> = [];
    const unresolved:Array<{plannerTaskId:string;courseId:string;reason:string;possibleTaskIds:string[]}> = [];
    for(const planner of rows){
      const raw=planner.raw_value;
      const ref=raw && typeof raw==='object' && raw.sourceType==='planner'
        ?canvasTaskReference(raw):canvasTaskReference({courseId:planner.course_id,sourceType:'planner',sourceId:planner.source_id,
          sourceUrl:planner.source_url} as CanvasSource);
      const candidates=direct.filter(item=>item.course_id===planner.course_id &&
        item.source_id===(ref?.id||planner.source_id) && (!ref||item.source_type===ref.type) &&
        item.entity_id!==planner.entity_id);
      const index=Number(planner.id.slice(planner.source_item_id.length+1));
      if(ref && candidates.length===1 && !planner.separation_reason &&
        planner.id.startsWith(`${planner.source_item_id}:`) && index===0)
        verified.push({plannerTaskId:planner.id,directTaskId:candidates[0].id,
        courseId:planner.course_id,reference:`${ref.type}:${ref.id}`});
      else if(candidates.length || !ref || planner.separation_reason)unresolved.push({plannerTaskId:planner.id,courseId:planner.course_id,
        reason:planner.separation_reason?'explicitly separated after rollback':
          ref&&index!==0?'additional planner action requires adjudication':
          ref?'multiple direct objects share the reference':'missing reliable typed reference',
        possibleTaskIds:candidates.map(item=>item.id)});
    }
    const activeCount=Number((await kernelPool().query(
      'SELECT count(*) FROM tasks t JOIN entities e ON e.id=t.entity_id WHERE e.merged_into IS NULL')).rows[0].count);
    const planHash=stableId(JSON.stringify({activeCount,verified,unresolved}));
    return {activeCount,verified,unresolved,projectedCount:activeCount-verified.length,planHash};
  }

  async mergeCanvasTasks(plannerTaskId:string,directTaskId:string,reason:string,actor:string,manual=false) {
    if(!reason.trim()||!actor.trim())throw new Error('Merge actor and reason are required');
    return kernelTransaction(async client=>{
      const beforeCount=Number((await client.query(
        'SELECT count(*) FROM tasks t JOIN entities e ON e.id=t.entity_id WHERE e.merged_into IS NULL')).rows[0].count);
      const pair=(await client.query<{
        id:string;entity_id:string;course_id:string;source_type:string;source_id:string;
        source_item_id:string;source_url:string|null;local_status:string;merged_into:string|null;
      }>(`SELECT t.id,t.entity_id,t.course_id,t.source_type,t.source_id,t.source_item_id,t.source_url,
         t.local_status,e.merged_into FROM tasks t JOIN entities e ON e.id=t.entity_id
         WHERE t.id=ANY($1::text[]) ORDER BY t.id FOR UPDATE OF t,e`,[[plannerTaskId,directTaskId]])).rows;
      const planner=pair.find(row=>row.id===plannerTaskId),direct=pair.find(row=>row.id===directTaskId);
      if(!planner||!direct||planner.source_type!=='planner'||
        !['assignment','quiz','discussion','page'].includes(direct.source_type)||
        planner.course_id!==direct.course_id||planner.entity_id===direct.entity_id||
        planner.merged_into||direct.merged_into)throw new Error('Invalid active Canvas task pair');
      const raw=(await client.query<{raw_value:CanvasSource}>(
        `SELECT raw_value FROM source_item_versions WHERE source_item_id=$1
         ORDER BY acquired_at DESC,id DESC LIMIT 1`,[planner.source_item_id])).rows[0]?.raw_value;
      const reference=raw?.sourceType==='planner'?canvasTaskReference(raw):null;
      if(reference && (reference.type!==direct.source_type||reference.id!==direct.source_id))
        throw new Error('Planner reference contradicts direct Canvas object');
      if(!reference && !manual)throw new Error('Typed Canvas reference is missing; explicit adjudication required');
      if(planner.local_status!=='active'&&direct.local_status!=='active'&&planner.local_status!==direct.local_status)
        throw new Error('Conflicting local statuses require separate adjudication');
      const actionIndex=planner.id.startsWith(`${planner.source_item_id}:`)
        ?Number(planner.id.slice(planner.source_item_id.length+1)):NaN;
      if(!Number.isInteger(actionIndex)||actionIndex<0)
        throw new Error('Planner action index is not verifiable');
      if(actionIndex!==0&&!manual)throw new Error('Additional planner action requires explicit adjudication');
      const addedEvidence:Array<{factId:string;evidenceId:string}>=[];
      const copiedCandidates:string[]=[];
      const createdFactIds:string[]=[];
      const sourceCandidates=(await client.query<{
        attribute:string;value:unknown;evidence_id:string;authority:string;
      }>(`SELECT attribute,value,evidence_id,authority FROM candidate_facts WHERE entity_id=$1
         ORDER BY created_at,id`,[planner.entity_id])).rows;
      for(const candidate of sourceCandidates){
        const copiedId=stableId(direct.entity_id,candidate.attribute,candidate.evidence_id);
        const inserted=await client.query(
          `INSERT INTO candidate_facts(id,entity_id,attribute,value,evidence_id,status,authority,reason)
           VALUES ($1,$2,$3,$4,$5,'pending',$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
          [copiedId,direct.entity_id,candidate.attribute,JSON.stringify(candidate.value),candidate.evidence_id,
            candidate.authority,`copied from merged task ${plannerTaskId}`]);
        if(inserted.rowCount)copiedCandidates.push(copiedId);
      }
      const sourceFacts=(await client.query<{attribute:string;canonical_value:unknown;chosen_candidate_id:string}>(
        'SELECT attribute,canonical_value,chosen_candidate_id FROM facts WHERE entity_id=$1',[planner.entity_id])).rows;
      for(const sourceFact of sourceFacts){
        if(sourceFact.attribute==='local_status')continue;
        let targetFact=(await client.query<{id:string;canonical_value:unknown}>(
          'SELECT id,canonical_value FROM facts WHERE entity_id=$1 AND attribute=$2 FOR UPDATE',
          [direct.entity_id,sourceFact.attribute])).rows[0];
        if(!targetFact){
          const old=(await client.query<{evidence_id:string}>(
            'SELECT evidence_id FROM candidate_facts WHERE id=$1',[sourceFact.chosen_candidate_id])).rows[0];
          if(old){
            const copiedId=stableId(direct.entity_id,sourceFact.attribute,old.evidence_id);
            await acceptCandidate(client,copiedId,`merged from ${plannerTaskId}: ${reason.trim()}`);
            targetFact=(await client.query<{id:string;canonical_value:unknown}>(
              'SELECT id,canonical_value FROM facts WHERE entity_id=$1 AND attribute=$2',
              [direct.entity_id,sourceFact.attribute])).rows[0];
            if(targetFact)createdFactIds.push(targetFact.id);
          }
        }
        if(targetFact){
          const matching=sourceCandidates.filter(item=>item.attribute===sourceFact.attribute &&
            JSON.stringify(item.value)===JSON.stringify(targetFact.canonical_value));
          for(const item of matching){
            const copiedId=stableId(direct.entity_id,item.attribute,item.evidence_id);
            await client.query(`UPDATE candidate_facts SET status='accepted',reason='corroborating merged evidence',
              decided_at=now() WHERE id=$1 AND status='pending'`,[copiedId]);
            const added=await client.query<{fact_id:string;evidence_id:string}>(
              `INSERT INTO fact_evidence(fact_id,evidence_id,candidate_id) VALUES ($1,$2,$3)
               ON CONFLICT DO NOTHING RETURNING fact_id,evidence_id`,[targetFact.id,item.evidence_id,copiedId]);
            for(const row of added.rows)addedEvidence.push({factId:row.fact_id,evidenceId:row.evidence_id});
          }
        }
      }
      if(planner.local_status!=='active'&&direct.local_status==='active'){
        const at=new Date().toISOString();
        const mergeSource=`manual:task_merge:${plannerTaskId}`;
        const version=await sourceVersion(client,{id:mergeSource,source:'manual',scope:'local-owner',
          externalId:mergeSource,contentHash:stableId(plannerTaskId,directTaskId,reason,at),
          raw:{plannerTaskId,directTaskId,status:planner.local_status,reason},acquiredAt:at});
        const candidateId=await recordCandidate(client,{entityId:direct.entity_id,attribute:'local_status',
          value:planner.local_status,sourceVersionId:version,source:'manual',sourceItemId:mergeSource,
          originalExcerpt:reason,confidence:1,authority:'manual',locator:'local_status',acquiredAt:at});
        const status=(await client.query<{status:string}>(
          'SELECT status FROM candidate_facts WHERE id=$1',[candidateId])).rows[0]?.status;
        if(status==='pending')await acceptCandidate(client,candidateId,`status retained from ${plannerTaskId}`);
        await client.query('UPDATE tasks SET local_status=$2 WHERE id=$1',[directTaskId,planner.local_status]);
      }
      const statusFact=(await client.query<{id:string;canonical_value:unknown}>(
        `SELECT id,canonical_value FROM facts WHERE entity_id=$1 AND attribute='local_status'`,
        [direct.entity_id])).rows[0];
      if(statusFact)for(const item of sourceCandidates.filter(candidate=>candidate.attribute==='local_status' &&
        JSON.stringify(candidate.value)===JSON.stringify(statusFact.canonical_value))){
        const copiedId=stableId(direct.entity_id,'local_status',item.evidence_id);
        await client.query(`UPDATE candidate_facts SET status='accepted',reason='corroborating merged status',
          decided_at=now() WHERE id=$1 AND status='pending'`,[copiedId]);
        const added=await client.query<{fact_id:string;evidence_id:string}>(
          `INSERT INTO fact_evidence(fact_id,evidence_id,candidate_id) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING RETURNING fact_id,evidence_id`,[statusFact.id,item.evidence_id,copiedId]);
        for(const row of added.rows)addedEvidence.push({factId:row.fact_id,evidenceId:row.evidence_id});
      }
      await projectTask(client,direct.entity_id,direct.source_item_id);
      await client.query('UPDATE entities SET merged_into=$2 WHERE id=$1',[planner.entity_id,direct.entity_id]);
      await client.query('DELETE FROM canvas_task_separations WHERE planner_source_item_id=$1 AND action_index=$2',
        [planner.source_item_id,actionIndex]);
      await client.query('UPDATE canvas_task_identity SET entity_id=$2 WHERE entity_id=$1',
        [planner.entity_id,direct.entity_id]);
      await client.query('DELETE FROM tasks WHERE id=$1',[plannerTaskId]);
      const activeCount=Number((await client.query(
        'SELECT count(*) FROM tasks t JOIN entities e ON e.id=t.entity_id WHERE e.merged_into IS NULL')).rows[0].count);
      const targetStatus=planner.local_status!=='active'&&direct.local_status==='active'
        ?planner.local_status:direct.local_status;
      await client.query(`INSERT INTO task_entity_merges(source_entity_id,target_entity_id,source_task_id,
        target_task_id,action_index,source_status,target_status_before,added_fact_evidence,copied_candidate_ids,
        created_fact_ids,actor,reason,before_value,after_value)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[planner.entity_id,direct.entity_id,plannerTaskId,
        directTaskId,actionIndex,planner.local_status,direct.local_status,JSON.stringify(addedEvidence),
        JSON.stringify(copiedCandidates),JSON.stringify(createdFactIds),actor.trim(),reason.trim(),
        JSON.stringify({plannerTaskId,directTaskId,plannerStatus:planner.local_status,
          directStatus:direct.local_status,activeCount:beforeCount}),
        JSON.stringify({taskId:directTaskId,localStatus:targetStatus,activeCount})]);
      return {plannerTaskId,directTaskId,activeCount};
    });
  }

  async unmergeCanvasTasks(plannerTaskId:string,reason:string,actor:string) {
    if(!reason.trim()||!actor.trim())throw new Error('Rollback actor and reason are required');
    return kernelTransaction(async client=>{
      const merge=(await client.query<{source_entity_id:string;target_entity_id:string;source_task_id:string;
        target_task_id:string;action_index:number;source_status:string;target_status_before:string;copied_candidate_ids:string[];
        created_fact_ids:string[];added_fact_evidence:Array<{factId:string;evidenceId:string}>}>(
        `SELECT * FROM task_entity_merges WHERE source_task_id=$1 AND rolled_back_at IS NULL
         FOR UPDATE`,[plannerTaskId])).rows[0];
      if(!merge)throw new Error('Active task merge not found');
      const beforeCount=Number((await client.query(
        'SELECT count(*) FROM tasks t JOIN entities e ON e.id=t.entity_id WHERE e.merged_into IS NULL')).rows[0].count);
      const targetBefore=(await client.query<{local_status:string}>(
        'SELECT local_status FROM tasks WHERE id=$1',[merge.target_task_id])).rows[0]?.local_status;
      for(const factId of merge.created_fact_ids){
        const fact=(await client.query<{version:number;chosen_candidate_id:string}>(
          'SELECT version,chosen_candidate_id FROM facts WHERE id=$1 FOR UPDATE',[factId])).rows[0];
        const first=(await client.query<{candidate_id:string}>(
          'SELECT candidate_id FROM fact_versions WHERE fact_id=$1 AND version=1',[factId])).rows[0];
        if(!fact||!first)throw new Error('Merge-derived fact history changed');
        if(fact.chosen_candidate_id===first.candidate_id){
          const independent=(await client.query<{id:string}>(
            `SELECT c.id FROM fact_evidence fe JOIN candidate_facts c ON c.id=fe.candidate_id
             JOIN evidence ev ON ev.id=c.evidence_id JOIN source_items si ON si.id=ev.source_item_id
             JOIN facts f ON f.id=fe.fact_id WHERE fe.fact_id=$1 AND c.id<>$2
             AND c.id<>ALL($3::text[]) AND c.status='accepted' AND c.value=f.canonical_value
             AND si.source='canvas' AND split_part(si.external_id,':',1)<>'planner'
             ORDER BY c.created_at DESC,c.id LIMIT 1`,
            [factId,first.candidate_id,merge.copied_candidate_ids])).rows[0];
          if(independent)await acceptCandidate(client,independent.id,'direct Canvas evidence retained after merge rollback');
          else if(fact.version===1){
            await client.query('DELETE FROM fact_evidence WHERE fact_id=$1',[factId]);
            await client.query('DELETE FROM fact_versions WHERE fact_id=$1',[factId]);
            await client.query('DELETE FROM facts WHERE id=$1',[factId]);
          }else throw new Error('Merge-derived fact changed; adjudicate it before rollback');
        }
        await client.query('DELETE FROM fact_evidence WHERE fact_id=$1 AND candidate_id=ANY($2::text[])',
          [factId,[...merge.copied_candidate_ids,first.candidate_id]]);
        if(!merge.copied_candidate_ids.includes(first.candidate_id))await client.query(
          `UPDATE candidate_facts SET status='pending',reason='task merge rolled back',decided_at=NULL
           WHERE id=$1`,[first.candidate_id]);
      }
      for(const link of merge.added_fact_evidence)await client.query(
        `DELETE FROM fact_evidence WHERE fact_id=$1 AND evidence_id=$2 AND candidate_id=ANY($3::text[])`,
        [link.factId,link.evidenceId,merge.copied_candidate_ids]);
      await client.query('UPDATE entities SET merged_into=NULL WHERE id=$1',[merge.source_entity_id]);
      await client.query(`UPDATE candidate_facts SET status='superseded',reason='task merge rolled back',decided_at=now()
        WHERE id=ANY($1::text[]) AND status IN ('pending','accepted')`,[merge.copied_candidate_ids]);
      const target=(await client.query<{source_item_id:string}>(
        'SELECT source_item_id FROM tasks WHERE entity_id=$1',[merge.target_entity_id])).rows[0];
      if(target)await projectTask(client,merge.target_entity_id,target.source_item_id);
      const source=(await client.query<{source_item_id:string}>(
        `SELECT e.source_item_id FROM facts f JOIN candidate_facts c ON c.id=f.chosen_candidate_id
         JOIN evidence e ON e.id=c.evidence_id WHERE f.entity_id=$1 AND f.attribute='task_payload'`,
        [merge.source_entity_id])).rows[0];
      if(!source)throw new Error('Merged task has no source payload');
      await client.query(`INSERT INTO canvas_task_separations(planner_source_item_id,action_index,planner_entity_id,
        direct_entity_id,actor,reason) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(planner_source_item_id,action_index)
        DO UPDATE SET planner_entity_id=excluded.planner_entity_id,direct_entity_id=excluded.direct_entity_id,
        actor=excluded.actor,reason=excluded.reason,created_at=now()`,
        [source.source_item_id,merge.action_index,merge.source_entity_id,merge.target_entity_id,
          actor.trim(),reason.trim()]);
      await projectTask(client,merge.source_entity_id,source.source_item_id);
      await client.query('UPDATE tasks SET local_status=$2 WHERE id=$1',
        [plannerTaskId,merge.source_status]);
      const chosenStatus=(await client.query<{source_item_id:string}>(
        `SELECT e.source_item_id FROM facts f JOIN candidate_facts c ON c.id=f.chosen_candidate_id
         JOIN evidence e ON e.id=c.evidence_id WHERE f.entity_id=$1 AND f.attribute='local_status'`,
        [merge.target_entity_id])).rows[0]?.source_item_id;
      if(chosenStatus===`manual:task_merge:${plannerTaskId}`){
        const at=new Date().toISOString(),undoSource=`manual:task_unmerge:${plannerTaskId}`;
        const version=await sourceVersion(client,{id:undoSource,source:'manual',scope:'local-owner',
          externalId:undoSource,contentHash:stableId(plannerTaskId,at),
          raw:{plannerTaskId,targetTaskId:merge.target_task_id,status:merge.target_status_before},acquiredAt:at});
        const candidateId=await recordCandidate(client,{entityId:merge.target_entity_id,
          attribute:'local_status',value:merge.target_status_before,sourceVersionId:version,
          source:'manual',sourceItemId:undoSource,originalExcerpt:'Canvas task merge rolled back',
          confidence:1,authority:'manual',locator:'local_status',acquiredAt:at});
        const status=(await client.query<{status:string}>(
          'SELECT status FROM candidate_facts WHERE id=$1',[candidateId])).rows[0]?.status;
        if(status==='pending')await acceptCandidate(client,candidateId,'task merge rolled back');
        await client.query('UPDATE tasks SET local_status=$2 WHERE id=$1',
          [merge.target_task_id,merge.target_status_before]);
      }
      const activeCount=Number((await client.query(
        'SELECT count(*) FROM tasks t JOIN entities e ON e.id=t.entity_id WHERE e.merged_into IS NULL')).rows[0].count);
      const targetAfter=(await client.query<{local_status:string}>(
        'SELECT local_status FROM tasks WHERE id=$1',[merge.target_task_id])).rows[0]?.local_status;
      await client.query(`UPDATE task_entity_merges SET rolled_back_at=now(),rolled_back_by=$2,
        rollback_reason=$3,rollback_before_value=$4,rollback_after_value=$5
        WHERE source_entity_id=$1 AND rolled_back_at IS NULL`,
        [merge.source_entity_id,actor.trim(),reason.trim(),
          JSON.stringify({taskId:merge.target_task_id,localStatus:targetBefore,activeCount:beforeCount}),
          JSON.stringify({plannerTaskId,plannerStatus:merge.source_status,targetTaskId:merge.target_task_id,
            targetStatus:targetAfter,activeCount})]);
      return {plannerTaskId,activeCount};
    });
  }
  async ingestRawSource(input:{id:string;source:string;scope:string;externalId:string;
    courseId?:string|null;sourceUrl?:string|null;contentHash:string;metadata:Json;
    rawUri:string;excerpt:string;publishedAt?:string|null;remoteUpdatedAt?:string|null}):Promise<void>{
    const acquiredAt=new Date().toISOString();
    await kernelTransaction(async client=>{
      const version=await sourceVersion(client,{id:input.id,source:input.source,scope:input.scope,
        externalId:input.externalId,courseId:input.courseId,sourceUrl:input.sourceUrl,
        contentHash:input.contentHash,raw:input.metadata,rawUri:input.rawUri,
        rawSha256:input.contentHash,acquiredAt,publishedAt:input.publishedAt,
        remoteUpdatedAt:input.remoteUpdatedAt});
      const evidenceId=stableId(version,'raw');
      await client.query(
        `INSERT INTO evidence(id,source_version_id,source,source_item_id,acquired_at,published_at,
          original_excerpt,parsed_value,confidence,locator)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,'raw') ON CONFLICT(id) DO NOTHING`,
        [evidenceId,version,input.source,input.id,acquiredAt,safeDate(input.publishedAt),
          input.excerpt.slice(0,4000),JSON.stringify(input.metadata)]);
    });
  }

  async upsertCourse(course: Json, source = 'canvas'): Promise<void> {
    const id = String(course.id);
    const term = course.term as Json | undefined;
    const termName = String(term?.name ?? course.term_name ?? '').trim();
    const termId = termName ? `term:${String(term?.id ?? termName).toLowerCase()}` : null;
    const raw = { id, termId, name: course.name ?? course.course_code ?? '未命名课程',
      enabled: course.enabled !== false && course.enabled !== 0,
      code: course.course_code ?? course.code ?? course.name ?? id, termName,sourceTimezone:course.time_zone??null,
      startsAt: course.start_at ?? term?.start_at ?? null, endsAt: course.end_at ?? term?.end_at ?? null };
    const hash = stableId(JSON.stringify(raw));
    await kernelTransaction(async client => {
      if (termId) await client.query(
        `INSERT INTO academic_terms(id,name) VALUES ($1,$2) ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=now()`,[termId,termName]);
      await client.query(`INSERT INTO courses(id,term_id,name,code,enabled) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [id,termId,String(raw.name),String(raw.code),raw.enabled]);
      const sourceId=`${source}:course:${id}`;
      const version=await sourceVersion(client,{id:sourceId,source,scope:'courses',externalId:id,courseId:id,
        contentHash:hash,raw,acquiredAt:new Date().toISOString(),remoteUpdatedAt:safeDate(course.updated_at)});
      const entityId=stableId('course',id);
      await entity(client,entityId,'course',id,id,termId);
      await recordCandidate(client,{entityId,attribute:'course_payload',value:raw,sourceVersionId:version,source,
        sourceItemId:sourceId,originalExcerpt:JSON.stringify(raw),confidence:1,
        authority:source==='canvas'?'canvas':source==='piazza'?'piazza':'legacy_import',
        locator:'course_payload',acquiredAt:new Date().toISOString(),publishedAt:safeDate(course.updated_at)});
      const chosen=(await client.query<{canonical_value:Json}>(
        `SELECT canonical_value FROM facts WHERE entity_id=$1 AND attribute='course_payload'`,[entityId])).rows[0]?.canonical_value;
      const enabledFact=(await client.query<{canonical_value:boolean}>(
        `SELECT canonical_value FROM facts WHERE entity_id=$1 AND attribute='enabled'`,[entityId])).rows[0];
      if (chosen) await client.query(
        `UPDATE courses SET name=$2,code=$3,term_id=$4,starts_at=$5,ends_at=$6,enabled=$7,updated_at=now() WHERE id=$1`,
        [id,chosen.name,chosen.code,chosen.termId,safeDate(chosen.startsAt),safeDate(chosen.endsAt),enabledFact?enabledFact.canonical_value:chosen.enabled]);
    });
  }

  async ingestCanvasSource(source: CanvasSource, analysis: ExtractedAnalysis | null, hash: string, provenance: 'canvas'|'legacy_import' = 'canvas'): Promise<void> {
    const acquiredAt=new Date().toISOString();
    const raw=source;
    await kernelTransaction(async client => {
      const version=await sourceVersion(client,{id:source.id,source:'canvas',scope:source.courseId,
        externalId:`${source.sourceType}:${source.sourceId}`,courseId:source.courseId,sourceUrl:source.sourceUrl,
        contentHash:provenance==='legacy_import'?`legacy:${hash}`:hash,raw,acquiredAt,remoteUpdatedAt:source.updatedAt});
      const deterministic=['assignment','quiz'].includes(source.sourceType) || Boolean(source.dueAt);
      const aiActions=analysis?.actions||[];
      const baseAction={title:source.title,action:`完成并提交 ${source.title}`,requirements:[],
        recommendedStartAt:null,inferredDueAt:null,confidence:'certain' as const,
        evidence:source.body.slice(0,220),estimatedMinutes:null,possiblyCancelled:false};
      const actions=deterministic?[baseAction]:aiActions;
      for (const [index,action] of actions.entries()) {
        const entityId=await canvasTaskEntity(client,source,index);
        const payloadFor=(candidate:typeof action)=>({id:`${source.id}:${index}`,courseId:source.courseId,sourceType:source.sourceType,
          sourceId:source.sourceId,sourceUrl:source.sourceUrl,title:candidate.title || source.title,action:candidate.action,
          requirements:candidate.requirements,startAt:candidate.recommendedStartAt,unlockAt:source.unlockAt,lockAt:source.lockAt,
          canvasStatus:source.submissionState==='submitted'?'completed':'upcoming',urgency:'upcoming',
          confidence:candidate.confidence,evidence:candidate.evidence || '',estimatedMinutes:candidate.estimatedMinutes,
          pointsPossible:source.pointsPossible ?? null,prerequisiteBlocked:Boolean(source.prerequisiteBlocked)});
        const payload=payloadFor(action);
        await recordCandidate(client,{entityId,attribute:'task_payload',value:payload,sourceVersionId:version,
          source:provenance,sourceItemId:source.id,originalExcerpt:source.body.slice(0,2000)||source.title,
          confidence:deterministic?1:0.5,authority:deterministic?provenance:'ai',
          locator:deterministic?`task_payload:${index}`:`ai_task_payload:${index}:${stableId(JSON.stringify(payload))}`,
          acquiredAt,publishedAt:source.updatedAt});
        const rawDue=deterministic?source.dueAt:action.inferredDueAt;
        if (rawDue) {
          const due=canvasDeadline(rawDue,source);
          await recordCandidate(client,{entityId,attribute:'due',value:due,sourceVersionId:version,source:provenance,
            sourceItemId:source.id,originalExcerpt:rawDue,confidence:source.dueAt?1:0.5,
            authority:source.dueAt&&due.precision?provenance:'ai',
            locator:deterministic?`due:${index}`:`ai_due:${index}:${stableId(JSON.stringify(due))}`,
            acquiredAt,publishedAt:source.updatedAt,pendingReason:source.sourceTimezoneUnavailable&&due.precision!=='date'
              ?'Canvas course timezone metadata unavailable; retain the last confirmed deadline':undefined});
        }
        if(deterministic)for(const [aiIndex,aiAction] of aiActions.entries()){
          const aiPayload=payloadFor(aiAction);
          if(JSON.stringify(aiPayload)!==JSON.stringify(payload))await recordCandidate(client,{
            entityId,attribute:'task_payload',value:aiPayload,sourceVersionId:version,source:provenance,
            sourceItemId:source.id,originalExcerpt:(aiAction.evidence||source.body).slice(0,2000),
            confidence:aiAction.confidence==='certain'?0.8:0.5,authority:'ai',
            locator:`ai_task_payload:${index}:${aiIndex}:${stableId(JSON.stringify(aiPayload))}`,
            acquiredAt,publishedAt:source.updatedAt});
          if(aiAction.inferredDueAt){
            const due=canvasDeadline(aiAction.inferredDueAt,source);
            await recordCandidate(client,{entityId,attribute:'due',value:due,sourceVersionId:version,
              source:provenance,sourceItemId:source.id,originalExcerpt:(aiAction.evidence||aiAction.inferredDueAt).slice(0,2000),
              confidence:0.5,authority:'ai',
              locator:`ai_due:${index}:${aiIndex}:${stableId(JSON.stringify(due))}`,
              acquiredAt,publishedAt:source.updatedAt,pendingReason:source.sourceTimezoneUnavailable&&due.precision!=='date'
                ?'Canvas course timezone metadata unavailable; retain the last confirmed deadline':undefined});
          }
        }
        // AI's possiblyCancelled flag is deliberately not interpreted as an authoritative cancellation.
        await projectTask(client,entityId,source.id);
      }
    });
  }

  async importLegacyTask(row: Record<string, unknown>, override?: string): Promise<void> {
    const id=String(row.id),sourceItemId=String(row.source_item_id),courseId=String(row.course_id);
    const index=Number(id.split(':').at(-1));
    const identityKey=row.source_url && ['assignment','quiz','planner'].includes(String(row.source_type))
      ? `${courseId}|${String(row.source_url).replace(/\?.*$/,'')}`
      : `${courseId}|${row.source_type}|${row.source_id}|${Number.isInteger(index)?index:0}`;
    const entityId=stableId('task',identityKey);
    const acquiredAt=new Date().toISOString();
    await kernelTransaction(async client=>{
      await client.query(
        `INSERT INTO source_items(id,source,scope,external_id,course_id,state)
         VALUES ($1,'canvas',$2,$3,$2,'active') ON CONFLICT(id) DO NOTHING`,
        [sourceItemId,courseId,`${row.source_type}:${row.source_id}`]);
      const version=await sourceVersion(client,{id:sourceItemId,source:'canvas',scope:courseId,
        externalId:`${row.source_type}:${row.source_id}`,courseId,sourceUrl:row.source_url as string|null,
        contentHash:`legacy-task:${stableId(JSON.stringify(row))}`,raw:row,acquiredAt,
        remoteUpdatedAt:iso(row.updated_at)});
      await entity(client,entityId,'task',identityKey,courseId,null);
      const requirements=typeof row.requirements_json==='string'?JSON.parse(row.requirements_json):[];
      const payload={id,courseId,sourceType:row.source_type,sourceId:row.source_id,sourceUrl:row.source_url,
        title:row.title,action:row.action,requirements,startAt:row.start_at,unlockAt:row.unlock_at,
        lockAt:row.lock_at,canvasStatus:row.canvas_status,urgency:row.urgency,confidence:row.confidence,
        evidence:row.evidence,estimatedMinutes:row.estimated_minutes,pointsPossible:row.points_possible,
        prerequisiteBlocked:Boolean(row.prerequisite_blocked)};
      await recordCandidate(client,{entityId,attribute:'task_payload',value:payload,sourceVersionId:version,
        source:'legacy_import',sourceItemId,originalExcerpt:JSON.stringify(row).slice(0,4000),confidence:0.8,
        authority:'legacy_import',locator:`task_payload:${id}`,acquiredAt,publishedAt:iso(row.updated_at)});
      if(row.due_at){const due=parseDeadline(String(row.due_at),typeof row.due_timezone==='string'?row.due_timezone:null);await recordCandidate(client,{entityId,attribute:'due',
        value:due,sourceVersionId:version,source:'legacy_import',sourceItemId,originalExcerpt:String(row.due_at),
        confidence:0.8,authority:due.precision?'legacy_import':'ai',locator:`due:${id}`,acquiredAt,
        publishedAt:iso(row.updated_at)});}
      await projectTask(client,entityId,sourceItemId);
      if(override && ['active','completed','ignored'].includes(override)){
        await recordCandidate(client,{entityId,attribute:'local_status',value:override,sourceVersionId:version,
          source:'legacy_import',sourceItemId,originalExcerpt:JSON.stringify({taskId:id,override}),
          confidence:1,authority:'legacy_import',locator:`local_status:${id}`,acquiredAt,
          publishedAt:iso(row.updated_at)});
        await client.query('UPDATE tasks SET local_status=$2 WHERE id=$1',[id,override]);
      }
    });
  }

  async importLegacySource(row: Record<string, unknown>): Promise<void> {
    const id=String(row.id),acquiredAt=new Date().toISOString();
    await kernelTransaction(async client=>{
      await sourceVersion(client,{id,source:'canvas',scope:String(row.course_id),
        externalId:`${row.source_type}:${row.source_id}`,courseId:String(row.course_id),
        sourceUrl:row.source_url as string|null,contentHash:`legacy-source:${row.content_hash}`,
        raw:row,acquiredAt,remoteUpdatedAt:iso(row.remote_updated_at)});
      if(!row.is_active){
        await client.query(`UPDATE source_items SET state='missing',missing_at=$2 WHERE id=$1`,
          [id,safeDate(row.missing_at)??acquiredAt]);
        await client.query('UPDATE tasks SET source_missing=true WHERE source_item_id=$1',[id]);
      }
    });
  }

  async ingestRecordingTranscript(input:RecordingTranscript){
    const prepared=prepareRecordingTranscript(input);
    await this.ingestParsedDocument(prepared.document,prepared.pages,prepared.options);
    return {documentId:prepared.document.id,cues:prepared.pages.length};
  }

  async ingestCachedOriginalDoclingRange(input:OriginalDoclingRangeInput,renderer?:CachedOriginalDoclingRenderer){
    const {ingestCachedOriginalDoclingRange}=await import('./docling-original-range.ts');
    return ingestCachedOriginalDoclingRange(input,renderer);
  }

  async ingestNativeRegionText(input:NativeRegionIngestionInput,renderer?:NativeRegionRenderer){
    const {ingestNativeRegionText}=await import('./native-region-ingestion.ts');
    return ingestNativeRegionText(input,renderer);
  }

  async readDocumentNativeRegions(owner:string,source:DocumentContextSource,physicalPage:number){
    const rows=await origSearchPages(kernelPool(),owner,source.documentId,physicalPage),row=rows[0];
    if(rows.length!==1||row.current_version_id!==source.currentVersionId||row.source_version_id!==source.sourceVersionId||row.source_hash!==source.sourceHash)
      throw new DocumentEvidenceChangedError();
    const result=await readNativeRegionObservation({...origSearchInput(owner,row),currentVersionId:row.current_version_id,
      sourceVersionId:row.source_version_id,evidenceId:row.evidence_id,bodySha256:createHash('sha256').update(row.body).digest('hex')});
    const after=(await origSearchPages(kernelPool(),owner,source.documentId,physicalPage))[0];
    if(after.current_version_id!==row.current_version_id||after.source_version_id!==row.source_version_id||after.body!==row.body||
      JSON.stringify(nativeRegionFingerprint(after.progress))!==JSON.stringify(nativeRegionFingerprint(row.progress)))throw new DocumentEvidenceChangedError();
    return result;
  }

  async ingestParsedDocument(document: {id:string;ownerId?:string;createdAt?:string;courseId:string;name:string;originalName?:string|null;hash:string;mime:string;origin:string;originKey:string;rawUri?:string},
    inputPages: Array<{locator:string;text:string;pageNumber?:number;contentKind?:'page'|'time_segment';startMs?:number;endMs?:number}>,
    options:{parserVersion?:string;expectedPages?:number;warnings?:string[];extractionMethod?:string;
      expectedCurrentVersion?:string|null;pageProvenance?:Array<{pageNumber:number;extractionMethod:string;parserVersion:string;model?:string;
        basedOn:{versionId:string;sourceVersionId:string;evidenceId:string}}>;
      ingestionLease?:{id:string;token:string};batchProvenance?:unknown;recording?:Record<string,unknown>;evidenceConfidence?:number;
      nativeTables?:PreparedNativeTableCandidates;pdfVisuals?:PreparedPdfVisualEvidence;sourceMath?:PreparedDoclingSourceMath}={}) {
    const tagMetadata=contentTagIngestionMode(),topicJobs=contentTopicJobMode();
    const pages=inputPages.map((page,index)=>({...page,pageNumber:page.pageNumber??index+1}));
    const expected=options.expectedPages??pages.length;
    if(!Number.isInteger(expected)||expected<1||pages.length!==expected||
      pages.some((page,index)=>page.pageNumber!==index+1||typeof page.text!=='string'||!page.locator)||
      !pages.some(page=>page.text.trim()))throw new Error('Document transcription is incomplete');
    if(pages.some(page=>page.contentKind==='time_segment'
      ? !Number.isSafeInteger(page.startMs)||!Number.isSafeInteger(page.endMs)||page.startMs!<0||page.endMs!<=page.startMs!
      : page.startMs!==undefined||page.endMs!==undefined))throw new Error('Invalid content time locator');
    if(options.evidenceConfidence!==undefined&&(!Number.isFinite(options.evidenceConfidence)||
      options.evidenceConfidence<0||options.evidenceConfidence>1))throw new Error('Invalid evidence confidence');
    if(options.pageProvenance&&(options.pageProvenance.length!==expected||options.pageProvenance.some((page,index)=>
      page.pageNumber!==index+1||!page.extractionMethod||!page.parserVersion||!page.basedOn?.versionId||!page.basedOn.sourceVersionId||!page.basedOn.evidenceId)))
      throw new Error('Document page repair provenance is incomplete');
    const parser=options.parserVersion||'docling-v1',owner=document.ownerId||'local-owner';
    const previousName=document.originalName==null&&document.origin==='upload'?(await kernelPool().query<{current_version_id:string;source_name:unknown}>(
      `SELECT d.current_version_id,s.raw_value->'sourceName' source_name FROM document_texts d
       JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
       JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
       WHERE d.owner_id=$1 AND d.id=$2 AND d.source_hash=$3 AND s.raw_sha256=$3 AND NOT d.hidden`,
      [owner,document.id,document.hash])).rows[0]:undefined;
    const sourceName=documentSourceName(document.name,document.originalName,previousName?.source_name),
      canonicalName=sourceName?.originalName??document.name;
      if(options.pdfVisuals){
        if(document.mime!=='application/pdf')throw new Error('PDF visual evidence requires a PDF source');
        assertPreparedPdfVisualEvidence(options.pdfVisuals,owner,document.id,document.hash,expected);
      }
      const expectedCurrentVersion=options.expectedCurrentVersion!==undefined?options.expectedCurrentVersion:
        previousName?.source_name?previousName.current_version_id:
        options.pdfVisuals?await this.documentIngestionHead(owner,document.id,document.hash):undefined;
    if(options.nativeTables)assertPreparedNativeTableCandidates(options.nativeTables,owner,document.id,document.hash);
    if(options.sourceMath){
      if(document.mime!=='application/pdf')throw Error('Docling source math requires an actual PDF source');
      assertPreparedDoclingSourceMath(options.sourceMath,owner,document.id,document.hash,pages);
    }
    const batchProvenance=options.sourceMath?doclingMathBatchProvenance(options.sourceMath,options.batchProvenance):options.batchProvenance;
    const origHints:Array<PreparedDoclingOrigSearchHints|null>=[];
    const origUnavailable:Array<{physicalPage:number;code:'unavailable'|'limit';reason:string}>=[];
    for(const page of pages){
      try{origHints.push(document.mime==='application/pdf'?await prepareDoclingOrigSearchHints({owner,documentId:document.id,
        sourceHash:document.hash,pageCount:expected,physicalPage:page.pageNumber,body:page.text,parserVersion:parser,
        progress:batchProvenance,layout:options.pdfVisuals?.content.layout}):null);}
      catch(error){
        // Optional recall metadata must not discard an otherwise valid body.
        // Corrupt/foreign bindings are invalid and remain hard failures.
        if(!(error instanceof DoclingPageRegionError)||(error.code!=='unavailable'&&error.code!=='limit'))throw error;
        origHints.push(null);origUnavailable.push({physicalPage:page.pageNumber,code:error.code,reason:error.message});
      }
    }
    if(options.warnings!==undefined&&(!Array.isArray(options.warnings)||options.warnings.some(value=>typeof value!=='string')))
      throw new Error('Document quality warnings are invalid');
    const warnings=[...new Set((options.warnings||[]).map(value=>value.trim()).filter(Boolean))].sort();
    const extractionMethod=options.extractionMethod?.trim()||parser;
    // Quality changes are immutable source changes even when the body is the
    // same. Normalize stable metadata; acquisition times and remote task IDs
    // intentionally remain outside identity so a replay stays idempotent.
    const nativeWhitespace=nativeWhitespaceFingerprint(batchProvenance);
    const nativeRegionText=nativeRegionFingerprint(batchProvenance);
    const qualityHash=stableId(JSON.stringify({warnings,extractionMethod,
      ...(sourceName?{sourceName}:{}),
      ...(nativeWhitespace?{nativeWhitespace}:{}),
      ...(nativeRegionText?{nativeRegionText}:{}),
      ...(options.sourceMath?{sourceMathSha256:options.sourceMath.sha256}:{}),
      ...(options.pdfVisuals?{pdfVisualContentSha256:options.pdfVisuals.contentSha256}:{}),
      ...(options.pageProvenance?{pageProvenance:options.pageProvenance.map(page=>({
        pageNumber:page.pageNumber,extractionMethod:page.extractionMethod,parserVersion:page.parserVersion,
        ...(page.model?{model:page.model}:{}),basedOn:{versionId:page.basedOn.versionId,
          sourceVersionId:page.basedOn.sourceVersionId,evidenceId:page.basedOn.evidenceId}}))}:{}),
      ...(options.recording?{recording:{...Object.fromEntries(
        ['partnerId','entryId','captionId','language','sourceUrl','canvasCourseId','method','model','publishedAt']
          .map(key=>[key,options.recording![key]??null])),...(options.recording.asr?{asr:options.recording.asr}:{})},
        evidenceConfidence:options.evidenceConfidence??0.9}:{})}));
    const textHash=stableId(JSON.stringify(pages));
    const parsedVersion=stableId(document.id,parser,textHash,qualityHash);
    const sourceItemId=`document:${document.id}`,acquiredAt=new Date().toISOString();
    await kernelTransaction(async client=>{
      if(options.ingestionLease){
        const job=(await client.query<{payload:Record<string,unknown>}>(`SELECT payload FROM ingestion_jobs
          WHERE id=$1 AND lease_token=$2 AND kind='docling_document' AND state='running' AND lease_until>now() FOR UPDATE`,
          [options.ingestionLease.id,options.ingestionLease.token])).rows[0];
        if(!job||job.payload.owner!==owner||job.payload.id!==document.id||
          (job.payload.sourceHash!==undefined&&job.payload.sourceHash!==document.hash))throw new Error('PDF ingestion lease or source identity lost');
      }
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`document:${document.id}`]);
      if(expectedCurrentVersion!==undefined){
        const head=(await client.query<{current_version_id:string|null;owner_id:string;source_hash:string;hidden:boolean}>(
          'SELECT current_version_id,owner_id,source_hash,hidden FROM document_texts WHERE id=$1 FOR UPDATE',[document.id])).rows[0];
        const identityMatches=!head||(!head.hidden&&head.owner_id===owner&&head.source_hash===document.hash);
        if(!identityMatches||(expectedCurrentVersion===null?Boolean(head?.current_version_id):!head||head.current_version_id!==expectedCurrentVersion))
          throw new Error('Document changed during page repair; previous current version preserved');
        if(options.pageProvenance){
          if(!head||typeof expectedCurrentVersion!=='string')throw new Error('Document page repair requires an existing current-version guard');
          const previous=(await client.query<{page_number:number;evidence_id:string;source_version_id:string}>(
            `SELECT p.page_number,p.evidence_id,v.source_version_id FROM document_text_versions v
             JOIN document_text_pages p ON p.version_id=v.id WHERE v.id=$1 AND v.document_id=$2`,[head.current_version_id,document.id])).rows;
          const byPage=new Map(previous.map(page=>[page.page_number,page]));
          if(options.pageProvenance.some(page=>{const old=byPage.get(page.pageNumber);return !old||page.basedOn.versionId!==head.current_version_id||
            page.basedOn.sourceVersionId!==old.source_version_id||page.basedOn.evidenceId!==old.evidence_id;}))throw new Error('Document page repair evidence identity mismatch');
        }
      }else if(options.pageProvenance)throw new Error('Document page repair requires a current-version guard');
      const version=await sourceVersion(client,{id:sourceItemId,source:`document:${document.origin}`,scope:document.courseId||'unscoped',
        externalId:document.id,courseId:document.courseId||null,
        contentHash:stableId(document.hash,parser,textHash,qualityHash),raw:{id:document.id,name:canonicalName,mime:document.mime,
          ...(sourceName?{sourceName}:{}),
          originKey:document.originKey,parser,extractionMethod,warnings,
          ...(batchProvenance?{batchProvenance}:{}),
          ...(options.sourceMath?{sourceMathSha256:options.sourceMath.sha256}:{}),
          ...(options.pdfVisuals?{pdfVisualContentSha256:options.pdfVisuals.contentSha256}:{}),
          ...(options.recording?{recording:options.recording}:{}),
          ...(options.pageProvenance?{pageProvenance:options.pageProvenance}:{}),
          pages:pages.map(page=>({locator:page.locator,pageNumber:page.pageNumber,length:page.text.length}))},
        rawUri:document.rawUri||`library://${document.hash}`,rawSha256:document.hash,acquiredAt});
      await client.query(`INSERT INTO document_texts(id,owner_id,course_id,source_item_id,origin,origin_key,name,source_hash,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
        [document.id,owner,document.courseId||null,sourceItemId,document.origin,document.originKey,canonicalName,document.hash,document.createdAt||acquiredAt]);
      const existing=(await client.query<{owner_id:string;source_hash:string}>(
        'SELECT owner_id,source_hash FROM document_texts WHERE id=$1',[document.id])).rows[0];
      if(existing.owner_id!==owner||existing.source_hash!==document.hash)throw new Error('Document identity mismatch');
      await client.query(`INSERT INTO document_text_versions(id,document_id,source_version_id,parser_version,text_hash,page_count,warnings)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
        [parsedVersion,document.id,version,parser,textHash,expected,JSON.stringify(warnings)]);
      // sourceVersion can reuse an immutable same-body historical row. Check
      // that row's registered progress, not just this invocation's options.
      const registeredProgress=origHints.some(Boolean)?(await client.query<{progress:unknown}>(
        `SELECT raw_value->'batchProvenance' progress FROM source_item_versions WHERE id=$1 FOR UPDATE`,[version])).rows[0]?.progress:null;
      let position=0;const pageEvidenceIds:string[]=[];
      for(const [index,page] of pages.entries()){
        const evidenceId=stableId(version,`page:${index}`);
        pageEvidenceIds.push(evidenceId);
        await client.query(
          `INSERT INTO evidence(id,source_version_id,source,source_item_id,acquired_at,original_excerpt,
            parsed_value,confidence,locator) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
          [evidenceId,version,`document:${document.origin}`,sourceItemId,acquiredAt,page.text.slice(0,4000),
            JSON.stringify({textLength:page.text.length,parser,extractionMethod:options.pageProvenance?.[index].extractionMethod||extractionMethod,
              ...(options.pageProvenance?{pageProvenance:options.pageProvenance[index]}:{}),documentVersion:parsedVersion,
              ...(options.sourceMath?{sourceMath:{policy:options.sourceMath.provenance.policy,provenanceSha256:options.sourceMath.sha256,
                formulaRelationsVerified:false}}:{}),
              pageNumber:page.pageNumber,contentKind:page.contentKind||'page',startMs:page.startMs??null,endMs:page.endMs??null}),options.evidenceConfidence??0.9,page.locator]);
        await client.query(`INSERT INTO document_text_pages(version_id,page_number,evidence_id,locator,body,search_text,content_kind,start_ms,end_ms)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(version_id,page_number) DO NOTHING`,
          [parsedVersion,page.pageNumber,evidenceId,page.locator,page.text,documentSearchText(page.text),page.contentKind||'page',page.startMs??null,page.endMs??null]);
        const hint=origHints[index];
        if(hint){
          assertPreparedDoclingOrigSearchHints(hint,{owner,documentId:document.id,sourceHash:document.hash,pageCount:expected,
            physicalPage:page.pageNumber,body:page.text,parserVersion:parser,progress:registeredProgress,layout:options.pdfVisuals?.content.layout});
          const old=(await client.query<{body:string;search_text:string;search_hint_provenance:DocumentOrigSearchProvenance|null}>(
            'SELECT body,search_text,search_hint_provenance FROM document_text_pages WHERE version_id=$1 AND page_number=$2 FOR UPDATE',
            [parsedVersion,page.pageNumber])).rows[0];
          if(!old||old.body!==page.text)throw new DocumentEvidenceChangedError();
          const projected=projectDocumentOrigSearch(page.text,old.search_text,old.search_hint_provenance,hint,{owner,documentId:document.id,
            sourceHash:document.hash,pageCount:expected,physicalPage:page.pageNumber,currentVersionId:parsedVersion,sourceVersionId:version,
            evidenceId,parserVersion:parser});
          await client.query('UPDATE document_text_pages SET search_text=$3,search_hint_provenance=$4::jsonb WHERE version_id=$1 AND page_number=$2',
            [parsedVersion,page.pageNumber,projected.searchText,projected.provenance?JSON.stringify(projected.provenance):null]);
        }
        for(const body of splitDocumentText(page.text)){
          await client.query(`INSERT INTO document_text_chunks(id,version_id,page_number,position,body,search_text)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
            [stableId(parsedVersion,String(position)),parsedVersion,page.pageNumber,position,body,documentSearchText(body)]);
          position++;
        }
      }
      await client.query(`UPDATE document_texts SET current_version_id=$2,indexed_at=now() WHERE id=$1`,[document.id,parsedVersion]);
      if(tagMetadata==='metadata-v1')await recordContentMetadataTags(client,owner,document.id,parsedVersion);
      if(tagMetadata==='metadata-classifications-v1')await recordIngestedContentClassification(client,owner,document.id,parsedVersion);
      if(options.pdfVisuals||options.sourceMath){
        const source={documentId:document.id,currentVersionId:parsedVersion,sourceVersionId:version,sourceHash:document.hash,courseId:document.courseId||''};
        if(options.pdfVisuals)await commitPdfVisualEvidence(client,options.pdfVisuals,source,pageEvidenceIds);
        await registerDocumentStructure(client,owner,source,{rawSourceHash:document.hash,
          parserVersion:options.sourceMath?'pdf-docling-source-math-v1':'pdf-physical-pages-v1',parents:[],
          ...(options.sourceMath?{sourceMath:options.sourceMath.provenance}:{}),
          nodes:pages.map((page,index)=>({evidenceId:pageEvidenceIds[index],locator:page.locator,ordinal:index,kind:'page',bodySha256:createHash('sha256').update(page.text).digest('hex')}))},options.sourceMath);
      }
      // Bind only after the same-version real PDF manifest has been published.
      if(options.nativeTables){
        await commitNativeTableCandidates(client,options.nativeTables,{documentId:document.id,currentVersionId:parsedVersion,
          sourceVersionId:version,sourceHash:document.hash,courseId:document.courseId||''},pageEvidenceIds);
      }
      if(topicJobs==='controlled-v1')await queueIngestedTopicJobs(client,owner,document.id,parsedVersion);
      if(process.env.KERNEL_DOCUMENT_HYBRID==='true')
        await queueDocumentVectorJobs(client,owner,{documentId:document.id});
    });
    // Availability is not immutable parser quality. Keep it out of body,
    // warnings and parsedVersion; no-data ordinary ingestion still returns void.
    if(origUnavailable.length)return {origSearchHints:{status:'unavailable' as const,pages:origUnavailable,
      authority:'unverified-retrieval-hint' as const}};
  }

  resolveDocumentSource(owner:string,hint:DocumentSourceHint,options:{courseId?:string;routingScope?:DocumentRoutingScope}={}){
    return resolveDocumentSource(kernelPool(),owner,hint,options);
  }

  findMentionedDocumentSources(owner:string,question:string,options:{courseId?:string;routingScope?:DocumentRoutingScope}={}){
    return findMentionedDocumentSources(kernelPool(),owner,question,options);
  }

  mentionedOtherDocumentSources(owner:string,question:string,selectedDocumentId:string){
    return mentionedOtherDocumentSources(kernelPool(),owner,question,selectedDocumentId);
  }

  async documentIngestionHead(owner:string,documentId:string,sourceHash:string){
    const row=(await kernelPool().query<{current_version_id:string|null;owner_id:string;source_hash:string;hidden:boolean}>(
      'SELECT current_version_id,owner_id,source_hash,hidden FROM document_texts WHERE id=$1',[documentId])).rows[0];
    if(row&&(row.owner_id!==owner||row.source_hash!==sourceHash||row.hidden))throw new Error('Document ingestion owner/source is not current');
    return row?.current_version_id??null;
  }

  registerDocumentStructure(owner:string,source:DocumentContextSource,input:DocumentStructureInput){
    return kernelTransaction(client=>registerDocumentStructure(client,owner,source,input));
  }

  async registerDocumentImage(owner:string,source:DocumentContextSource,input:DocumentImageInput){
    const prepared=await prepareDocumentImage(kernelPool(),owner,source,input);
    return kernelTransaction(client=>commitDocumentImage(client,owner,prepared));
  }

  readDocumentSourcePages(owner:string,source:DocumentContextSource){
    return readDocumentSourcePages(kernelPool(),owner,source);
  }

  readDocumentPageRegions(owner:string,source:DocumentContextSource,physicalPage:number){
    return readDocumentPageRegions(kernelPool(),owner,source,physicalPage);
  }

  readDocumentOutline(owner:string,source:DocumentContextSource){
    return readDocumentOutline(kernelPool(),owner,source);
  }

  readDocumentParents(owner:string,anchors:DocumentEvidenceHit[],options:{includeImages?:boolean;identityCourseCodes?:string[]}={},imageBudget?:ReturnType<typeof createDocumentImageBudget>){
    return readDocumentParents(kernelPool(),owner,anchors,options,imageBudget);
  }

  readDocumentImages(owner:string,source:DocumentContextSource,captionEvidenceIds:string[]){
    return readDocumentImages(kernelPool(),owner,source,captionEvidenceIds);
  }

  documentImageBlobHashes(){
    return Promise.all([documentImageBlobHashes(kernelPool()),pdfVisualBlobHashes(kernelPool())]).then(parts=>[...new Set(parts.flat())]);
  }

  async publishedDocumentBlobHashes(){
    const {publishedParsingBlobHashes}=await import('./docling-batches.ts');
    return publishedParsingBlobHashes(kernelPool());
  }

  readPdfVisualEvidence(owner:string,source:DocumentContextSource,pageEvidenceIds?:string[]){
    return readPdfVisualEvidence(kernelPool(),owner,source,pageEvidenceIds);
  }
  readPdfInternalLinks(owner:string,source:DocumentContextSource){
    return readPdfInternalLinkEvidence(kernelPool(),owner,source);
  }
  readPdfNavigationTextContainers(owner:string,source:DocumentContextSource,physicalPage:number){
    return readPdfNavigationTextContainers(kernelPool(),owner,source,physicalPage);
  }

  nativeTableBlobHashes(){return nativeTableBlobHashes(kernelPool());}

  /** Explicit administrator registration of one completed, source-bound run.
   * No model, parser, embeddings, or batch import occurs here. */
  async registerAuthorImageTableCandidate(owner:string,source:DocumentContextSource,input:CompletedAuthorImageTableRun){
    const prepared=await prepareAuthorImageTableCandidate(kernelPool(),owner,source,input);
    return kernelTransaction(client=>commitAuthorImageTableCandidate(client,prepared));
  }

  searchAuthorImageTableCandidates(owner:string,question:string,source:DocumentContextSource){
    return searchAuthorImageTableCandidates(kernelPool(),owner,question,source);
  }

  readAuthorImageTableCandidateEvidence(owner:string,candidates:Parameters<typeof readAuthorImageTableCandidateEvidence>[2]){
    return readAuthorImageTableCandidateEvidence(kernelPool(),owner,candidates);
  }

  searchNativeTableCandidates(owner:string,question:string,scope:{courseId?:string;documentId?:string;routingScope?:DocumentRoutingScope;strict?:boolean}={}){
    return searchNativeTableCandidates(kernelPool(),owner,question,scope);
  }

  readNativeTableCandidateEvidence(owner:string,candidates:DerivedTableCandidate[]){
    return readNativeTableCandidateEvidence(kernelPool(),owner,candidates);
  }

  /** Explicit, bounded current-source rebuild from saved native results only.
   * No conversion, embeddings, model, queue, or original-text replacement. */
  async rebuildNativeTableCandidates(owner:string,source:DocumentContextSource){
    source={...source};
    const before=await this.readDocumentSourcePages(owner,source);
    if(before.nodes.length>32)throw new Error('Native table reconstruction is limited to 32 source pages per call');
    const saved=(await kernelPool().query<{raw_value:Record<string,unknown>}>(
      'SELECT raw_value FROM source_item_versions WHERE id=$1',[source.sourceVersionId])).rows[0];
    const progress=saved?.raw_value.batchProvenance as import('./docling-batches.ts').DoclingProgress|undefined;
    if(!progress?.identity||progress.identity.owner!==owner||progress.identity.documentId!==source.documentId||
      progress.identity.sourceHash!==source.sourceHash)throw new Error('Saved native Docling provenance is unavailable');
    const {readBlob}=await import('../library.ts'),{decodeCachedDoclingReplay}=await import('./docling-cache-replay.ts');
    const decoded=await decodeCachedDoclingReplay(await readBlob(source.sourceHash),progress.identity,progress);
    const value=await prepareNativeTableCandidates({owner,documentId:source.documentId,sourceHash:source.sourceHash,tables:decoded.nativeTables});
    return kernelTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`document:${source.documentId}`]);
      return commitNativeTableCandidates(client,value,source,before.nodes.map(node=>node.evidenceId));
    });
  }

  readDocumentNodes(owner:string,expectedSource:DocumentContextSource,evidenceIds:string[]){
    return readDocumentNodes(kernelPool(),owner,expectedSource,evidenceIds);
  }

  bindDocumentQuestionName(owner:string,source:DocumentContextSource,question:string,input:unknown){
    return bindDocumentQuestionName(kernelPool(),owner,source,question,input);
  }

  readCompleteDocumentSource(owner:string,expectedSource:DocumentContextSource){
    return readCompleteDocumentSource(kernelPool(),owner,expectedSource);
  }
  readCompleteDocumentText(owner:string,expectedSource:DocumentContextSource){
    return readCompleteDocumentText(kernelPool(),owner,expectedSource);
  }

  /** Explicit selected-source route. Complete refers to source coverage, never
   * semantic correctness or a relevance ranking. No paid planner or fallback. */
  async answerSelectedStudySource(owner:string,question:string,expectedSource:DocumentContextSource,policy:DocumentAnswerPolicy={}){
    if(!['gpt-5-mini','gpt-5.4-mini'].includes(policy.model??'gpt-5-mini')||(policy.reasoningEffort??'low')!=='low'||
      (policy.maxOutputTokens??4000)!==4000||(policy.timeoutMs??30000)!==30000)
      throw new Error('Complete selected-source answers require the fixed mini low/4000/30s policy');
    const {model}=await documentAnswerSettings(policy);
    const source={...expectedSource},initial=await this.readCompleteDocumentSource(owner,source);
    if(initial.status==='unavailable')return initial;
    const limits=COMPLETE_DOCUMENT_SOURCE_LIMITS,settings={model,reasoningEffort:'low' as const,maxOutputTokens:4000};
    let latest=initial;
    const requestManifest=():CompleteDocumentSourceManifest=>{
      const prepared=prepareDocumentAnswer(question,latest.context);
      if(!prepared.quoteUnits.some(unit=>unit.selectable)&&!prepared.supports.some(support=>support.kind==='image'))return latest.manifest;
      let body:ReturnType<typeof buildDocumentAnswerRequest>;
      try{body=buildDocumentAnswerRequest(prepared,settings);}
      catch(error){
        if(!(error instanceof DocumentAnswerRequestLimitError))throw error;
        const {manifestSha256:_previous,...manifest}=latest.manifest;
        const value={...manifest,complete:false,reason:'request-input-limit' as const,returnedNodeCount:0,requestSchemaLimit:error.code};
        return {...value,manifestSha256:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
      }
      // Preserve developer text, schemas/enums and image structure. Base64 is
      // image transport, not text tokens; original dimensions bound its cost.
      const nonImageBody=JSON.stringify(body,(key,value)=>key==='image_url'&&typeof value==='string'&&value.startsWith('data:image/png;base64,')
        ?'data:image/png;base64,':value);
      const nonImageBodyUtf8Bytes=Buffer.byteLength(nonImageBody),inputTokenUpper=nonImageBodyUtf8Bytes+latest.manifest.imageInputTokenUpper+limits.framingTokens;
      const fits=Number.isSafeInteger(inputTokenUpper)&&inputTokenUpper<=limits.requestInputTokens;
      const {manifestSha256:_previous,...manifest}=latest.manifest;
      const value={...manifest,complete:fits,reason:fits?null:'request-input-limit' as const,returnedNodeCount:fits?manifest.sourceNodeCount:0,
        request:{nonImageBodyUtf8Bytes,imageInputTokenUpper:manifest.imageInputTokenUpper,inputTokenUpper,
          nonImageBodySha256:createHash('sha256').update(nonImageBody).digest('hex')}};
      return {...value,manifestSha256:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
    };
    const ready=requestManifest();
    if(!ready.complete)return {status:'unavailable' as const,reason:'request-input-limit' as const,manifest:ready};
    const result=await synthesizeDocumentAnswer(question,async()=>{
      const current=await this.readCompleteDocumentSource(owner,source);
      if(current.status!=='available'||current.manifest.manifestSha256!==initial.manifest.manifestSha256)
        throw new DocumentContextError('DOCUMENT_CONTEXT_CHANGED','Complete selected source changed before or during answer generation');
      latest=current;return current.context;
    },{...policy,...settings,timeoutMs:30000,beforeAttempt:async identity=>{
      const checked=requestManifest();
      if(!checked.complete||checked.manifestSha256!==ready.manifestSha256)
        throw new DocumentContextError('DOCUMENT_CONTEXT_CHANGED','Complete request changed before model reservation');
      await policy.beforeAttempt?.(identity);
    }});
    return {status:'available' as const,manifest:ready,result};
  }

  /** Explicit development diagnostics for a claim bound to a complete source.
   * The caller supplies selections, never trusted quotes or image bytes. */
  async auditSelectedStudySourceClaim(owner:string,question:string,expectedSource:DocumentContextSource,
    binding:DocumentCitationAuditBinding,policy:DocumentCitationAuditPolicy){
    await assertDocumentCitationAuditPolicy(policy);
    const source={...expectedSource},original=structuredClone(binding),initial=await this.readCompleteDocumentSource(owner,source);
    if(initial.status==='unavailable')return initial;
    let first=true;
    const result=await auditDocumentCitationClaim(question,async()=>{
      if(first){first=false;return initial.context;}
      const current=await this.readCompleteDocumentSource(owner,source);
      if(current.status!=='available'||current.manifest.manifestSha256!==initial.manifest.manifestSha256)
        throw new DocumentContextError('DOCUMENT_CONTEXT_CHANGED','Complete citation-audit source changed');
      return current.context;
    },original,policy);
    return {status:'available' as const,manifest:initial.manifest,result};
  }

  /** Explicit isolated development experiment; never called by normal answers.
   * Original claims and source reads stay bound throughout the three-call cap. */
  async reviseSelectedStudySourceCitation(owner:string,question:string,expectedSource:DocumentContextSource,
    binding:DocumentCitationRevisionBinding,policy:DocumentCitationRevisionPolicy){
    await assertDocumentCitationRevisionPolicy(policy);
    const source={...expectedSource},original=structuredClone(binding),initial=await this.readCompleteDocumentSource(owner,source);
    if(initial.status==='unavailable')return initial;
    let first=true;
    const result=await reviseDocumentCitationClaim(question,async()=>{
      if(first){first=false;return initial.context;}
      const current=await this.readCompleteDocumentSource(owner,source);
      if(current.status!=='available'||current.manifest.manifestSha256!==initial.manifest.manifestSha256)
        throw new DocumentContextError('DOCUMENT_CONTEXT_CHANGED','Complete citation-revision source changed');
      return current.context;
    },original,policy);
    return {status:'available' as const,manifest:initial.manifest,result};
  }

  /** Shared existing retrieval/current-source callback; the default answering
   * path keeps the same options, reads, order and provider payload. */
  private async studyAnswerContextReader(owner:string,question:string,
    options:DocumentSearchOptions&{includeParents?:boolean;includeImages?:boolean}={},nativeTables=true,identityCourseCodes?:string[]){
    const {includeParents=false,includeImages=false,...searchOptions}={...options,
      ...(options.routingScope===undefined?{}:{routingScope:normalizeDocumentRoutingScope(options.routingScope)})};
    const limit=searchOptions.limit??14;
    if(typeof includeParents!=='boolean'||typeof includeImages!=='boolean'||(includeImages&&!includeParents)||
      !Number.isInteger(limit)||limit<1||limit>14)throw new Error('Invalid study answer evidence options');
    const anchors=await this.searchDocumentText(owner,question,{...searchOptions,limit,evidenceBody:'full-page'});
    if(anchors.some(hit=>hit.retrieval_mode==='keyword-fallback'||hit.degraded_reason))
      throw new Error('Study answer retrieval was degraded; no answer was generated');
    const selected=searchOptions.sourceHint?requireResolvedDocumentSource(await this.resolveDocumentSource(owner,searchOptions.sourceHint,
      {courseId:searchOptions.courseId,routingScope:searchOptions.routingScope})):undefined;
    // A resolved document already fixes the source; requiring every question
    // word in a table caption/cell would discard its complementary original page.
    const tableCandidates=includeImages&&nativeTables?await this.searchNativeTableCandidates(owner,question,{courseId:searchOptions.courseId,
      documentId:selected?.documentId??searchOptions.documentId,routingScope:searchOptions.routingScope,strict:selected?false:searchOptions.strict}):[];
    return async()=>{
      const current=await readFullDocumentEvidence(kernelPool(),owner,anchors);
      if(searchOptions.sourceHint){
        const selected=requireResolvedDocumentSource(await this.resolveDocumentSource(owner,searchOptions.sourceHint,
          {courseId:searchOptions.courseId,routingScope:searchOptions.routingScope}));
        if(current.some(hit=>hit.document_id!==selected.documentId||hit.source_hash!==selected.sourceHash||
          hit.source_version_id!==selected.sourceVersionId||hit.id!==`pg:${selected.currentVersionId}:${hit.page_number}`)||
          tableCandidates.some(item=>item.source.documentId!==selected.documentId||item.source.currentVersionId!==selected.currentVersionId||
            item.source.sourceVersionId!==selected.sourceVersionId||item.source.sourceHash!==selected.sourceHash))
          throw new DocumentEvidenceChangedError();
      }
      const imageBudget=includeImages?createDocumentImageBudget():undefined;
      const context=includeParents?await readDocumentParents(kernelPool(),owner,current,{includeImages,...(identityCourseCodes?{identityCourseCodes}:{})},imageBudget):
        {anchors:current,parents:[],images:[],sourceContentIsUntrusted:true as const};
      if(!tableCandidates.length)return includeImages&&nativeTables&&selected?this.authorImageTableContext(owner,question,context,selected):context;
      const supplemental=await readNativeTableCandidateEvidence(kernelPool(),owner,tableCandidates,
        imageBudget?{budget:imageBudget,firstAnchorRank:current.length+1}:undefined);
      const supported=new Set([...context.anchors.map(hit=>hit.evidence_id),...context.parents.flatMap(parent=>parent.nodes.map(node=>node.evidenceId))]);
      const images=[...new Map([...context.images,...supplemental.images].map(image=>[image.attachmentId,image])).values()];
      const enriched={...context,imageAnchors:supplemental.imageAnchors.filter(node=>!supported.has(node.evidence_id)),
        images,...(imageBudget?{imageSelection:imageBudget.snapshot()}:{}),
        ...('accounting' in context?{accounting:{...context.accounting,imageCount:images.length,imageBytes:images.reduce((sum,image)=>sum+image.byteLength,0)}}:{})};
      return includeImages&&nativeTables&&selected?this.authorImageTableContext(owner,question,enriched,selected):enriched;
    };
  }

  /** One explicit title/source only. Original ranked anchors and other sources
   * stay intact; the existing PNG is still the sole selectable image evidence. */
  private async authorImageTableContext(owner:string,question:string,context:DocumentAnswerContext,source:DocumentContextSource):Promise<DocumentAnswerContext>{
    const nativeImages=context.images.filter(image=>image.tableObservations?.some(o=>o.version==='docling-native-observation-v1'));
    const candidates=(await this.searchAuthorImageTableCandidates(owner,question,source)).slice(0,Math.max(0,2-nativeImages.length));
    if(!candidates.length)return context;
    const budget=createDocumentImageBudget();
    for(const [index,image]of context.images.entries())if(!budget.include(image,index+1))throw new Error('Existing image budget changed');
    const extra=await readAuthorImageTableCandidateEvidence(kernelPool(),owner,candidates,{budget,firstAnchorRank:context.anchors.length+1});
    const images=[...new Map([...context.images,...extra.images].map(image=>[image.attachmentId,image])).values()];
    const supported=new Set([...context.anchors.map(n=>n.evidence_id),...context.parents.flatMap(p=>p.nodes.map(n=>n.evidenceId))]);
    const imageAnchors=[...new Map([...context.imageAnchors??[],...extra.imageAnchors].filter(n=>!supported.has(n.evidence_id)).map(n=>[n.evidence_id,n])).values()];
    if(imageAnchors.length>2)throw new Error('Shared supplemental image limit');
    return {...context,images,imageAnchors,imageSelection:{...budget.snapshot(),omitted:[...context.imageSelection?.omitted??[],...budget.snapshot().omitted]},
      ...('accounting' in context?{accounting:{...(context as {accounting:Record<string,unknown>}).accounting,
        imageCount:images.length,imageBytes:images.reduce((sum,i)=>sum+i.byteLength,0)}}:{})};
  }

  /** Non-structured study content only; canonical business facts use their own
   * Kernel queries. Retrieval and every source recheck remain inside Kernel. */
  async answerStudyContent(owner:string,question:string,
    options:DocumentSearchOptions&{includeParents?:boolean;includeImages?:boolean;retrievalQuestion?:string}={},policy:DocumentAnswerPolicy={}){
    await documentAnswerSettings(policy);
    const navigationEnabled=pdfNavigationProjectionEnabled();
    const {retrievalQuestion,...searchOptions}={...options,
      ...(options.routingScope===undefined?{}:{routingScope:normalizeDocumentRoutingScope(options.routingScope)})};
    if(retrievalQuestion!==undefined&&(typeof retrievalQuestion!=='string'||!retrievalQuestion.trim()||retrievalQuestion.length>12000))
      throw new Error('Invalid study retrieval question');
    let routedOptions=searchOptions,sourceRouting:Awaited<ReturnType<typeof planDocumentQueryScope>>|undefined;
    const explicitSourceSelection=searchOptions.routingScope?.documentIds!==undefined||(searchOptions.routingScope?.courseIds?.length??0)>1;
    if(policy.sourceRouting&&!searchOptions.sourceHint&&!searchOptions.documentId&&!explicitSourceSelection){
      const mentioned=await findMentionedDocumentSources(kernelPool(),owner,question,{courseId:searchOptions.courseId,routingScope:searchOptions.routingScope});
      if(mentioned.status==='resolved'){
        sourceRouting=await planDocumentQueryScope(question,mentioned.matches[0],policy,async()=>{
          const current=await findMentionedDocumentSources(kernelPool(),owner,question,{courseId:searchOptions.courseId,routingScope:searchOptions.routingScope});
          if(JSON.stringify(current)!==JSON.stringify(mentioned))throw new DocumentEvidenceChangedError();
        });
        if(sourceRouting.decision.scope==='named-document')routedOptions={...searchOptions,
          sourceHint:{selectedDocumentTitle:mentioned.matches[0].title},strict:true,relatedDocuments:false};
      }
    }
    if(sourceRouting)policy.onStage?.('retrieval');
    if(policy.sourceIdentityContext&&!searchOptions.includeParents)throw new Error('Source identity context requires the original parent reader');
    const identityCourseCodes=policy.sourceIdentityContext?[...new Set(observeLiteralCourseCodes(question).map(observation=>observation.code))]:undefined;
    const originalRankedRead=await this.studyAnswerContextReader(owner,retrievalQuestion??question,routedOptions,true,identityCourseCodes);
    let contentTagRouting:ReturnType<typeof contentTagAnswerObservation>;
    let classificationRouting:ReturnType<typeof classificationShadowAnswerObservation>|ReturnType<typeof classificationGuardAnswerObservation>;
    let sourceIdentityContext:DocumentAnswerContext['sourceIdentityContext'];
    const rankedRead=async()=>{
      const context=await originalRankedRead();
      contentTagRouting=contentTagAnswerObservation(context.anchors);
      classificationRouting=classificationGuardAnswerObservation(context.anchors)??classificationShadowAnswerObservation(context.anchors);
      sourceIdentityContext='sourceIdentityContext' in context?context.sourceIdentityContext:undefined;
      return context;
    };
    let contextExpansion:Record<string,unknown>={strategy:'ranked-evidence',coverage:'unassessed'};
    let read:()=>Promise<DocumentAnswerContext>=rankedRead;
    if(policy.scope==='application'&&searchOptions.includeParents&&searchOptions.includeImages){
      const mentioned=await findMentionedDocumentSources(kernelPool(),owner,question,{courseId:searchOptions.courseId,routingScope:searchOptions.routingScope});
      if(mentioned.status==='resolved'){
        const selected=mentioned.matches[0];
        const focusQuery=focusedDocumentTextQuery(question,selected.title),focusAllowed=focusQuery&&
          (!routedOptions.documentId||routedOptions.documentId===selected.documentId)&&
          (!routedOptions.sourceHint||routedOptions.sourceHint.selectedDocumentTitle===selected.title);
        let focusReader:ReturnType<KernelService['studyAnswerContextReader']>|undefined;
        read=async()=>{
          const ranked=await rankedRead(),current=await findMentionedDocumentSources(kernelPool(),owner,question,{courseId:searchOptions.courseId,routingScope:searchOptions.routingScope});
          if(current.status!=='resolved'||JSON.stringify(current.matches)!==JSON.stringify(mentioned.matches))throw new DocumentEvidenceChangedError();
          const base=await this.authorImageTableContext(owner,retrievalQuestion??question,ranked,selected);
          const complete=await this.readCompleteDocumentSource(owner,selected);
          const retainFocusedText=async(seed:DocumentAnswerContext=base):Promise<DocumentAnswerContext>=>{
            if(!focusAllowed)return seed;
            // Search once; every subsequent answer-stage read still verifies
            // current owner, source and page bodies through the Kernel reader.
            focusReader??=this.studyAnswerContextReader(owner,focusQuery!,{...routedOptions,documentId:selected.documentId,
              sourceHint:{selectedDocumentTitle:selected.title},limit:FOCUSED_TEXT_LIMITS.pages,strict:false,
              includeParents:false,includeImages:false,semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false},false);
            const focused=await (await focusReader)(),settings=await documentAnswerSettings(policy);
            let expanded=seed,bytes=0,inputUpper:number|undefined;
            const pages:FocusedDocumentText['pages']=[],omitted:Array<{evidenceId:string;reason:string}>=[];
            for(const hit of focused.anchors){
              if(hit.document_id!==selected.documentId||hit.source_hash!==selected.sourceHash||hit.source_version_id!==selected.sourceVersionId||
                hit.id!==`pg:${selected.currentVersionId}:${hit.page_number}`)throw new DocumentEvidenceChangedError();
              const size=Buffer.byteLength(hit.body),page={evidenceId:hit.evidence_id,bodySha256:createHash('sha256').update(hit.body).digest('hex')};
              if(bytes+size>FOCUSED_TEXT_LIMITS.bodyUtf8Bytes){omitted.push({evidenceId:hit.evidence_id,reason:'focused-text-byte-limit'});continue;}
              const merged=mergeStudyEvidence(expanded,{anchors:[hit],parents:[],images:[],sourceContentIsUntrusted:true});
              if(!merged){omitted.push({evidenceId:hit.evidence_id,reason:'existing-image-budget'});continue;}
              const candidate={...merged,focusedText:{policy:'bounded-mentioned-source-relevance-v1' as const,source:selected,
                querySha256:focusedTextQueryHash(focusQuery!),pages:[...pages,page],coverage:'unassessed' as const,structureRelationsVerified:false as const}};
              try{
                const request=buildDocumentAnswerRuntimeRequest(prepareDocumentAnswerForPolicy(question,candidate,policy),
                  {model:settings.model,reasoningEffort:settings.effort,maxOutputTokens:settings.maxOutput},policy);
                const upper=studyContextInputUpper(request,candidate);
                if(upper>COMPLETE_DOCUMENT_SOURCE_LIMITS.requestInputTokens){omitted.push({evidenceId:hit.evidence_id,reason:'combined-request-budget'});continue;}
                expanded=candidate;bytes+=size;pages.push(page);inputUpper=upper;
              }catch(error){if(!(error instanceof DocumentAnswerRequestLimitError))throw error;omitted.push({evidenceId:hit.evidence_id,reason:error.code});}
            }
            contextExpansion={...contextExpansion,...(pages.length&&seed===base?{strategy:'ranked-plus-focused-mentioned-text'}:{}),
              focusedText:{policy:'bounded-mentioned-source-relevance-v1',querySha256:focusedTextQueryHash(focusQuery!),
                admitted:pages,omitted,bodyUtf8Bytes:bytes,inputTokenUpper:inputUpper,otherSourcesRetained:true,coverage:'unassessed',structureRelationsVerified:false}};
            return expanded;
          };
          const retainText=async(visualReason:string):Promise<DocumentAnswerContext>=>{
            const text=await this.readCompleteDocumentText(owner,selected);
            contextExpansion={strategy:'ranked-evidence',coverage:'unassessed',selectedSource:selected,
              expansionUnavailable:visualReason,...(text.status==='unavailable'?{textExpansionUnavailable:text.reason}:{})};
            if(text.status==='unavailable')return retainFocusedText();
            const expanded=mergeStudyEvidence(base,text.context);
            if(!expanded)return retainFocusedText();
            const prepared=prepareDocumentAnswerForPolicy(question,expanded,policy),settings=await documentAnswerSettings(policy);
            let request;
            try{request=buildDocumentAnswerRuntimeRequest(prepared,{model:settings.model,reasoningEffort:settings.effort,maxOutputTokens:settings.maxOutput},policy);}catch(error){
              if(!(error instanceof DocumentAnswerRequestLimitError))throw error;
              contextExpansion={...contextExpansion,textExpansionUnavailable:error.code};return retainFocusedText();
            }
            const inputUpper=studyContextInputUpper(request,expanded);
            if(inputUpper>COMPLETE_DOCUMENT_SOURCE_LIMITS.requestInputTokens){
              contextExpansion={...contextExpansion,textExpansionUnavailable:'combined-request-budget'};return retainFocusedText();
            }
            contextExpansion={strategy:'ranked-plus-persisted-text-mentioned-source',coverage:'unassessed',selectedSource:selected,
              textScope:text.manifest.textCoverage,textNodes:text.manifest.returnedNodeCount,
              textSourceManifestSha256:text.manifest.manifestSha256,orderedTextSha256:text.manifest.orderedTextSha256,
              visualScope:'ranked-selected-only',exhaustiveVisualUnavailable:visualReason,
              originalFileCompletenessVerified:false,otherSourcesRetained:true,inputTokenUpper:inputUpper};
            return retainFocusedText(expanded);
          };
          if(complete.status==='unavailable'){
            if(complete.reason.startsWith('image-'))return retainText(complete.reason);
            contextExpansion={strategy:'ranked-evidence',coverage:'unassessed',selectedSource:selected,expansionUnavailable:complete.reason};return retainFocusedText();
          }
          // Validate the existing complete-source proof before merging; it does
          // not certify completeness of a multi-source question or the answer.
          prepareDocumentAnswer(question,{...complete.context,completeSourceProof:{policy:'selected-complete-initial-v1',selectedDocumentTitle:selected.title,manifest:complete.manifest}});
          const expanded=mergeStudyEvidence(base,complete.context);
          if(!expanded)return retainText('combined-image-budget');
          const prepared=prepareDocumentAnswerForPolicy(question,expanded,policy),settings=await documentAnswerSettings(policy);
          let request;
          try{request=buildDocumentAnswerRuntimeRequest(prepared,{model:settings.model,reasoningEffort:settings.effort,maxOutputTokens:settings.maxOutput},policy);}catch(error){
            if(!(error instanceof DocumentAnswerRequestLimitError))throw error;
            contextExpansion={strategy:'ranked-evidence',coverage:'unassessed',selectedSource:selected,expansionUnavailable:error.code};return retainText(error.code);
          }
          const inputUpper=studyContextInputUpper(request,expanded);
          if(inputUpper>COMPLETE_DOCUMENT_SOURCE_LIMITS.requestInputTokens){
            contextExpansion={strategy:'ranked-evidence',coverage:'unassessed',selectedSource:selected,expansionUnavailable:'combined-request-budget'};return retainText('combined-request-budget');
          }
          contextExpansion={strategy:'ranked-plus-complete-mentioned-source',coverage:'unassessed',selectedSource:selected,
            sourceManifestSha256:complete.manifest.manifestSha256,sourceNodes:complete.manifest.returnedNodeCount,
            sourceImages:complete.manifest.images.length,otherSourcesRetained:true,inputTokenUpper:inputUpper};
          // Complete input can still exceed selection's bounded text retention.
          // Carry the same validated focus through successful expansion too.
          return retainFocusedText(expanded);
        };
      }
    }
    if(policy.scope==='application'&&searchOptions.includeImages){
      const readOriginal=read;
      read=async()=>{const context=await readOriginal();return {...context,
        ...await readDocumentPageRegionsForImages(kernelPool(),owner,context.images)};};
    }
    if(policy.textContextWindows==='stored-page-v1'){
      const readOriginal=read;
      read=async()=>({...await readOriginal(),textQuotePolicy:'stored-page-v1' as const});
    }
    if(policy.textContextWindows==='producer-neighbors-v1'){
      const readOriginal=read,cache=new Map<string,Promise<PreparedDoclingTextContextWindows|null>>();
      read=async()=>{
        const context=await readOriginal(),textContextWindows:PreparedDoclingTextContextWindows[]=[];
        // Bound auxiliary CAS reads. The original context stays complete and
        // unchanged when a page has no usable producer observations.
        const anchors=context.anchors.slice(0,64),documents=new Map<string,OrigSearchPage[]>();
        for(const anchor of anchors){
          if(!anchor.parser_version.startsWith('docling-'))continue;
          if(!documents.has(anchor.document_id))documents.set(anchor.document_id,await origSearchPages(kernelPool(),owner,anchor.document_id));
          const row=documents.get(anchor.document_id)!.find(page=>page.page_number===anchor.page_number),
            version=/^pg:(.+):([0-9]+)$/.exec(anchor.id);
          if(!row||!version||row.current_version_id!==version[1]||row.source_version_id!==anchor.source_version_id||
            row.source_hash!==anchor.source_hash||row.evidence_id!==anchor.evidence_id||row.body!==anchor.body||
            row.parser_version!==anchor.parser_version)throw new DocumentEvidenceChangedError();
          const key=createHash('sha256').update(JSON.stringify([row.current_version_id,row.source_version_id,row.source_hash,
            row.evidence_id,row.body,row.parser_version,row.progress,row.layout?.resultReferences])).digest('hex');
          let pending=cache.get(key);
          if(!pending){
            pending=prepareDoclingTextContextWindows({...origSearchInput(owner,row),currentVersionId:row.current_version_id,
              sourceVersionId:row.source_version_id,evidenceId:row.evidence_id}).catch(error=>{
                if(error instanceof DoclingPageRegionError&&['unavailable','limit'].includes(error.code))return null;
                throw error;
              });
            cache.set(key,pending);
          }
          const hint=await pending;if(hint?.windows.length)textContextWindows.push(hint);
        }
        return {...context,...(textContextWindows.length?{textContextWindows}:{})};
      };
    }
    if(policy.textContextWindows==='producer-neighbors-v1'){
      const readOriginal=read,cache=new Map<string,Promise<PreparedNativeRegionWindows|null>>();
      read=async()=>{
        const context=await readOriginal(),nativeRegionWindows:PreparedNativeRegionWindows[]=[],documents=new Map<string,OrigSearchPage[]>();
        for(const anchor of context.anchors.slice(0,64)){
          if(anchor.parser_version!==NATIVE_REGION_TEXT_VERSION)continue;
          if(!documents.has(anchor.document_id))documents.set(anchor.document_id,await origSearchPages(kernelPool(),owner,anchor.document_id));
          const row=documents.get(anchor.document_id)!.find(p=>p.page_number===anchor.page_number),version=/^pg:(.+):([0-9]+)$/.exec(anchor.id);
          if(!row||!version||row.current_version_id!==version[1]||row.source_version_id!==anchor.source_version_id||row.source_hash!==anchor.source_hash||
            row.evidence_id!==anchor.evidence_id||row.body!==anchor.body||row.parser_version!==anchor.parser_version)throw new DocumentEvidenceChangedError();
          const key=createHash('sha256').update(JSON.stringify([row.current_version_id,row.evidence_id,row.body,nativeRegionFingerprint(row.progress)])).digest('hex');
          let pending=cache.get(key);
          if(!pending){pending=prepareNativeRegionWindows({...origSearchInput(owner,row),currentVersionId:row.current_version_id,
            sourceVersionId:row.source_version_id,evidenceId:row.evidence_id,bodySha256:createHash('sha256').update(row.body).digest('hex')});cache.set(key,pending);}
          const hint=await pending;if(hint)nativeRegionWindows.push(hint);
        }
        return {...context,...(nativeRegionWindows.length?{nativeRegionWindows}:{})};
      };
    }
    if(navigationEnabled&&policy.scope==='application'&&policy.evidenceSelection==='select-then-answer')
      read=withPdfNavigationContext(read,(source,page)=>this.readPdfNavigationTextContainers(owner,source,page));
    if(searchOptions.routingScope){
      const readOriginal=read;
      read=async()=>{
        const context=await readOriginal();
        await assertDocumentRoutingScope(kernelPool(),owner,[...context.anchors.map(hit=>hit.document_id),
          ...context.imageAnchors?.map(hit=>hit.document_id)??[],...context.parents.flatMap(parent=>parent.nodes.map(node=>node.documentId)),
          ...context.images.map(image=>image.source.documentId)],searchOptions);
        return context;
      };
    }
    const generated=await synthesizeDocumentAnswer(question,read,policy);
    const quantityCheck=policy.quantityConsistency?checkDocumentQuantityConsistency(question,generated.answer):undefined;
    const blocked=quantityCheck?.status==='explicit-incompatible-quantity';
    const result=quantityCheck?{...generated,answer:quantityCheck.answer,
      ...(blocked?{selectedUnits:[]}:{}),quantityConsistency:{...quantityCheck,
        ...(blocked?{originalSelectedUnits:generated.selectedUnits}:{}),inputFingerprint:generated.inputFingerprint}}:generated;
    if('pdfPageRegionTransport'in result&&result.pdfPageRegionTransport)
      contextExpansion={...contextExpansion,pdfPageRegions:result.pdfPageRegionTransport};
    let citationCheck:Omit<Awaited<ReturnType<typeof checkApplicationDocumentCitations>>,'released'>|undefined,
      releasedAnswer:Awaited<ReturnType<typeof checkApplicationDocumentCitations>>['released'];
    const auditSelections='scopeAnnotatedSelections' in result&&result.scopeAnnotatedSelections?result.scopeAnnotatedSelections:
      'sourceQuantityDerivation' in result&&result.sourceQuantityDerivation?result.sourceQuantityDerivation.normalizedSelections:
      'sourceValueDerivation' in result?result.sourceValueDerivation?.normalizedSelections??result.providerSelections:result.providerSelections;
    if(result.answer.claims.length&&policy.citationCheck&&auditSelections?.claims.length){
      policy.onStage?.('citation-validation');
      const {released,...checked}=await checkApplicationDocumentCitations(question,read,{inputFingerprint:result.inputFingerprint,
        quoteUnitManifestSha256:result.quoteUnitManifestSha256,providerSelections:auditSelections,
        ...('evidenceSelection' in result&&result.evidenceSelection?.unitPolicy?{unitPolicy:result.evidenceSelection.unitPolicy}:{})},policy);
      citationCheck=checked;
      if(released){
        if(JSON.stringify(result.answer.claims.map(c=>c.text))!==JSON.stringify(released.answer.claims.map(c=>c.text)))
          throw new Error('Citation release changed answer text');
        // Provider selections/raw responses remain the original generation;
        // only the restored displayed citations and their unit indices change.
        releasedAnswer=released;
      }
    }
    return {...result,...(releasedAnswer?{answer:releasedAnswer.answer,selectedUnits:releasedAnswer.selectedUnits}:{}),
      contextExpansion,...(sourceRouting?{sourceRouting}:{}),...(citationCheck?{citationCheck}:{}),
      ...(contentTagRouting?{contentTagRouting}:{}),...(classificationRouting?{classificationRouting}:{}),...(sourceIdentityContext?{sourceIdentityContext}:{})};
  }

  /** Explicit administrator development lane. A title may occur in query text;
   * callers cannot secretly replace library retrieval with a document filter. */
  async planStudyAnswer(owner:string,question:string,options:{courseId?:string},policy:StudyAnswerPlanPolicy){
    await assertStudyAnswerPlanPolicy(policy);
    if(!options||Object.keys(options).some(key=>key!=='courseId')||
      (options.courseId!==undefined&&(typeof options.courseId!=='string'||!options.courseId.trim())))
      throw new Error('Study planning allows only explicit user course context, not document/source filters');
    const read=await this.studyAnswerContextReader(owner,question,{...options,limit:14,semantic:false,hybrid:false,aiRerank:false,
      relatedDocuments:true,includeParents:true,includeImages:true});
    return planRetrievedStudyAnswer(question,read,policy);
  }

  /** Explicit phases, never an automatic chain. The question-only contract is
   * fallible and cannot certify coverage; the original plan entry stays intact. */
  createStudyQuestionContract(question:string,policy:StudyAnswerPlanPolicy){
    return createStudyQuestionContract(question,policy);
  }

  private async contractStudyContext(owner:string,question:string,options:{courseId?:string},policy:StudyAnswerPlanPolicy){
    await assertStudyAnswerPlanPolicy(policy);
    if(!options||Object.keys(options).some(key=>key!=='courseId')||
      (options.courseId!==undefined&&(typeof options.courseId!=='string'||!options.courseId.trim())))
      throw new Error('Study planning allows only explicit user course context, not document/source filters');
    return this.studyAnswerContextReader(owner,question,{...options,limit:14,semantic:false,hybrid:false,aiRerank:false,
      relatedDocuments:true,includeParents:true,includeImages:true});
  }

  async planStudyAnswerWithContract(owner:string,question:string,contract:StudyQuestionContract,options:{courseId?:string},policy:StudyAnswerPlanPolicy){
    return planContractStudyAnswer(question,await this.contractStudyContext(owner,question,options,policy),contract,policy);
  }

  async verifyStudyAnswerPlanCluster(owner:string,question:string,contract:StudyQuestionContract,binding:StudyContractPlanBinding,
    clusterId:string,options:{courseId?:string},policy:StudyAnswerPlanPolicy){
    return verifyStudyAnswerCluster(question,await this.contractStudyContext(owner,question,options,policy),contract,binding,clusterId,policy);
  }

  /** An exact user-selected title may license bounded complete-source initial
   * evidence. It never removes any requirement from the original question. */
  private plannedStudyScope(question:string,options:{courseId?:string;sourceHint?:DocumentSourceHint}){
    const scope=structuredClone(options);
    if(!scope||typeof scope!=='object'||Array.isArray(scope)||Object.keys(scope).some(key=>!['courseId','sourceHint'].includes(key))||
      (scope.courseId!==undefined&&(typeof scope.courseId!=='string'||!scope.courseId.trim())))
      throw new Error('Planned answers allow user course/title context, not document filters');
    const {sourceHint}=scope;
    if(sourceHint!==undefined&&(!sourceHint||Object.keys(sourceHint).length!==1||typeof sourceHint.selectedDocumentTitle!=='string'||
      !sourceHint.selectedDocumentTitle.trim()||sourceHint.selectedDocumentTitle.length>4000||!documentTitleMention(question,sourceHint.selectedDocumentTitle)))
      throw new Error('A supplemental source hint must be a complete user title present in the original question');
    return scope;
  }

  /** One explicit development entry for the real question-contract → planned
   * answer chain. It establishes no canonical deadlines/tasks/business state. */
  async answerLearningContent(owner:string,question:string,options:{courseId?:string;sourceHint?:DocumentSourceHint},policy:PlannedStudyAnswerPolicy){
    const scope=this.plannedStudyScope(question,options);await assertPlannedStudyAnswerPolicy(policy);
    const {sourceHint,courseId}=scope,selected=sourceHint?await this.resolveDocumentSource(owner,sourceHint,{courseId}):undefined;
    if(selected)requireResolvedDocumentSource(selected);
    const recheck=async()=>{
      if(sourceHint&&JSON.stringify(await this.resolveDocumentSource(owner,sourceHint,{courseId}))!==JSON.stringify(selected))
        throw new DocumentEvidenceChangedError();
    },boundPolicy:PlannedStudyAnswerPolicy={...policy,beforeAttempt:async attempt=>{await recheck();await policy.beforeAttempt(attempt);}},
      questionContract=await this.createStudyQuestionContract(question,{scope:policy.scope,dailyLimit:policy.dailyLimit,
        beforeAttempt:boundPolicy.beforeAttempt,recordResponse:raw=>policy.recordResponse({...raw,phase:'question-contract'})});
    await policy.recordState({event:'question-contract',result:questionContract});await recheck();
    return {questionContract,...await this.answerPlannedStudyContent(owner,question,questionContract.contract,scope,boundPolicy)};
  }

  private async resolvedTitleCaptionContext(owner:string,context:DocumentAnswerContext,
    selected:Extract<DocumentSourceResolution,{status:'resolved'}>,policy:PlannedStudyAnswerPolicy):Promise<DocumentAnswerContext>{
    const outline=await this.readDocumentOutline(owner,selected.document),captions=outline.nodes.filter(n=>n.kind==='caption').sort((a,b)=>a.ordinal-b.ordinal),
      proof={policy:'resolved-title-caption-images-v1' as const,selectedDocumentTitle:selected.selectedDocumentTitle,source:outline.source,
        manifestSha256:outline.manifestSha256,totalCaptions:captions.length,captions:captions.map(n=>({evidenceId:n.evidenceId,ordinal:n.ordinal}))};
    if(captions.length>14){
      await policy.recordState({event:'source-caption-context',status:'capacity-exceeded',reason:'caption-count-limit',limit:14,proof});
      throw new DocumentContextError('DOCUMENT_CONTEXT_INVALID','Resolved title caption capacity exceeded; no caption subset was selected');
    }
    const budget=createDocumentImageBudget();for(const [i,image]of context.images.entries())if(!budget.include(image,i+1))
      throw new DocumentContextError('DOCUMENT_CONTEXT_INVALID','Original images exceeded the shared budget');
    const anchors=captions.length?await this.readDocumentNodes(owner,outline.source,captions.map(n=>n.evidenceId)):[],
      added=anchors.length?await this.readDocumentParents(owner,anchors,{includeImages:true},budget):null;
    if(added?.parents.some(p=>p.status!=='available')){
      await policy.recordState({event:'source-caption-context',status:'capacity-exceeded',reason:'caption-parent-size',proof,parents:added.parents});
      throw new DocumentContextError('DOCUMENT_CONTEXT_INVALID','Resolved title caption parent context exceeds its reader limit');
    }
    const parents=new Map(context.parents.map(p=>[p.parentId,p]));
    for(const parent of added?.parents??[]){const old=parents.get(parent.parentId);
      if(old&&JSON.stringify([old.status,old.nodes])!==JSON.stringify([parent.status,parent.nodes]))throw new DocumentEvidenceChangedError();
      if(!old)parents.set(parent.parentId,parent);
    }
    const images=[...new Map([...context.images,...added?.images??[]].map(image=>[image.attachmentId,image])).values()],selection=budget.snapshot(),
      imageAnchors=[...new Map([...context.imageAnchors??[],...anchors].map(a=>[a.evidence_id,a])).values()],
      imageSelection={...selection,omitted:[...context.imageSelection?.omitted??[],...selection.omitted]};
    const current=await this.readDocumentOutline(owner,selected.document);
    if(current.manifestSha256!==outline.manifestSha256||JSON.stringify(current.source)!==JSON.stringify(outline.source))throw new DocumentEvidenceChangedError();
    await policy.recordState({event:'source-caption-context',status:'read',proof,imageSelection});
    return {...context,parents:[...parents.values()],images,imageAnchors,imageSelection,sourceCaptionProof:proof};
  }

  async answerPlannedStudyContent(owner:string,question:string,contract:StudyQuestionContract,options:{courseId?:string;sourceHint?:DocumentSourceHint},policy:PlannedStudyAnswerPolicy){
    const {sourceHint,...courseContext}=this.plannedStudyScope(question,options);
    await assertPlannedStudyAnswerPolicy(policy);
    const selected=sourceHint?await this.resolveDocumentSource(owner,sourceHint,{courseId:courseContext.courseId}):undefined;
    if(selected)requireResolvedDocumentSource(selected);
    const recheckSelection=async()=>{
      if(sourceHint&&JSON.stringify(await this.resolveDocumentSource(owner,sourceHint,{courseId:courseContext.courseId}))!==JSON.stringify(selected))
        throw new DocumentEvidenceChangedError();
    };
    let initialEvidence:Record<string,unknown>={strategy:'whole-library-query',reason:'no-explicit-selected-source',selectedSourceInputCoverage:'unassessed',questionCoverage:'unassessed'};
    let crossSource=false;
    if(selected?.status==='resolved'){
      const others=await this.mentionedOtherDocumentSources(owner,question,selected.document.documentId);crossSource=others.length>0;
      if(crossSource)initialEvidence={...initialEvidence,reason:'other-current-title-mentioned',selectedSource:selected,otherTitleExamples:others};
      else{
        // The reader checks small PG node/body/image metadata before loading
        // original bytes. No ranked result cap or global image limit changes.
        const complete=await this.readCompleteDocumentSource(owner,selected.document);
        initialEvidence={...initialEvidence,reason:complete.status==='unavailable'?complete.reason:null,selectedSource:selected,manifest:complete.manifest};
        if(complete.status==='available'){
          const proof={policy:'selected-complete-initial-v1' as const,selectedDocumentTitle:selected.selectedDocumentTitle,manifest:complete.manifest},
            initial={...complete.context,completeSourceProof:proof};
          let evidenceRoute:ReturnType<typeof prepareCompleteStudyEvidenceRoute>|undefined;
          try{
            evidenceRoute=prepareCompleteStudyEvidenceRoute(question,initial,contract);
            const packet=preparePlannedStudyGeneration(question,initial,[],contract,evidenceRoute.binding,[],undefined,policy.sourceLabelPolicy),transport=preparePlannedStudyGenerationTransport(packet);
            studyAnswerPlanRequestBudget(transport.request,{prepared:packet.selectedPrepared});
          }catch(error){if(!isStudyRequestCapacityError(error))throw error;
            initialEvidence={...initialEvidence,reason:'request-capacity',capacityReason:(error as Error).message};
          }
          if(initialEvidence.reason===null){
            initialEvidence={...initialEvidence,strategy:'selected-complete-source',selectedSourceInputCoverage:'complete'};
            await policy.recordState({event:'initial-source-evidence',...initialEvidence});
            const read=async():Promise<DocumentAnswerContext>=>{
              await recheckSelection();
              if((await this.mentionedOtherDocumentSources(owner,question,selected.document.documentId)).length)throw new DocumentEvidenceChangedError();
              const current=await this.readCompleteDocumentSource(owner,selected.document);
              if(current.status!=='available'||current.manifest.manifestSha256!==complete.manifest.manifestSha256)throw new DocumentEvidenceChangedError();
              return {...current.context,completeSourceProof:{...proof,manifest:current.manifest}};
            };
            try{return {...await answerPlannedStudyQuestion(question,read,async()=>{throw Error('Complete source does not execute supplemental queries');},contract,policy,selected,evidenceRoute!.binding),initialEvidence};}
            catch(error){if(!isStudyRequestCapacityError(error))throw error;
              const capacity={status:'capacity-exceeded' as const,initialEvidence,reason:(error as Error).message,wholeAnswerVerified:false as const};
              await policy.recordState({event:'initial-source-capacity',...capacity});return capacity;
            }
          }
        }
      }
    }
    await policy.recordState({event:'initial-source-evidence',...initialEvidence});
    const readInitial=await this.contractStudyContext(owner,question,courseContext,{scope:policy.scope,dailyLimit:policy.dailyLimit,
      beforeAttempt:policy.beforeAttempt,recordResponse:raw=>policy.recordResponse({...raw,phase:'contract-plan'})});
    const read=async()=>{
      await recheckSelection();const context=await readInitial();return selected?.status==='resolved'?this.resolvedTitleCaptionContext(owner,context,selected,policy):context;
    };
    return {...await answerPlannedStudyQuestion(question,read,async query=>{
      const supplement=await this.studyAnswerContextReader(owner,query,{...courseContext,...(sourceHint&&!crossSource?{sourceHint}:{}),limit:4,
        semantic:false,hybrid:false,aiRerank:false,relatedDocuments:true,includeParents:true,includeImages:true},false);
      return async()=>{
        const context=await supplement();
        if(sourceHint&&JSON.stringify(await this.resolveDocumentSource(owner,sourceHint,{courseId:courseContext.courseId}))!==JSON.stringify(selected))
          throw new DocumentEvidenceChangedError();
        return context;
      };
    },contract,policy,!crossSource&&selected?.status==='resolved'?selected:undefined),initialEvidence};
  }

  searchDocumentText(owner:string,query:string,options:DocumentSearchOptions={}) {
    return searchDocumentText(kernelPool(),owner,query,options);
  }

  documentMetadataTags(owner:string,documentId:string){
    return readContentMetadataTags(kernelPool(),owner,documentId);
  }

  recordDocumentClassification(owner:string,input:unknown,actor:string,reason:string){
    return kernelTransaction(client=>recordContentClassification(client,owner,input,actor,reason));
  }

  documentClassifications(owner:string,documentId:string){
    return readContentClassifications(kernelPool(),owner,documentId);
  }

  prepareDocumentTopics(owner:string,documentId:string,pages?:number[]){
    return prepareControlledTopics(kernelPool(),owner,documentId,pages);
  }

  contentTaxonomy(owner:string){return readContentTaxonomy(kernelPool(),owner);}

  recordContentTaxonomy(owner:string,input:unknown,actor:string,reason:string){
    return kernelTransaction(client=>recordContentTaxonomy(client,owner,input,actor,reason));
  }

  importDocumentTopics(owner:string,packet:unknown,rawResponse:string,actor:string,reason:string){
    return kernelTransaction(client=>importControlledTopics(client,owner,packet,rawResponse,actor,reason));
  }

  runDocumentTopicJob(job:IngestionJob){return runDocumentTopicJob(job);}

  documentRoutingCounts(owner:string,scope:{courseId?:string;documentId?:string;routingScope?:DocumentRoutingScope}={}){
    return documentRoutingScopeCounts(kernelPool(),owner,scope);
  }

  hasUnmappedCourseDocuments(owner:string,courseIds:readonly string[]){
    return hasUnmappedCourseDocuments(kernelPool(),owner,courseIds);
  }

  queueDocumentVectorJobs(owner:string,scope:DocumentVectorScope={}) {
    return queueDocumentVectorJobs(kernelPool(),owner,scope);
  }

  documentVectorCoverage(owner:string,scope:DocumentVectorScope={}) {
    return documentVectorCoverage(kernelPool(),owner,scope);
  }

  runDocumentVectorJob(job:IngestionJob) {
    return runDocumentVectorJob(kernelPool(),job);
  }

  async documentTextHeads(owner:string){
    return (await kernelPool().query<{id:string;source_hash:string}>(
      'SELECT id,source_hash FROM document_texts WHERE owner_id=$1 AND hidden=false AND current_version_id IS NOT NULL',[owner])).rows;
  }

  async parsedDocument(owner:string,id:string) {
    const rows=(await kernelPool().query<{page_number:number;locator:string;body:string;parser_version:string;warnings:string[];extraction_method:string}>(`
      SELECT p.page_number,p.locator,p.body,p.content_kind,p.start_ms,p.end_ms,v.parser_version,v.warnings,s.raw_value->>'extractionMethod' extraction_method FROM document_texts d
      JOIN document_text_versions v ON v.id=d.current_version_id
      JOIN source_item_versions s ON s.id=v.source_version_id
      JOIN document_text_pages p ON p.version_id=v.id
      WHERE d.owner_id=$1 AND d.id=$2 AND d.hidden=false ORDER BY p.page_number`,[owner,id])).rows;
    return rows;
  }

  async hideParsedDocument(owner:string,id:string) {
    await kernelPool().query('UPDATE document_texts SET hidden=true WHERE owner_id=$1 AND id=$2',[owner,id]);
  }

  async rebuildDocumentSearch(owner:string,id:string) {
    const snapshot=await origSearchPages(kernelPool(),owner,id);
    const staged:Array<PreparedDoclingOrigSearchHints|null>=[];
    for(const page of snapshot)staged.push(page.mime==='application/pdf'?await prepareDoclingOrigSearchHints(origSearchInput(owner,page)):null);
    const projections=snapshot.map((page,index)=>{
      if(staged[index])assertPreparedDoclingOrigSearchHints(staged[index]!,origSearchInput(owner,page));
      return projectDocumentOrigSearch(page.body,page.search_text,page.search_hint_provenance,staged[index],origSearchBinding(owner,page));
    });
    return kernelTransaction(async client=>{
      const pages=await origSearchPages(client,owner,id,undefined,true),version=pages[0].current_version_id;
      if(doclingOrigSearchHash(pages)!==doclingOrigSearchHash(snapshot))throw new DocumentEvidenceChangedError();
      await client.query('DELETE FROM document_text_chunks WHERE version_id=$1',[version]);
      let position=0;
      for(const [index,page] of pages.entries()){
       const projected=projections[index];
       await client.query('UPDATE document_text_pages SET search_text=$3,search_hint_provenance=$4::jsonb WHERE version_id=$1 AND page_number=$2',
        [version,page.page_number,projected.searchText,projected.provenance?JSON.stringify(projected.provenance):null]);
       for(const body of splitDocumentText(page.body)){
        await client.query(`INSERT INTO document_text_chunks(id,version_id,page_number,position,body,search_text)
          VALUES ($1,$2,$3,$4,$5,$6)`,[stableId(version,String(position)),version,page.page_number,position,body,documentSearchText(body)]);
        position++;
       }
      }
      return {documentId:id,chunks:position};
    });
  }

  async refreshDocumentOrigSearchHints(owner:string,source:DocumentContextSource,physicalPage:number){
    if(!Number.isInteger(physicalPage)||physicalPage<1)throw Error('One explicit physical page is required');
    const snapshot=(await origSearchPages(kernelPool(),owner,source.documentId,physicalPage))[0];assertOrigSearchSource(snapshot,source);
    if(snapshot.mime!=='application/pdf')throw Error('Orig search hints require a current PDF source');
    const input=origSearchInput(owner,snapshot),prepared=await prepareDoclingOrigSearchHints(input);
    if(!prepared)throw Error('Registered orig result unavailable; index preserved');
    assertPreparedDoclingOrigSearchHints(prepared,input);
    const projection=projectDocumentOrigSearch(snapshot.body,snapshot.search_text,snapshot.search_hint_provenance,prepared,origSearchBinding(owner,snapshot));
    return kernelTransaction(async client=>{
      const current=(await origSearchPages(client,owner,source.documentId,physicalPage,true))[0];assertOrigSearchSource(current,source);
      if(doclingOrigSearchHash(current)!==doclingOrigSearchHash(snapshot))throw new DocumentEvidenceChangedError();
      const unchanged=current.search_text===projection.searchText&&doclingOrigSearchHash(current.search_hint_provenance)===doclingOrigSearchHash(projection.provenance);
      if(!unchanged)await client.query('UPDATE document_text_pages SET search_text=$3,search_hint_provenance=$4::jsonb WHERE version_id=$1 AND page_number=$2',
        [current.current_version_id,physicalPage,projection.searchText,projection.provenance?JSON.stringify(projection.provenance):null]);
      return {status:unchanged?'unchanged' as const:'updated' as const,source:{...source},physicalPage,
        provenanceSha256:projection.provenance?.provenanceSha256??null,authority:'unverified-retrieval-hint' as const};
    });
  }

  async ingestMailAnalysis(mail: {id:string;account:string;sender:string;subject:string;body:string;
    receivedAt:string;hash:string}, analysis: {deadlines:MailDeadlineInput[];
      referencedUrls?:string[];actionItems?:Array<{title:string;description:string;evidence:string;confidence:number}>}) {
    const acquiredAt=new Date().toISOString(),sourceItemId=`gmail:${mail.account}:${mail.id}`;
    const deadlineSources=analysis.deadlines.map(claim=>mailDeadlineSource(mail.body,claim));
    const contentHash=stableId('mail-deadline-source-timezone-v1',mail.hash,stableId(mail.body),JSON.stringify(deadlineSources));
    await kernelTransaction(async client=>{
      const version=await sourceVersion(client,{id:sourceItemId,source:'gmail',scope:mail.account,
        externalId:mail.id,contentHash,raw:{subject:mail.subject,sender:mail.sender,
          receivedAt:mail.receivedAt,bodyHash:stableId(mail.body),originalMailHash:mail.hash,deadlineSources},rawUri:`sqlite-mail://${mail.account}/${mail.id}`,
        rawSha256:mail.hash,acquiredAt,publishedAt:mail.receivedAt});
      const urls=analysis.referencedUrls||[];
      let matchedTask:{entity_id:string}|undefined;
      if(urls.length){
        const matches=(await client.query<{entity_id:string}>(
          'SELECT entity_id FROM tasks WHERE source_url=ANY($1::text[]) LIMIT 2',[urls])).rows;
        if(matches.length===1)matchedTask=matches[0];
      }
      for(const [index,claim] of deadlineSources.entries()){
        if(!claim.at)continue;
        const entityId=matchedTask?.entity_id||stableId('mail_claim',sourceItemId,String(index));
        if(!matchedTask)await entity(client,entityId,'mail_claim',`${sourceItemId}:${index}`,null,null);
        const due=claim.due;
        await recordCandidate(client,{entityId,attribute:'due',value:due,sourceVersionId:version,
          source:'gmail',sourceItemId,originalExcerpt:claim.excerpt,
          confidence:Math.max(0,Math.min(1,claim.confidence)),authority:'ai',locator:`deadline:${index}`,
          acquiredAt,publishedAt:mail.receivedAt});
      }
      if(matchedTask){
        for(const [index,claim] of (analysis.actionItems||[]).entries()){
          const statement=`${claim.title} ${claim.description}`;
          if(!/\b(cancelled|canceled|no longer required)\b|取消|不再需要/i.test(statement))continue;
          await recordCandidate(client,{entityId:matchedTask.entity_id,attribute:'cancelled',value:true,
            sourceVersionId:version,source:'gmail',sourceItemId,
            originalExcerpt:(claim.evidence||statement).slice(0,4000),confidence:Math.max(0,Math.min(1,claim.confidence)),
            authority:'ai',locator:`cancellation:${index}`,acquiredAt,publishedAt:mail.receivedAt});
        }
      }
    });
  }

  async completeSourceScan(source: string, scope: string, seenIds: string[],
    cursor: string | null = null, scanStartedAt = new Date().toISOString()): Promise<number> {
    return kernelTransaction(async client => {
      const current=await client.query<{id:string}>(
        `SELECT id FROM source_items WHERE source=$1 AND scope=$2 AND state='active'
         AND last_seen_at<$3 AND ($1<>'canvas' OR split_part(external_id,':',1) NOT IN ('announcement','planner'))
         FOR UPDATE`,[source,scope,scanStartedAt]);
      const seen=new Set(seenIds);
      const missing=current.rows.filter(row=>!seen.has(row.id));
      for (const item of missing) {
        await client.query(`UPDATE source_items SET state='missing',missing_at=now() WHERE id=$1`,[item.id]);
        await client.query(`UPDATE tasks SET source_missing=true,updated_at=now() WHERE source_item_id=$1`,[item.id]);
      }
      await client.query(
        `INSERT INTO source_status(source,scope,cursor_value,last_completed_at,state) VALUES ($1,$2,$3,now(),'idle')
         ON CONFLICT(source,scope) DO UPDATE SET cursor_value=excluded.cursor_value,
         last_completed_at=excluded.last_completed_at,last_error=NULL,state='idle'`,[source,scope,cursor]);
      return missing.length;
    });
  }

  async noteSourceFailure(source:string,scope:string,error:string):Promise<void>{
    await kernelPool().query(
      `INSERT INTO source_status(source,scope,state,last_error) VALUES ($1,$2,'error',$3)
       ON CONFLICT(source,scope) DO UPDATE SET state='error',last_error=excluded.last_error`,
      [source,scope,error.slice(0,500)]);
  }

  async listCourses() {
    const result=await kernelPool().query(
      `SELECT c.id,c.code,c.name,c.enabled,c.synced_at,t.name term_name,c.starts_at start_at,c.ends_at end_at
       FROM courses c LEFT JOIN academic_terms t ON t.id=c.term_id ORDER BY c.code`);
    return result.rows.map(row=>({...row,synced_at:iso(row.synced_at),start_at:iso(row.start_at),end_at:iso(row.end_at)}));
  }

  async getCourse(idOrCode: string) {
    const result=await kernelPool().query(
      `SELECT c.id,c.code,c.name,c.enabled,c.synced_at,c.starts_at start_at,t.name term_name FROM courses c
       LEFT JOIN academic_terms t ON t.id=c.term_id WHERE c.id=$1 OR c.code=$1 LIMIT 1`,[idOrCode]);
    const row=result.rows[0];return row?{...row,synced_at:iso(row.synced_at),start_at:iso(row.start_at)}:null;
  }

  async setCourseEnabled(id: string, enabled: boolean) {
    await kernelTransaction(async client=>{
      const course=(await client.query<{term_id:string|null}>(
        'SELECT term_id FROM courses WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!course)throw new Error('Course not found');
      const acquiredAt=new Date().toISOString(),sourceId=`manual:course-enabled:${id}`;
      const version=await sourceVersion(client,{id:sourceId,source:'manual',scope:'local-owner',externalId:id,
        courseId:id,contentHash:stableId(String(enabled),acquiredAt),raw:{courseId:id,enabled},acquiredAt});
      const entityId=stableId('course',id);
      const candidateId=await recordCandidate(client,{entityId,attribute:'enabled',value:enabled,
        sourceVersionId:version,source:'manual',sourceItemId:sourceId,
        originalExcerpt:`Course ${id} enabled=${enabled}`,confidence:1,authority:'manual',locator:'enabled',acquiredAt});
      const candidate=(await client.query<{status:string}>('SELECT status FROM candidate_facts WHERE id=$1',[candidateId])).rows[0];
      if(candidate?.status==='pending')await acceptCandidate(client,candidateId,'user course setting');
      await client.query('UPDATE courses SET enabled=$2,updated_at=now() WHERE id=$1',[id,enabled]);
    });
  }

  async markCourseSynced(id: string) {
    await kernelPool().query('UPDATE courses SET synced_at=now() WHERE id=$1',[id]);
  }

  async sourceCursor(source:string,scope:string):Promise<Record<string,unknown>|null>{
    const row=(await kernelPool().query<{cursor_value:string|null}>(
      'SELECT cursor_value FROM source_status WHERE source=$1 AND scope=$2',[source,scope])).rows[0];
    return row?.cursor_value?JSON.parse(row.cursor_value) as Record<string,unknown>:null;
  }

  async taskRows(courseId?: string, includeIgnored=false) {
    const result=await kernelPool().query(
      `SELECT t.*,c.code course_code,c.name course_name,'complete' analysis_status
       FROM tasks t JOIN courses c ON c.id=t.course_id JOIN entities en ON en.id=t.entity_id
       WHERE c.enabled=true AND en.merged_into IS NULL AND ($2::boolean OR t.local_status!='ignored')
       AND ($1::text IS NULL OR t.course_id=$1)
       ORDER BY t.due_at NULLS LAST,t.due_date NULLS LAST`,[courseId ?? null,includeIgnored]);
    return result.rows.map(row=>({ ...row,requirements_json:JSON.stringify(row.requirements),
      evidence:row.evidence_excerpt,local_status:row.local_status,points_possible:row.points_possible==null?null:Number(row.points_possible),
      prerequisite_blocked:Number(row.prerequisite_blocked),start_at:iso(row.start_at),due_date:dateOnly(row.due_date),
      due_at:iso(row.due_at)??dateOnly(row.due_date),
      unlock_at:iso(row.unlock_at),lock_at:iso(row.lock_at),updated_at:iso(row.updated_at) }));
  }

  async taskTarget(taskId: string) {
    return (await kernelPool().query<{source_type:string;source_id:string}>(
      `SELECT source_type,source_id FROM tasks WHERE id=COALESCE(
        (SELECT target_task_id FROM task_entity_merges WHERE source_task_id=$1 AND rolled_back_at IS NULL),$1)`,
      [taskId])).rows[0] ?? null;
  }

  async setTaskStatus(taskId: string, status: 'active'|'completed'|'ignored', syncCanvas=false) {
    await kernelTransaction(async client => {
      const task=(await client.query<{entity_id:string;source_item_id:string}>(
        `SELECT entity_id,source_item_id FROM tasks WHERE id=COALESCE(
          (SELECT target_task_id FROM task_entity_merges WHERE source_task_id=$1 AND rolled_back_at IS NULL),$1)
          FOR UPDATE`,[taskId])).rows[0];
      if (!task) throw new Error('Task not found');
      const raw={taskId,status};const acquiredAt=new Date().toISOString();
      const sourceId=`manual:status:${taskId}`;
      const version=await sourceVersion(client,{id:sourceId,source:'manual',scope:'local-owner',externalId:taskId,
        contentHash:stableId(JSON.stringify(raw),acquiredAt),raw,acquiredAt});
      await recordCandidate(client,{entityId:task.entity_id,attribute:'local_status',value:status,
        sourceVersionId:version,source:'manual',sourceItemId:sourceId,originalExcerpt:JSON.stringify(raw),
        confidence:1,authority:'manual',locator:'local_status',acquiredAt,publishedAt:acquiredAt});
      // A user status change is authoritative over the prior local status.
      const candidate=(await client.query<{id:string;status:string}>(
        `SELECT id,status FROM candidate_facts WHERE entity_id=$1 AND attribute='local_status' AND evidence_id=
         (SELECT id FROM evidence WHERE source_version_id=$2 AND locator='local_status')`,[task.entity_id,version])).rows[0];
      if (candidate?.status==='pending') await acceptCandidate(client,candidate.id,'user action');
      const activeTaskId=(await client.query<{id:string}>(
        'SELECT id FROM tasks WHERE entity_id=$1',[task.entity_id])).rows[0].id;
      await client.query('UPDATE tasks SET local_status=$2,updated_at=now() WHERE id=$1',[activeTaskId,status]);
      if(syncCanvas && status!=='ignored')await client.query(
        `INSERT INTO kernel_outbox(id,kind,payload,idempotency_key) VALUES ($1,'canvas_task_status',$2,$3)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [randomUUID(),JSON.stringify({taskId:activeTaskId,status}),`canvas_task_status:${activeTaskId}:${status}:${acquiredAt}`]);
    });
  }

  async ingestEvent(sourceName: string, event: {uid:string;title:string;description:string;startAt:string;endAt:string;allDay:boolean}, provenance: 'calendar_import'|'legacy_import' = 'calendar_import') {
    const id=`event:${sourceName}:${event.uid}`;const acquiredAt=new Date().toISOString();
    await kernelTransaction(async client => {
      const version=await sourceVersion(client,{id,source:sourceName,scope:'calendar_import',externalId:event.uid,
        contentHash:stableId(JSON.stringify(event)),raw:event,acquiredAt});
      const entityId=stableId('event',id);
      await entity(client,entityId,'event',id,null,null);
      await recordCandidate(client,{entityId,attribute:'event_payload',value:event,sourceVersionId:version,
        source:provenance,sourceItemId:id,originalExcerpt:event.description || event.title,confidence:1,
        authority:provenance,locator:'event_payload',acquiredAt});
      const chosen=(await client.query<{canonical_value:typeof event}>(
        `SELECT canonical_value FROM facts WHERE entity_id=$1 AND attribute='event_payload'`,[entityId])).rows[0]?.canonical_value;
      if (chosen) await client.query(
        `INSERT INTO events(id,entity_id,source_item_id,source_name,external_uid,title,description,starts_at,ends_at,all_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO UPDATE SET title=excluded.title,
         description=excluded.description,starts_at=excluded.starts_at,ends_at=excluded.ends_at,
         all_day=excluded.all_day,updated_at=now()`,
        [id,entityId,id,sourceName,event.uid,chosen.title,chosen.description,chosen.startAt,chosen.endAt,chosen.allDay]);
    });
  }

  async listEvents(startAt: string, endAt: string) {
    const result=await kernelPool().query(
      `SELECT * FROM events WHERE ends_at>=$1 AND starts_at<=$2 ORDER BY starts_at,ends_at`,[startAt,endAt]);
    return result.rows.map(row=>({id:row.id,uid:row.external_uid,sourceName:row.source_name,title:row.title,
      description:row.description,startAt:iso(row.starts_at)!,endAt:iso(row.ends_at)!,allDay:row.all_day}));
  }

  async rebuildProjections(): Promise<{courses:number;tasks:number;events:number}> {
    return kernelTransaction(async client=>{
      // Maintenance operation: serialize projection rebuild with all kernel writers.
      await client.query('LOCK TABLE courses, tasks, events, facts, candidate_facts, evidence, source_items IN ACCESS EXCLUSIVE MODE');
      const courseFacts=(await client.query<{id:string;payload:Json;enabled:boolean|null}>(
        `SELECT c.id,f.canonical_value payload,enabled.canonical_value enabled
         FROM courses c JOIN entities en ON en.kind='course' AND en.identity_key=c.id
         JOIN facts f ON f.entity_id=en.id AND f.attribute='course_payload'
         LEFT JOIN facts enabled ON enabled.entity_id=en.id AND enabled.attribute='enabled'`)).rows;
      for(const row of courseFacts){
        await client.query(
          `UPDATE courses SET name=$2,code=$3,term_id=$4,starts_at=$5,ends_at=$6,enabled=$7,updated_at=now() WHERE id=$1`,
          [row.id,row.payload.name,row.payload.code,row.payload.termId,safeDate(row.payload.startsAt),
            safeDate(row.payload.endsAt),row.enabled??row.payload.enabled]);
      }
      const taskFacts=(await client.query<{entity_id:string;source_item_id:string}>(
        `SELECT f.entity_id,e.source_item_id FROM facts f
         JOIN candidate_facts c ON c.id=f.chosen_candidate_id
         JOIN evidence e ON e.id=c.evidence_id WHERE f.attribute='task_payload'`)).rows;
      await client.query('DELETE FROM tasks');
      for(const row of taskFacts)await projectTask(client,row.entity_id,row.source_item_id);
      const eventFacts=(await client.query<{entity_id:string;source_item_id:string;source:string;external_id:string;payload:{title:string;description:string;startAt:string;endAt:string;allDay:boolean}}>(
        `SELECT f.entity_id,e.source_item_id,s.source,s.external_id,f.canonical_value payload
         FROM facts f JOIN candidate_facts c ON c.id=f.chosen_candidate_id
         JOIN evidence e ON e.id=c.evidence_id JOIN source_items s ON s.id=e.source_item_id
         WHERE f.attribute='event_payload'`)).rows;
      await client.query('DELETE FROM events');
      for(const row of eventFacts)await client.query(
        `INSERT INTO events(id,entity_id,source_item_id,source_name,external_uid,title,description,starts_at,ends_at,all_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.source_item_id,row.entity_id,row.source_item_id,row.source,row.external_id,row.payload.title,
          row.payload.description,row.payload.startAt,row.payload.endAt,row.payload.allDay]);
      return {courses:courseFacts.length,tasks:Number((await client.query('SELECT count(*) FROM tasks')).rows[0].count),
        events:eventFacts.length};
    });
  }

  async pendingCandidates() {
    return (await kernelPool().query(
      `SELECT c.id,c.entity_id,c.attribute,c.value,c.authority,c.created_at,e.source,e.original_excerpt,
       en.kind entity_kind,t.id task_id,co.code course_code,f.canonical_value FROM candidate_facts c
       JOIN evidence e ON e.id=c.evidence_id JOIN entities en ON en.id=c.entity_id
       LEFT JOIN tasks t ON t.entity_id=c.entity_id LEFT JOIN courses co ON co.id=en.course_id
       LEFT JOIN facts f ON f.entity_id=c.entity_id AND f.attribute=c.attribute
       WHERE c.status='pending' AND en.merged_into IS NULL ORDER BY c.created_at LIMIT 100`)).rows;
  }

  async canonicalEvidence(courseIds: string[], taskIds: string[], eventIds: string[]) {
    const result=await kernelPool().query<{
      entity_kind:string;entity_key:string;task_id:string|null;attribute:string;source:string;
      source_item_id:string;
      source_url:string|null;original_excerpt:string;locator:string|null;authority:string;
      acquired_at:Date;published_at:Date|null;confidence:string;
    }>(
      `SELECT en.kind entity_kind,en.identity_key entity_key,t.id task_id,f.attribute,e.source,e.source_item_id,
       si.source_url,e.original_excerpt,e.locator,c.authority,e.acquired_at,e.published_at,e.confidence
       FROM facts f JOIN entities en ON en.id=f.entity_id
       JOIN fact_evidence fe ON fe.fact_id=f.id
       JOIN evidence e ON e.id=fe.evidence_id
       JOIN candidate_facts c ON c.id=fe.candidate_id
       JOIN source_items si ON si.id=e.source_item_id
       LEFT JOIN tasks t ON t.entity_id=en.id
       WHERE e.parsed_value=f.canonical_value AND (
          (en.kind='course' AND en.identity_key=ANY($1::text[]))
          OR (en.kind='task' AND t.id=ANY($2::text[]))
          OR (en.kind='event' AND en.identity_key=ANY($3::text[])))
       ORDER BY en.kind,en.identity_key,f.attribute,e.acquired_at DESC`,
      [courseIds,taskIds,eventIds]);
    return result.rows.map(row=>({...row,acquired_at:iso(row.acquired_at)!,
      published_at:iso(row.published_at),confidence:Number(row.confidence)}));
  }

  async candidate(id: string) {
    return (await kernelPool().query(
      `SELECT c.*,e.source,e.original_excerpt,e.acquired_at,e.published_at,e.confidence,
       en.kind entity_kind,t.id task_id,co.code course_code,f.canonical_value FROM candidate_facts c
       JOIN evidence e ON e.id=c.evidence_id JOIN entities en ON en.id=c.entity_id
       LEFT JOIN tasks t ON t.entity_id=c.entity_id LEFT JOIN courses co ON co.id=en.course_id
       LEFT JOIN facts f ON f.entity_id=c.entity_id AND f.attribute=c.attribute WHERE c.id=$1`,[id])).rows[0] ?? null;
  }

  async adjudicate(id: string, decision: 'accept'|'reject', reason: string, actor: string) {
    if (!reason.trim() || !actor.trim()) throw new Error('Actor and reason are required');
    await kernelTransaction(async client => {
      const candidate=(await client.query<{entity_id:string;attribute:string;value:unknown;status:string;kind:string}>(
        `SELECT c.entity_id,c.attribute,c.value,c.status,e.kind FROM candidate_facts c
         JOIN entities e ON e.id=c.entity_id WHERE c.id=$1 FOR UPDATE OF c`,[id])).rows[0];
      if (!candidate || candidate.status!=='pending') throw new Error('Candidate is not pending');
      if((await client.query<{merged_into:string|null}>(
        'SELECT merged_into FROM entities WHERE id=$1',[candidate.entity_id])).rows[0]?.merged_into)
        throw new Error('Candidate belongs to a merged task');
      if(decision==='accept' && ['due','cancelled'].includes(candidate.attribute) && candidate.kind!=='task'){
        throw new Error('Link this claim to a task before accepting it');
      }
      if(decision==='accept' && candidate.attribute==='due' && !(candidate.value as Deadline)?.precision){
        throw new Error('Deadline needs an unambiguous date or time before acceptance');
      }
      const before=(await client.query<{canonical_value:unknown}>(
        'SELECT canonical_value FROM facts WHERE entity_id=$1 AND attribute=$2 FOR UPDATE',
        [candidate.entity_id,candidate.attribute])).rows[0]?.canonical_value ?? null;
      if (decision==='accept') await acceptCandidate(client,id,`manual: ${reason.trim()}`);
      else await client.query(`UPDATE candidate_facts SET status='rejected',reason=$2,decided_at=now() WHERE id=$1`,[id,reason]);
      const after=decision==='accept'?candidate.value:before;
      await client.query(
        `INSERT INTO adjudications(candidate_id,actor,decision,reason,before_value,after_value)
         VALUES ($1,$2,$3,$4,$5,$6)`,[id,actor,decision,reason,JSON.stringify(before),JSON.stringify(after)]);
      if (decision==='accept' && ['task_payload','due','cancelled'].includes(candidate.attribute)) {
        const item=(await client.query<{id:string}>(
          `SELECT e.source_item_id id FROM candidate_facts c JOIN evidence e ON e.id=c.evidence_id WHERE c.id=$1`,
          [id])).rows[0];
        if (item) await projectTask(client,candidate.entity_id,item.id);
      }
    });
  }

  async linkCandidate(id:string,taskId:string,reason:string,actor:string):Promise<string>{
    if(!reason.trim()||!actor.trim())throw new Error('Actor and reason are required');
    return kernelTransaction(async client=>{
      const candidate=(await client.query<{entity_id:string;attribute:string;value:unknown;evidence_id:string;status:string;authority:string;kind:string}>(
        `SELECT c.entity_id,c.attribute,c.value,c.evidence_id,c.status,c.authority,e.kind
         FROM candidate_facts c JOIN entities e ON e.id=c.entity_id WHERE c.id=$1 FOR UPDATE OF c`,[id])).rows[0];
      if(!candidate||candidate.status!=='pending')throw new Error('Candidate is not pending');
      if(candidate.kind!=='mail_claim'||!['due','cancelled'].includes(candidate.attribute))
        throw new Error('Only an unlinked mail deadline or cancellation claim can be linked');
      const target=(await client.query<{entity_id:string}>(
        'SELECT entity_id FROM tasks WHERE id=$1',[taskId])).rows[0];
      if(!target)throw new Error('Target task not found');
      await client.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE',[target.entity_id]);
      const linkedId=stableId(target.entity_id,candidate.attribute,candidate.evidence_id);
      await client.query(
        `INSERT INTO candidate_facts(id,entity_id,attribute,value,evidence_id,status,authority)
         VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT(id) DO NOTHING`,
        [linkedId,target.entity_id,candidate.attribute,JSON.stringify(candidate.value),candidate.evidence_id,candidate.authority]);
      await client.query(`UPDATE candidate_facts SET status='superseded',reason=$2,decided_at=now() WHERE id=$1`,[id,`linked to ${taskId}`]);
      await client.query(
        `INSERT INTO adjudications(candidate_id,actor,decision,reason,before_value,after_value)
         VALUES ($1,$2,'link',$3,$4,$5)`,[id,actor,reason,
          JSON.stringify({entityId:candidate.entity_id}),JSON.stringify({entityId:target.entity_id,taskId,linkedId})]);
      return linkedId;
    });
  }
}

export const kernel = new KernelService();
