import type {Pool} from 'pg';
import {createHash} from 'node:crypto';
import {evaluateFactValidity,factCalendarDate,factInstant,factLocalDate,type FactValidity,type FactValidityBasis} from './fact-validity.ts';
import {deadlineWindowBounds} from '../due-window.ts';

type QueryDb=Pick<Pool,'query'>;
type Json=Record<string,unknown>;
export type CourseFactOptions={asOf?:string;history?:boolean};
export type CourseFactRow={
 fact_id:string;entity_id:string;entity_kind:string;attribute:string;value:unknown;version:number;current_version:number;
 course_id:string|null;course_code:string|null;course_name:string|null;course_ends_at:string|null;term_ends_on:string|null;
 candidate_id:string;evidence_id:string;source_version_id:string;source_item_id:string;source:string;locator:string|null;
 original_excerpt:string;confirmation:string;pending_conflict:boolean;source_missing:boolean;
 valid_from:string|null;valid_to:string|null;validity_basis:FactValidityBasis;
 recorded_at:string;acquired_at:string;published_at:string|null;
 source_checked_at?:string|null;
 source_url?:string|null;source_changed?:boolean;
 document_id:string|null;document_version_id:string|null;document_source_hash:string|null;page_evidence_id:string|null;
 document_page_body?:string|null;document_body_sha256?:string|null;document_start_utf16?:number|null;document_end_utf16?:number|null;
};
/** One snapshot supplies owner authorization, canonical values, immutable evidence,
 * conflicts, and only GET-readable original-page mappings. No task projection values. */
const FACT_SELECT=`SELECT f.id fact_id,f.entity_id,n.kind entity_kind,f.attribute,fv.value,
 fv.version,f.version current_version,n.course_id,c.code course_code,c.name course_name,
 c.ends_at::text course_ends_at,term.ends_on::text term_ends_on,fv.candidate_id,
 e.id evidence_id,e.source_version_id,e.source_item_id,e.source,e.locator,e.original_excerpt,
 cf.status confirmation,si.state='missing' source_missing,
 EXISTS(SELECT 1 FROM candidate_facts pending WHERE pending.entity_id=f.entity_id AND pending.attribute=f.attribute
  AND pending.status='pending' AND pending.value IS DISTINCT FROM fv.value) pending_conflict,
 fv.valid_from::text valid_from,fv.valid_to::text valid_to,e.validity_basis,
 fv.recorded_at::text recorded_at,e.acquired_at::text acquired_at,e.published_at::text published_at,
 ss.last_completed_at::text source_checked_at,si.source_url,
 (si.source LIKE 'document:%' AND NOT EXISTS(
  SELECT 1 FROM document_texts active_doc JOIN document_text_versions active_v ON active_v.id=active_doc.current_version_id
  WHERE active_doc.owner_id=n.owner_id AND active_doc.source_item_id=si.id AND NOT active_doc.hidden
   AND active_v.source_version_id=e.source_version_id AND active_doc.source_hash=sv.raw_sha256
   AND NOT EXISTS(SELECT 1 FROM document_texts newer WHERE newer.owner_id=active_doc.owner_id
    AND newer.origin=active_doc.origin AND newer.origin_key=active_doc.origin_key AND NOT newer.hidden
    AND (newer.created_at>active_doc.created_at OR(newer.created_at=active_doc.created_at AND newer.id>active_doc.id))))) source_changed,
 doc.id document_id,doc.version_id document_version_id,doc.source_hash document_source_hash,doc.evidence_id page_evidence_id,
 doc.body document_page_body,doc.body_sha256 document_body_sha256,doc.start_utf16 document_start_utf16,doc.end_utf16 document_end_utf16
 FROM facts f JOIN entities n ON n.id=f.entity_id
 JOIN fact_versions fv ON fv.fact_id=f.id
 JOIN candidate_facts cf ON cf.id=fv.candidate_id AND cf.entity_id=n.id AND cf.attribute=f.attribute
 JOIN evidence e ON e.id=cf.evidence_id
 JOIN source_item_versions sv ON sv.id=e.source_version_id AND sv.source_item_id=e.source_item_id
 JOIN source_items si ON si.id=e.source_item_id
 LEFT JOIN source_status ss ON ss.source=si.source AND ss.scope=si.scope
 LEFT JOIN courses c ON c.id=n.course_id
 LEFT JOIN academic_terms term ON term.id=coalesce(n.term_id,c.term_id)
 LEFT JOIN LATERAL (
  SELECT d.id,v.id version_id,d.source_hash,p.evidence_id,p.body,m.body_sha256,m.start_utf16,m.end_utf16
  FROM document_texts d JOIN document_text_versions v ON v.document_id=d.id AND v.source_version_id=e.source_version_id
  JOIN document_text_pages p ON p.version_id=v.id
  JOIN evidence pe ON pe.id=p.evidence_id AND pe.source_version_id=v.source_version_id AND pe.source_item_id=d.source_item_id
  LEFT JOIN document_course_fact_candidates m ON m.candidate_id=cf.id AND m.owner_id=n.owner_id
   AND m.document_id=d.id AND m.version_id=v.id AND m.source_version_id=v.source_version_id
   AND m.source_hash=d.source_hash AND m.page_number=p.page_number AND m.page_evidence_id=p.evidence_id
  WHERE d.owner_id=n.owner_id AND NOT d.hidden AND d.source_item_id=e.source_item_id
   AND d.source_hash=sv.raw_sha256 AND (p.evidence_id=e.id OR
    (p.locator=e.locator AND length(e.original_excerpt)>0 AND strpos(p.body,e.original_excerpt)>0) OR m.candidate_id IS NOT NULL)
  ORDER BY d.id,v.id,p.page_number LIMIT 1
 ) doc ON true`;
