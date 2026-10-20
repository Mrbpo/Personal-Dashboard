import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {Pool} from 'pg';
import {classifyContentMetadata,CONTENT_TAG_PRODUCER,CONTENT_TAG_TAXONOMY,type ContentTagMetadata} from './content-tags.ts';
import {DocumentEvidenceChangedError} from './document-evidence.ts';

export const CONTENT_TAG_ROUTE_VERSION='metadata-candidate-priority-v1';
const WINDOW=8;
type Hint={facet:'document_type'|'source';key:string;alias:string;start:number;end:number};
// Controlled query aliases refer to the existing ingestion keys. They are
// navigation observations, not subject classification or explicit scope.
const aliases:Array<[Hint['facet'],string,RegExp]>=[
 ['document_type','syllabus',/\bsyllabus\b|\bcourse\s+outline\b|课程大纲/giu],
 ['document_type','assignment',/\b(?:assignments?|homework|problem\s+sets?|tutorials?|labs?)\b|作业|实验说明/giu],
 ['document_type','lecture-notes',/\blecture\s+notes?\b|讲义/giu],
 ['document_type','slides',/\bslides?\b|课件/giu],
 ['document_type','announcement',/\bannouncements?\b|公告/giu],
 ['document_type','discussion',/\bdiscussions?\b|论坛|讨论/giu],
 ['document_type','transcript',/\b(?:transcripts?|subtitles?)\b|字幕|转写/giu],
 ['source','canvas',/\b(?:canvas|quercus)\b/giu],
 ['source','piazza',/\bpiazza\b/giu],
 ['source','gmail',/\b(?:gmail|emails?)\b|邮件/giu],
 ['source','kaltura',/\bkaltura\b/giu],
];
const sha=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');

export function contentTagRoutingMode(){
 const mode=process.env.KERNEL_CONTENT_TAG_ROUTING??'off';
 if(!['off','metadata-priority-v1','classification-shadow-v1'].includes(mode))throw Error('Invalid KERNEL_CONTENT_TAG_ROUTING');
 return mode;
}

export function contentTagQueryPlan(question:string){
 if(typeof question!=='string'||!question.trim()||question.length>16000)throw Error('Invalid content tag routing query');
 const hints:Hint[]=[];
 for(const [facet,key,pattern]of aliases){
  // matchAll clones the regexp: one query cannot change another query's cursor.
  for(const match of question.matchAll(pattern))hints.push({facet,key,alias:match[0],start:match.index,end:match.index+match[0].length});
 }
 hints.sort((a,b)=>a.start-b.start||a.end-b.end||a.key.localeCompare(b.key));
 const identity={version:CONTENT_TAG_ROUTE_VERSION,questionSha256:sha(question),hints};
 return {...identity,planSha256:sha(identity),filterAuthorization:false as const,
  coverage:'literal-document-type-and-source-only' as const};
}

type Candidate={document_id:string;page_number:number;source_version_id:string;evidence_id:string;source_hash:string};
type TagMatch={facet:Hint['facet'];key:string;tagId:string};
type Observation={matches:TagMatch[];snapshotIds:string[];reason:'matching-current-tags'|'no-matching-tags'|'no-current-tags'|'invalid-or-incompatible-tags'};
export type ContentTagRoutingReceipt={version:typeof CONTENT_TAG_ROUTE_VERSION;planSha256:string;
 originalRank:number;finalRank:number;windowSize:8;candidateCount:number;candidateSetSha256:string;
 matches:TagMatch[];snapshotIds:string[];reason:Observation['reason'];filterAuthorization:false;semanticVerified:false};
const candidateKey=(c:Candidate)=>JSON.stringify([c.document_id,c.page_number,c.source_version_id,c.evidence_id,c.source_hash]);

/** This describes the ranked reader's returned anchors, not its whole pool or
 * the corpus. It stays outside provider input and citation/source authority. */
export function contentTagAnswerObservation(candidates:Array<Candidate&{id:string;content_tag_routing?:ContentTagRoutingReceipt}>){
 const routed=candidates.filter(c=>c.content_tag_routing);if(!routed.length)return undefined;
 const pools=new Map<string,{planSha256:string;candidateSetSha256:string;candidateCount:number;observedAnchors:number}>();
 const anchors=routed.map(c=>{
  const receipt=structuredClone(c.content_tag_routing!),key=JSON.stringify([receipt.planSha256,receipt.candidateSetSha256]);
  const pool=pools.get(key)??{planSha256:receipt.planSha256,candidateSetSha256:receipt.candidateSetSha256,
   candidateCount:receipt.candidateCount,observedAnchors:0};
  pool.observedAnchors++;pools.set(key,pool);
  return {id:c.id,documentId:c.document_id,physicalPage:c.page_number,sourceVersionId:c.source_version_id,
   sourceHash:c.source_hash,evidenceId:c.evidence_id,receipt};
 });
 return {version:'metadata-answer-routing-observation-v1' as const,scope:'ranked-reader-returned-anchors-only' as const,
  observedAnchors:candidates.length,routedAnchors:routed.length,unroutedAnchors:candidates.length-routed.length,
  observedDocuments:new Set(candidates.map(c=>c.document_id)).size,pools:[...pools.values()],anchors,
  eligibleCorpusDocuments:null,scoredDocuments:null,filtering:'none' as const,semanticVerified:false as const,answerCorrectness:'unassessed' as const};
}

