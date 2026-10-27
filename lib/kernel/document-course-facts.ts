import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {PoolClient} from 'pg';
import {kernelPool} from './db.ts';
import type {IngestionJob} from './jobs.ts';

export const DOCUMENT_COURSE_FACT_JOB_KIND='document_course_facts';
export const DOCUMENT_COURSE_FACT_EXTRACTOR_VERSION='explicit-pdf-lines-v1';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
type Query=Pick<PoolClient,'query'>;
export type DocumentCourseFactCandidate={
 attribute:'course_policy'|'course_requirement'|'exam';identityKey:string;
 value:{schemaVersion:1;kind:'assignment'|'due'|'submission'|'grading'|'policy'|'exam';title:string|null;text:string;date:string|null;time:null;timezone:null};
 pageNumber:number;evidenceId:string;pageBodySha256:string;startUtf16:number;endUtf16:number;
 locator:string;originalExcerpt:string;confidence:number;extractorVersion:string;
};
export type DocumentCourseFactBatch={owner:string;documentId:string;versionId:string;sourceVersionId:string;sourceItemId:string;
 sourceHash:string;parserVersion:string;courseId:string|null;acquiredAt:string;candidates:DocumentCourseFactCandidate[]};
type Payload={owner:string;id:string;versionId:string;sourceVersionId:string;sourceHash:string;extractorVersion:string};
type Page={document_id:string;version_id:string;source_version_id:string;source_item_id:string;source_hash:string;parser_version:string;
 course_id:string|null;acquired_at:Date|string;page_count:number;page_number:number;evidence_id:string;locator:string;body:string};