const ATTRIBUTES=['task_payload','due','cancelled','local_status','event_payload','course_payload','course_policy','course_requirement','exam','course_policies'];
const record=(value:unknown):Json=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Json:{};
const text=(value:unknown)=>typeof value==='string'?value:'';
const norm=(value:string)=>value.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const stamp=(value:unknown)=>{
 if(value==null)return null;
 if(value instanceof Date)return value.toISOString();
 if(factCalendarDate(value))return value;
 const parsed=new Date(String(value));return Number.isFinite(parsed.getTime())?parsed.toISOString():String(value);
};
function normalizeRow(row:CourseFactRow):CourseFactRow {
 const normalized={...row,valid_from:stamp(row.valid_from),valid_to:stamp(row.valid_to),recorded_at:stamp(row.recorded_at)!,
  acquired_at:stamp(row.acquired_at)!,published_at:stamp(row.published_at),source_checked_at:stamp(row.source_checked_at),course_ends_at:stamp(row.course_ends_at),term_ends_on:stamp(row.term_ends_on)};
 if(row.document_body_sha256){
  const body=row.document_page_body,start=row.document_start_utf16,end=row.document_end_utf16;
  if(typeof body!=='string'||typeof start!=='number'||typeof end!=='number'||start<0||end<=start||
   createHash('sha256').update(body).digest('hex')!==row.document_body_sha256||body.slice(start,end)!==row.original_excerpt)
   normalized.document_id=null;
 }
 return normalized;
}
function rowTitle(row:CourseFactRow){const value=record(row.value);return text(value.title)||text(value.name)||text(value.topic)||row.attribute;}
function rowDeadline(row:CourseFactRow){
 const value=record(row.value),due=record(value.due);
 const candidate=row.attribute==='due'?value:Object.keys(due).length?due:value;
 return {date:text(candidate.date)||text(candidate.dueDate)||null,at:text(candidate.at)||text(candidate.dueAt)||null,
  timezone:text(candidate.timezone)||text(candidate.dueTimezone)||null,precision:text(candidate.precision)||(factCalendarDate(candidate.date)&&!candidate.at?'date':null)};
}
function courseTimezone(row:CourseFactRow,related:CourseFactRow[]){
 return row.course_id?text(record(related.find(item=>item.course_id===row.course_id&&item.attribute==='course_payload')?.value).sourceTimezone)||null:null;
}
/** A course zone supplies a comparison context, never a new stored deadline instant. */
function comparisonDeadline(row:CourseFactRow,related:CourseFactRow[]){
 const due=rowDeadline(row);
 return due.precision==='date'&&!due.timezone?{...due,timezone:courseTimezone(row,related)}:due;
}
function rowValidity(row:CourseFactRow,clock:Date,related:CourseFactRow[]=[]):FactValidity {
 const current=related.filter(item=>item.entity_id===row.entity_id&&
  !['not_yet_valid','expired'].includes(evaluateFactValidity({validFrom:item.valid_from,validTo:item.valid_to,validityBasis:item.validity_basis},clock).time)),
  payload=record(current.find(item=>item.attribute==='task_payload')?.value);
 const status=text(current.find(item=>item.attribute==='local_status')?.value);
 return evaluateFactValidity({validFrom:row.valid_from,validTo:row.valid_to,validityBasis:row.validity_basis,
  version:row.version,currentVersion:row.current_version,confirmation:row.confirmation,pendingConflict:row.pending_conflict,
  sourceMissing:row.source_missing,cancelled:current.some(item=>item.attribute==='cancelled'&&item.value===true),
  sourceCheckedAt:row.source_checked_at,sourceChanged:row.source_changed,
  courseTimezone:courseTimezone(row,related),
  completed:status==='completed'||payload.canvasStatus==='completed',ignored:status==='ignored',
  due:row.attribute==='due'||record(row.value).kind==='due'?comparisonDeadline(row,related):null,eventEnd:row.attribute==='event_payload'?text(record(row.value).endAt):null,
  courseEndsAt:row.course_ends_at,termEndsOn:row.term_ends_on},clock);
}
function citation(row:CourseFactRow,index:number){
 const result:Json={id:`fact-${index+1}`,ref:`fact-${index+1}`,title:`${row.course_code||row.course_name||row.source} · ${rowTitle(row)}`,factId:row.fact_id,factVersion:row.version,candidateId:row.candidate_id,
  evidenceId:row.evidence_id,sourceVersionId:row.source_version_id,sourceItemId:row.source_item_id,
  source:row.source,locator:row.locator,excerpt:row.original_excerpt,acquiredAt:row.acquired_at,publishedAt:row.published_at,sourceCheckedAt:row.source_checked_at??null};
 if(row.document_id&&row.document_version_id&&row.document_source_hash&&row.page_evidence_id){
  result.documentId=row.document_id;
  result.url=`/api/library/${encodeURIComponent(row.document_id)}?${new URLSearchParams({evidence:'1',snapshot:'1',version:row.document_version_id,
   sourceVersion:row.source_version_id,sourceHash:row.document_source_hash,evidenceId:row.page_evidence_id})}`;
 }else if(row.source_url&&['canvas','calendar_import'].includes(row.source)){
  try{const url=new URL(row.source_url);if(['https:','http:'].includes(url.protocol)&&!url.username&&!url.password)result.url=url.href;}catch{/* Keep provenance without an unusable link. */}
 }
 return result;
}
function displayValue(row:CourseFactRow){
 const value=record(row.value);
 if(row.attribute==='due'){
  const due=rowDeadline(row);
  return due.at?`${due.at}${due.timezone?` (${due.timezone})`:''}`:due.date?`${due.date} (date only${due.timezone?`; ${due.timezone}`:''})`:'Deadline time is unconfirmed';
 }
 if(row.attribute==='event_payload')return `${rowTitle(row)}: ${text(value.startAt)||'start unknown'} — ${text(value.endAt)||'end unknown'}${value.allDay?' (all day)':''}`;
 if(typeof row.value==='string')return row.value;
 return text(value.text)||text(value.policy)||text(value.requirement)||text(value.description)||text(value.action)||rowTitle(row);
}
type Target={rows:CourseFactRow[];clarification?:string;targeted:boolean};
/** Conservative literal binding: duplicate titles/codes require a choice. */
function bindTargets(rows:CourseFactRow[],question:string):Target {
 const q=` ${norm(question)} `,courses=new Map<string,{label:string;name:string;code:string}>();
 for(const row of rows)if(row.course_id)courses.set(row.course_id,{label:`${row.course_code||row.course_name} (${row.course_id})`,name:norm(row.course_name||''),code:norm(row.course_code||'')});
 const courseIds=[...courses].filter(([,course])=>[course.code,course.name].some(term=>term&&q.includes(` ${term} `))).map(([id])=>id);
 if(courseIds.length>1)return {rows:[],targeted:true,clarification:`Which course do you mean? ${courseIds.map(id=>courses.get(id)!.label).join('; ')}`};
 // A course-shaped literal absent from the authorized catalogue must not fall back globally.
 const literals=question.match(/\b[A-Za-z]{2,8}\s*[- ]?\d{2,4}[A-Za-z]?\b/g)||[];
 if(!courseIds.length&&literals.length)return {rows:[],targeted:true,clarification:`I could not identify an authorized course for ${literals.join(', ')}. Please provide its course code or full title.`};
 const scope=courseIds.length?rows.filter(row=>row.course_id===courseIds[0]):rows;
 const named=scope.filter(row=>['task_payload','event_payload','exam','course_policy','course_requirement'].includes(row.attribute)&&
  norm(rowTitle(row)).length>=3&&q.includes(` ${norm(rowTitle(row))} `));
 const ids=[...new Set(named.map(row=>row.entity_id))];
 if(ids.length>1&&!/\b(all|list|deadlines|tasks|events|exams|policies|requirements)\b|全部|所有/.test(question.toLowerCase()))
  return {rows:[],targeted:true,clarification:`Which item do you mean? ${named.map(row=>`${rowTitle(row)} (${row.course_code||row.course_name||row.entity_id})`).join('; ')}`};
 if(ids.length)return {rows:scope.filter(row=>ids.includes(row.entity_id)),targeted:true};
 const quoted=[...question.matchAll(/[“"「]([^”"」]+)[”"」]/g)].map(match=>norm(match[1]));
 if(quoted.length)return {rows:[],targeted:true,clarification:'I could not uniquely identify that named item. Please provide its exact task title and course code.'};
 if(/\b(?:assignment|homework|quiz|exam|lab|project|task)\s*#?\d+\b/i.test(question))
  return {rows:[],targeted:true,clarification:'I could not uniquely identify that numbered item. Please provide its exact title and course code.'};
 // Keep generic questions permissive, but never turn a named unmatched assignment into a global answer.
 const generic=new Set('what when which are is the my i me do have due deadline deadlines upcoming recent overdue current tasks task assignments assignment events event exams exam policy policies requirement requirements all list show course courses this week next today tomorrow days please tell about a an of for in on and or to how much many dates date grading late submission attendance assessment assessments'.split(' '));
 const remaining=norm(question).split(' ').filter(word=>word&&!generic.has(word)&&!/^\d+$/.test(word)&&
  !(courseIds.length&&[courses.get(courseIds[0])!.code,courses.get(courseIds[0])!.name].some(name=>name.split(' ').includes(word))));
 if(remaining.length&&/\b(task|assignment|quiz|exam|deadline|policy|requirement)\b/i.test(question)&&!/[\p{Script=Han}]/u.test(question))
  return {rows:[],targeted:true,clarification:'I could not uniquely identify that item. Please provide its exact title and course code.'};
 return {rows:scope,targeted:Boolean(courseIds.length)};
}
export function renderCourseFacts(input:CourseFactRow[],question:string,options:CourseFactOptions={},now=new Date()):{answer:string;meta:Record<string,unknown>} {
 if(!question.trim())throw new Error('Course fact question is required');
 const parsed=options.asOf===undefined?now.getTime():factInstant(options.asOf);
 if(parsed===null||!Number.isFinite(parsed))throw new Error('asOf must be an ISO timestamp with an explicit offset');
 const clock=new Date(parsed),historical=Boolean(options.history||options.asOf),all=input.map(normalizeRow);
 const meta:Json={route:'course_facts',deterministic:true,asOf:clock.toISOString(),history:historical,facts:[],citations:[],scope:'owner-global',readTimeValidity:true};
 let rows=historical?all.filter(row=>row.validity_basis==='explicit'&&factInstant(row.valid_from)!==null&&
  factInstant(row.valid_from)!<=parsed&&(factInstant(row.valid_to)===null||factInstant(row.valid_to)!>parsed)):all.filter(row=>row.version===row.current_version);
 if(!historical)rows=rows.filter(row=>!['not_yet_valid','expired'].includes(evaluateFactValidity({validFrom:row.valid_from,
  validTo:row.valid_to,validityBasis:row.validity_basis},clock).time));
 if(historical&&all.some(row=>!rows.some(selected=>selected.fact_id===row.fact_id))){
  meta.historicalCoverage='partial';meta.unsupportedFactIds=[...new Set(all.filter(row=>!rows.some(selected=>selected.fact_id===row.fact_id)).map(row=>row.fact_id))];
 }
 const duplicate=rows.find(row=>rows.filter(other=>other.fact_id===row.fact_id).length>1);
 if(duplicate)return {answer:'The stored fact versions overlap at that time. Please review the conflicting versions before relying on a historical answer.',meta:{...meta,status:'historical_conflict'}};
 const applicableRows=rows;
 const target=bindTargets(rows.length?rows:all,question);
 if(target.clarification)return {answer:target.clarification,meta:{...meta,status:'clarification_required'}};
 const selectedIds=new Set(target.rows.map(row=>`${row.fact_id}:${row.version}`));
 rows=rows.filter(row=>selectedIds.has(`${row.fact_id}:${row.version}`));
 const taskPayloads=new Map(rows.filter(row=>row.attribute==='task_payload').map(row=>[row.entity_id,row]));
 const validity=new Map(rows.map(row=>[row.fact_id,rowValidity(row,clock,applicableRows)]));
 const policy=/polic|requirement|grading|attendance|late submission|政策|要求|评分/i.test(question);
 const exam=/exam|考试/i.test(question),events=/event|calendar|日程|活动/i.test(question);
 rows=rows.filter(row=>policy?['course_policy','course_requirement','course_policies'].includes(row.attribute)||row.attribute.startsWith('course_policy.'):
  exam?row.attribute==='exam'||row.attribute==='event_payload'&&/exam|midterm|考试|期中|期末/i.test(rowTitle(row))||
    row.attribute==='due'&&/exam|midterm|考试|期中|期末/i.test(rowTitle(taskPayloads.get(row.entity_id)??row)):
  events?row.attribute==='event_payload':['due','event_payload','exam','course_policy','course_requirement','course_policies'].includes(row.attribute)||row.attribute.startsWith('course_policy.'));
 if(!historical)rows=rows.filter(row=>{
  const state=validity.get(row.fact_id)!;
  if(state.action==='cancelled')return false;
  return !(state.courseEnded||state.termEnded===true)||row.attribute==='due'&&state.action==='overdue';
 });
 if(!target.targeted&&!policy&&!historical){
  const rangeStart=parsed,rangeEnd=parsed+16*86400000;
  rows=rows.filter(row=>{
   const state=validity.get(row.fact_id)!;
   if(['completed','cancelled','ignored'].includes(state.action))return false;
   if(row.attribute==='due'||record(row.value).kind==='due'||row.attribute==='exam'){
    const due=comparisonDeadline(row,applicableRows),instant=factInstant(due.at);
    const zone=due.timezone||courseTimezone(row,applicableRows)||(instant!==null?'UTC':null);
    const day=instant!==null?factLocalDate(new Date(instant),zone):factCalendarDate(due.date)?due.date:null;
    if(!zone||!day||factLocalDate(clock,zone)===null)return false;
    const bounds=deadlineWindowBounds(zone,parsed);
    return day>=bounds.start&&day<bounds.end;
   }
   if(row.attribute==='event_payload'){const at=factInstant(record(row.value).startAt);return at!==null&&at>=rangeStart&&at<=rangeEnd;}
   return false;
  });
 }
 rows.sort((a,b)=>`${a.course_code||''}:${rowTitle(a)}:${a.attribute}:${a.fact_id}`.localeCompare(`${b.course_code||''}:${rowTitle(b)}:${b.attribute}:${b.fact_id}`));
 const citations=rows.map(citation);
 const identitySources=[...new Map(rows.filter(row=>row.attribute==='due').flatMap(row=>{
  const payload=taskPayloads.get(row.entity_id);return payload?[[payload.fact_id,payload] as const]:[];
 })).values()];
 const identityCitations:Json[]=identitySources.map((row,index)=>({...citation(row,citations.length+index),role:'task_identity'}));
 const facts=rows.map((row,index)=>({factId:row.fact_id,entityId:row.entity_id,attribute:row.attribute,value:row.value,version:row.version,
  courseId:row.course_id,courseCode:row.course_code,validFrom:row.valid_from,validTo:row.valid_to,validity:validity.get(row.fact_id),citationId:citations[index].id,
  ...(row.attribute==='due'&&taskPayloads.has(row.entity_id)?{identityCitationId:identityCitations[identitySources.findIndex(item=>item.entity_id===row.entity_id)]?.id}:{} )}));
 if(!rows.length)return {answer:historical?'No supported canonical fact version is available for that time. Observation timestamps do not establish historical validity.':
  'No matching confirmed course facts are available in the requested scope.',meta:{...meta,status:historical?'history_unsupported':'no_facts'}};
 const titles=new Map(target.rows.filter(row=>row.attribute==='task_payload').map(row=>[row.entity_id,rowTitle(row)]));
 const lines=rows.map((row,index)=>{
  const status=validity.get(row.fact_id)!,labels=[status.action==='overdue'?'overdue':status.action==='unknown'?'time unconfirmed':
   ['completed','cancelled','ignored','ended'].includes(status.action)?status.action:'',status.confirmation==='conflict_pending'?'conflicting update pending review':'',
   status.source==='source_missing'?'source missing':'',status.sourceFreshness==='stale'?'source sync is stale':status.sourceFreshness==='unknown'?'source freshness unknown':'',
   status.sourceVerification==='pending_verification'?'original document changed or is unavailable; verification pending':'',
   status.time==='unknown'?'effective time unconfirmed':''].filter(Boolean);
  const title=row.attribute==='due'?titles.get(row.entity_id)||'Task':row.attribute==='event_payload'?'Event':rowTitle(row);
  return `- ${row.course_code||row.course_name||'Calendar'} · ${title}: ${displayValue(row)}${labels.length?` [${labels.join('; ')}]`:''} [${citations[index].id}]`;
 });
 return {answer:`${historical?`Stored facts applicable at ${clock.toISOString()}`:target.targeted||policy?'Confirmed course facts':'Unfinished overdue tasks (past 7 calendar days) and upcoming course facts (next 16 days)'}:\n${lines.join('\n')}${historical&&meta.historicalCoverage==='partial'?'\nSome facts have no supported historical validity and are omitted.':''}`,
  meta:{...meta,status:'answered',facts,citations:[...citations,...identityCitations]}};
}
export async function answerCourseFacts(db:QueryDb,owner:string,question:string,options:CourseFactOptions={}){
 if(!owner.trim())throw new Error('Course fact owner is required');
 if(question.length>16000)throw new Error('Course fact question is too long');
 const rows=(await db.query<CourseFactRow>(`${FACT_SELECT}
 WHERE n.owner_id=$1 AND n.merged_into IS NULL AND (f.attribute=ANY($2::text[]) OR f.attribute LIKE 'course_policy.%')
 AND ($3::boolean OR (fv.version=f.version AND fv.candidate_id=f.chosen_candidate_id AND fv.value=f.canonical_value))
 ORDER BY f.id,fv.version`,[owner,ATTRIBUTES,Boolean(options.history||options.asOf)])).rows;
 return renderCourseFacts(rows,question,options);
}
export async function refreshCourseFactValidity(db:QueryDb,kind:'hourly'|'daily',now=new Date()){
 if(!['hourly','daily'].includes(kind)||!Number.isFinite(now.getTime()))throw new Error('Invalid validity refresh');
 const evaluatedAt=now.toISOString();
 const rows=(await db.query<CourseFactRow>(`${FACT_SELECT} WHERE fv.version=f.version AND n.merged_into IS NULL
 AND fv.candidate_id=f.chosen_candidate_id AND fv.value=f.canonical_value
 AND (f.attribute=ANY($1::text[]) OR f.attribute LIKE 'course_policy.%') ORDER BY f.id`,[ATTRIBUTES])).rows.map(normalizeRow);
 for(const row of rows)await db.query(`INSERT INTO course_fact_validity_projection(fact_id,fact_version,evaluated_at,refresh_kind,validity)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(fact_id) DO UPDATE SET fact_version=excluded.fact_version,
 evaluated_at=excluded.evaluated_at,refresh_kind=excluded.refresh_kind,validity=excluded.validity
 WHERE course_fact_validity_projection.evaluated_at<=excluded.evaluated_at`,
 [row.fact_id,row.version,evaluatedAt,kind,JSON.stringify(rowValidity(row,now,rows))]);
 return {refreshed:rows.length,evaluatedAt,kind};
}