/** Reorder only within the original rank window. No candidate is added,
 * removed or rewritten, and the original relevance score is not confidence. */
export function orderMetadataTaggedCandidates<T extends Candidate>(candidates:T[],observations:Map<string,Observation>,plan:ReturnType<typeof contentTagQueryPlan>):Array<T&{content_tag_routing:ContentTagRoutingReceipt}>{
 if(candidates.length>240||new Set(candidates.map(candidateKey)).size!==candidates.length)throw Error('Invalid content tag candidate pool');
 const candidateSetSha256=sha(candidates.map(candidateKey).sort()),rows=candidates.map((hit,index)=>{
  const observation=observations.get(hit.document_id);if(!observation)throw Error('Missing content tag observation');
  return {hit,index,observation};
 }),ordered:typeof rows=[];
 for(let start=0;start<rows.length;start+=WINDOW)ordered.push(...rows.slice(start,start+WINDOW)
  .sort((a,b)=>Number(b.observation.matches.length>0)-Number(a.observation.matches.length>0)||a.index-b.index));
 return ordered.map(({hit,index,observation},rank)=>({...hit,content_tag_routing:{version:CONTENT_TAG_ROUTE_VERSION,
  planSha256:plan.planSha256,originalRank:index+1,finalRank:rank+1,windowSize:WINDOW,candidateCount:candidates.length,
  candidateSetSha256,...observation,filterAuthorization:false,semanticVerified:false}}));
}

type Snapshot={id:string;metadata:ContentTagMetadata;tags:unknown;classification_sha256:string};
type CurrentRow=Candidate&{tag_sets:Snapshot[]};

/** Bounded metadata read over the already retrieved pool, with the same owner,
 * source-head and page identity checks as retrieval. Does not read vectors/body,
 * filter the corpus, create classifications or call a provider. */
export async function routeDocumentContentTagCandidates<T extends Candidate>(pool:Pool,owner:string,question:string,candidates:T[]):Promise<T[]>{
 if(contentTagRoutingMode()!=='metadata-priority-v1'||!candidates.length)return candidates;
 const plan=contentTagQueryPlan(question);if(!plan.hints.length)return candidates;
 if(candidates.length>240||new Set(candidates.map(candidateKey)).size!==candidates.length)throw Error('Invalid content tag candidate pool');
 const rows=(await pool.query<CurrentRow>(`/* content-tags:candidate-priority */
  WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb)
   AS r(document_id text,page_number integer,source_version_id text,evidence_id text,source_hash text))
  SELECT d.id document_id,p.page_number,v.source_version_id,p.evidence_id,d.source_hash,
   coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'metadata',t.metadata,'tags',t.tags,
    'classification_sha256',t.classification_sha256) ORDER BY t.id) FROM document_tag_sets t
    WHERE t.owner_id=d.owner_id AND t.document_id=d.id AND t.version_id=v.id AND t.source_version_id=v.source_version_id
     AND t.source_hash=d.source_hash AND t.taxonomy_version=$3 AND t.producer=$4),'[]'::jsonb) tag_sets
  FROM requested r JOIN document_texts d ON d.id=r.document_id AND d.owner_id=$1 AND NOT d.hidden AND d.source_hash=r.source_hash
   JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id AND v.source_version_id=r.source_version_id
   JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=r.page_number AND p.evidence_id=r.evidence_id
  WHERE NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin
   AND newer.origin_key=d.origin_key AND NOT newer.hidden AND
    (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))`,
 [owner,JSON.stringify(candidates.map(({document_id,page_number,source_version_id,evidence_id,source_hash})=>
  ({document_id,page_number,source_version_id,evidence_id,source_hash}))),CONTENT_TAG_TAXONOMY,CONTENT_TAG_PRODUCER])).rows;
 const expected=new Set(candidates.map(candidateKey));
 if(rows.length!==candidates.length||new Set(rows.map(candidateKey)).size!==rows.length||rows.some(row=>!expected.has(candidateKey(row))))
  throw new DocumentEvidenceChangedError();
 const observations=new Map<string,Observation>();
 for(const row of rows){
  if(observations.has(row.document_id))continue;
  const valid=row.tag_sets.flatMap(snapshot=>{
   try{const actual=classifyContentMetadata(snapshot.metadata);
    if(actual.classificationSha256!==snapshot.classification_sha256||!isDeepStrictEqual(actual.tags,snapshot.tags))return [];
    return [{id:snapshot.id,tags:actual.tags}];
   }catch{return [];}
  });
  // Multiple metadata revisions are not a winner election. Only a match shared
  // by every valid current revision can influence order. Invalid revisions
  // disable prioritization for this document; its evidence remains in the pool.
  const compatible=valid.length===row.tag_sets.length,matches:TagMatch[]=[];
  if(compatible&&valid.length)for(const hint of plan.hints){
   const tag=valid[0].tags.find(t=>t.facet===hint.facet&&t.key===hint.key);
   if(tag&&!matches.some(m=>m.tagId===tag.id)&&valid.every(s=>s.tags.some(t=>t.id===tag.id)))matches.push({facet:hint.facet,key:hint.key,tagId:tag.id});
  }
  observations.set(row.document_id,{matches,snapshotIds:valid.map(s=>s.id),reason:!row.tag_sets.length?'no-current-tags':
   !compatible?'invalid-or-incompatible-tags':matches.length?'matching-current-tags':'no-matching-tags'});
 }
 return orderMetadataTaggedCandidates(candidates,observations,plan);
}