export function documentCourseFactsEnabled(){return process.env.KERNEL_DOCUMENT_FACTS==='true';}
/** Date-only literals keep their original precision. Never supply a year, clock or zone. */
function explicitDate(text:string):string|null{
 const matches=[...text.matchAll(/(?<![\d-])\d{4}-\d{2}-\d{2}(?![\d-])/g)].map(m=>m[0]);
 const dates=[...new Set(matches)];if(dates.length!==1)return null;
 const date=dates[0],parsed=new Date(date+'T00:00:00Z');
 return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===date?date:null;
}
const assignment=/^(?:#{1,6}\s*)?(?:assignment|homework|problem set|lab|project|作业|实验)(?:\s|[:：#\d])/iu;
/** Narrow, literal line proposals. Section membership and task identity stay unknown. */
export function extractDocumentCourseFactCandidates(pages:Array<{pageNumber:number;evidenceId:string;locator:string;body:string}>):DocumentCourseFactCandidate[]{
 const result:DocumentCourseFactCandidate[]=[],seen=new Set<string>();
 for(const page of pages){
  let title:string|null=null;
  for(const match of page.body.matchAll(/[^\r\n]+/g)){
   const raw=match[0],text=raw.trim();if(!text)continue;
   const start=match.index!+raw.indexOf(text),end=start+text.length;
   // Do not cut a long source span or interpret a table/illustrative example as a rule.
   if(text.length>1200||text.length<6||/^(?:\||(?:for\s+)?example\b|sample\b|示例|例[:：])/iu.test(text))continue;
   const isAssignment=assignment.test(text);if(isAssignment)title=text;
   let kind:DocumentCourseFactCandidate['value']['kind']|null=null;
   if(/^(?:#{1,6}\s*)?(?:(?:final|midterm|make[- ]?up)\s+)?exam(?:ination)?\b|^(?:期中|期末|补考)?考试/iu.test(text))kind='exam';
   else if(/^(?:#{1,6}\s*)?(?:grading\b|assessment\s+(?:policy|weights?)\b|评分|成绩构成)/iu.test(text))kind='grading';
   else if(/^(?:#{1,6}\s*)?(?:late\s+(?:submission|work|policy)|attendance\s+(?:policy|requirement)|academic\s+integrity|(?:course\s+)?policy\b|迟交|学术诚信|考勤|课程政策)/iu.test(text))kind='policy';
   else if(/^(?:due(?:\s+date)?|deadline)\s*[:：]|\b(?:is\s+due|due\s+(?:on\s+)?\d{4}-\d{2}-\d{2})\b|^(?:截止|提交截止|截止日期)\s*[:：]/iu.test(text))kind='due';
   else if(/^(?:submit\b|submission\s+(?:requirements?|instructions?)\b|提交(?:要求|方式|作业)|请提交)/iu.test(text))kind='submission';
   else if(isAssignment)kind='assignment';
   if(!kind)continue;
   const attribute=kind==='exam'?'exam':kind==='policy'||kind==='grading'?'course_policy':'course_requirement';
   const identityKey=kind+':'+sha(text.normalize('NFKC').replace(/\s+/gu,' ').toLowerCase());
   if(seen.has(identityKey))continue;seen.add(identityKey);
   result.push({attribute,identityKey,value:{schemaVersion:1,kind,title:kind==='assignment'||kind==='exam'?text:title,text,
    date:kind==='due'||kind==='exam'?explicitDate(text):null,time:null,timezone:null},pageNumber:page.pageNumber,evidenceId:page.evidenceId,
    pageBodySha256:sha(page.body),startUtf16:start,endUtf16:end,locator:`${page.locator}; course-fact utf16 ${start}:${end}`,
    originalExcerpt:text,confidence:kind==='due'&&explicitDate(text)?0.85:0.65,extractorVersion:DOCUMENT_COURSE_FACT_EXTRACTOR_VERSION});
   if(result.length>=200)return result;
  }
 }
 return result;
}

/** Called in the ingest transaction, only for its newly published current PDF. */
export async function queueDocumentCourseFactJob(client:Query,owner:string,documentId:string,versionId:string){
 if(!documentCourseFactsEnabled())return{queued:false};
 const row=(await client.query<{source_version_id:string;source_hash:string}>(`SELECT v.source_version_id,d.source_hash
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
  WHERE d.owner_id=$1 AND d.id=$2 AND v.id=$3 AND NOT d.hidden
  AND s.raw_value->>'mime'='application/pdf' AND s.raw_sha256=d.source_hash
  AND NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin
   AND newer.origin_key=d.origin_key AND NOT newer.hidden AND(newer.created_at>d.created_at OR(newer.created_at=d.created_at AND newer.id>d.id)))`,
 [owner,documentId,versionId])).rows[0];
 if(!row)return{queued:false};
 const id='document-course-facts:'+sha(JSON.stringify([DOCUMENT_COURSE_FACT_EXTRACTOR_VERSION,owner,documentId,versionId]));
 const payload:Payload={owner,id:documentId,versionId,sourceVersionId:row.source_version_id,sourceHash:row.source_hash,extractorVersion:DOCUMENT_COURSE_FACT_EXTRACTOR_VERSION};
 await client.query(`INSERT INTO ingestion_jobs(id,kind,source,scope,payload,idempotency_key)
  VALUES($1,$2,'document-course-facts',$3,$4,$1) ON CONFLICT(idempotency_key) DO NOTHING`,[id,DOCUMENT_COURSE_FACT_JOB_KIND,documentId,JSON.stringify(payload)]);
 return{queued:true};
}
async function readPayload(client:Query,job:IngestionJob,lock=false):Promise<Payload>{
 const row=(await client.query<{payload:Payload}>(`SELECT payload FROM ingestion_jobs WHERE id=$1 AND lease_token=$2
  AND kind=$3 AND state='running' AND lease_until>now() ${lock?'FOR UPDATE':''}`,[job.id,job.lease_token,DOCUMENT_COURSE_FACT_JOB_KIND])).rows[0];
 if(!row)throw Error('Document course fact job lease lost');
 const p=row.payload;
 if(job.kind!==DOCUMENT_COURSE_FACT_JOB_KIND||!p||typeof p.owner!=='string'||!p.owner.trim()||typeof p.id!=='string'||!p.id.trim()||job.scope!==p.id||
  ![p.versionId,p.sourceVersionId,p.sourceHash].every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value))||
  p.extractorVersion!==DOCUMENT_COURSE_FACT_EXTRACTOR_VERSION)throw Error('Invalid document course fact job');
 return p;
}
async function readBatch(client:Query,p:Payload,lock=false):Promise<DocumentCourseFactBatch>{
 const rows=(await client.query<Page>(`SELECT d.id document_id,v.id version_id,v.source_version_id,d.source_item_id,d.source_hash,v.parser_version,
  d.course_id,s.acquired_at,v.page_count,p.page_number,p.evidence_id,p.locator,p.body
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
  JOIN document_text_pages p ON p.version_id=v.id JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id AND e.source_item_id=d.source_item_id
  WHERE d.owner_id=$1 AND d.id=$2 AND v.id=$3 AND v.source_version_id=$4 AND d.source_hash=$5 AND NOT d.hidden
  AND s.raw_value->>'mime'='application/pdf' AND s.raw_sha256=d.source_hash AND p.content_kind='page'
  AND NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin
   AND newer.origin_key=d.origin_key AND NOT newer.hidden AND(newer.created_at>d.created_at OR(newer.created_at=d.created_at AND newer.id>d.id)))
  ORDER BY p.page_number LIMIT 513 ${lock?'FOR UPDATE OF d,v,s,p,e':''}`,[p.owner,p.id,p.versionId,p.sourceVersionId,p.sourceHash])).rows;
 if(!rows.length||rows.length>512||rows.length!==rows[0].page_count||rows.some((r,i)=>r.page_number!==i+1)||
  rows.reduce((sum,r)=>sum+Buffer.byteLength(r.body),0)>2097152)throw Error('Document course fact source version changed or exceeds limits');
 const row=rows[0];return{owner:p.owner,documentId:p.id,versionId:p.versionId,sourceVersionId:p.sourceVersionId,sourceItemId:row.source_item_id,
  sourceHash:p.sourceHash,parserVersion:row.parser_version,courseId:row.course_id,acquiredAt:new Date(row.acquired_at).toISOString(),
  candidates:extractDocumentCourseFactCandidates(rows.map(r=>({pageNumber:r.page_number,evidenceId:r.evidence_id,locator:r.locator,body:r.body})))};
}
export async function prepareDocumentCourseFactJob(job:IngestionJob,client:Query=kernelPool()){
 return readBatch(client,await readPayload(client,job));
}
/** Registration calls this inside its short transaction before recordCandidate. */
export async function assertDocumentCourseFactBatch(client:Query,batch:DocumentCourseFactBatch,job:IngestionJob){
 const current=await readBatch(client,await readPayload(client,job,true),true);
 if(!isDeepStrictEqual(current,batch))throw Error('Document course fact source or candidate changed');
 return current;
}
export async function runDocumentCourseFactJob<T>(job:IngestionJob,register:(batch:DocumentCourseFactBatch,job:IngestionJob)=>Promise<T>){
 if(!documentCourseFactsEnabled())throw Error('Document course fact jobs disabled');
 return register(await prepareDocumentCourseFactJob(job),job);
}
