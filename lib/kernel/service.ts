import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CanvasSource, ExtractedAnalysis } from '../domain.ts';
import { kernelPool, kernelTransaction } from './db.ts';
import { canvasTaskIdentity, canvasTaskReference } from './task-identity.ts';
import { documentSearchText, splitDocumentText, searchDocumentText } from './document-search.ts';

type Json = Record<string, unknown>;
type CandidateInput = {
  entityId: string; attribute: string; value: unknown; sourceVersionId: string;
  source: string; sourceItemId: string; originalExcerpt: string;
  confidence: number; authority: string; locator: string;
  acquiredAt: string; publishedAt?: string | null; validFrom?: string | null;
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
  if (!match || !Number.isFinite(Date.parse(raw))) return { date: null, at: null, localTime: null, timezone: null, precision: null, original: raw };
  const precision = match[4] !== undefined ? 'second' : match[3] !== undefined ? 'minute' : 'hour';
  const instant = new Date(raw).toISOString();
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
    `INSERT INTO candidate_facts(id,entity_id,attribute,value,evidence_id,status,authority)
     VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT(id) DO NOTHING`,
    [candidateId,input.entityId,input.attribute,JSON.stringify(input.value),evidenceId,input.authority]);
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
      code: course.course_code ?? course.code ?? course.name ?? id, termName,
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
          const due=parseDeadline(rawDue);
          await recordCandidate(client,{entityId,attribute:'due',value:due,sourceVersionId:version,source:provenance,
            sourceItemId:source.id,originalExcerpt:rawDue,confidence:source.dueAt?1:0.5,
            authority:source.dueAt&&due.precision?provenance:'ai',
            locator:deterministic?`due:${index}`:`ai_due:${index}:${stableId(JSON.stringify(due))}`,
            acquiredAt,publishedAt:source.updatedAt});
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
            const due=parseDeadline(aiAction.inferredDueAt);
            await recordCandidate(client,{entityId,attribute:'due',value:due,sourceVersionId:version,
              source:provenance,sourceItemId:source.id,originalExcerpt:(aiAction.evidence||aiAction.inferredDueAt).slice(0,2000),
              confidence:0.5,authority:'ai',
              locator:`ai_due:${index}:${aiIndex}:${stableId(JSON.stringify(due))}`,
              acquiredAt,publishedAt:source.updatedAt});
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
      if(row.due_at){const due=parseDeadline(String(row.due_at));await recordCandidate(client,{entityId,attribute:'due',
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

  async ingestParsedDocument(document: {id:string;ownerId?:string;createdAt?:string;courseId:string;name:string;hash:string;mime:string;origin:string;originKey:string},
    inputPages: Array<{locator:string;text:string;pageNumber?:number}>,
    options:{parserVersion?:string;expectedPages?:number;warnings?:string[];extractionMethod?:string}={}) {
    const pages=inputPages.map((page,index)=>({...page,pageNumber:page.pageNumber??index+1}));
    const expected=options.expectedPages??pages.length;
    if(!Number.isInteger(expected)||expected<1||pages.length!==expected||
      pages.some((page,index)=>page.pageNumber!==index+1||typeof page.text!=='string'||!page.locator)||
      !pages.some(page=>page.text.trim()))throw new Error('Document transcription is incomplete');
    const parser=options.parserVersion||'docling-v1',owner=document.ownerId||'local-owner';
    const textHash=stableId(JSON.stringify(pages));
    const parsedVersion=stableId(document.id,parser,textHash);
    const sourceItemId=`document:${document.id}`,acquiredAt=new Date().toISOString();
    await kernelTransaction(async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`document:${document.id}`]);
      const version=await sourceVersion(client,{id:sourceItemId,source:`document:${document.origin}`,scope:document.courseId||'unscoped',
        externalId:document.id,courseId:document.courseId||null,
        contentHash:stableId(document.hash,parser,textHash),raw:{id:document.id,name:document.name,mime:document.mime,
          originKey:document.originKey,parser,extractionMethod:options.extractionMethod||parser,warnings:options.warnings||[],
          pages:pages.map(page=>({locator:page.locator,pageNumber:page.pageNumber,length:page.text.length}))},
        rawUri:`library://${document.hash}`,rawSha256:document.hash,acquiredAt});
      await client.query(`INSERT INTO document_texts(id,owner_id,course_id,source_item_id,origin,origin_key,name,source_hash,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO UPDATE SET name=excluded.name`,
        [document.id,owner,document.courseId||null,sourceItemId,document.origin,document.originKey,document.name,document.hash,document.createdAt||acquiredAt]);
      const existing=(await client.query<{owner_id:string;source_hash:string}>(
        'SELECT owner_id,source_hash FROM document_texts WHERE id=$1',[document.id])).rows[0];
      if(existing.owner_id!==owner||existing.source_hash!==document.hash)throw new Error('Document identity mismatch');
      await client.query(`INSERT INTO document_text_versions(id,document_id,source_version_id,parser_version,text_hash,page_count,warnings)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
        [parsedVersion,document.id,version,parser,textHash,expected,JSON.stringify(options.warnings||[])]);
      let position=0;
      for(const [index,page] of pages.entries()){
        const evidenceId=stableId(version,`page:${index}`);
        await client.query(
          `INSERT INTO evidence(id,source_version_id,source,source_item_id,acquired_at,original_excerpt,
            parsed_value,confidence,locator) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
          [evidenceId,version,`document:${document.origin}`,sourceItemId,acquiredAt,page.text.slice(0,4000),
            JSON.stringify({textLength:page.text.length,parser,extractionMethod:options.extractionMethod||parser,documentVersion:parsedVersion,pageNumber:page.pageNumber}),0.9,page.locator]);
        await client.query(`INSERT INTO document_text_pages(version_id,page_number,evidence_id,locator,body,search_text)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(version_id,page_number) DO NOTHING`,
          [parsedVersion,page.pageNumber,evidenceId,page.locator,page.text,documentSearchText(page.text)]);
        for(const body of splitDocumentText(page.text)){
          await client.query(`INSERT INTO document_text_chunks(id,version_id,page_number,position,body,search_text)
            VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
            [stableId(parsedVersion,String(position)),parsedVersion,page.pageNumber,position,body,documentSearchText(body)]);
          position++;
        }
      }
      await client.query(`UPDATE document_texts SET current_version_id=$2,indexed_at=now() WHERE id=$1`,[document.id,parsedVersion]);
    });
  }

  searchDocumentText(owner:string,query:string,options:{courseId?:string;documentId?:string;limit?:number;strict?:boolean;semantic?:boolean;aiRerank?:boolean}={}) {
    return searchDocumentText(kernelPool(),owner,query,options);
  }

  async documentTextHeads(owner:string){
    return (await kernelPool().query<{id:string;source_hash:string}>(
      'SELECT id,source_hash FROM document_texts WHERE owner_id=$1 AND hidden=false AND current_version_id IS NOT NULL',[owner])).rows;
  }

  async parsedDocument(owner:string,id:string) {
    const rows=(await kernelPool().query<{page_number:number;locator:string;body:string;parser_version:string;warnings:string[];extraction_method:string}>(`
      SELECT p.page_number,p.locator,p.body,v.parser_version,v.warnings,s.raw_value->>'extractionMethod' extraction_method FROM document_texts d
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
    return kernelTransaction(async client=>{
      const version=(await client.query<{current_version_id:string}>(
        'SELECT current_version_id FROM document_texts WHERE owner_id=$1 AND id=$2 FOR UPDATE',[owner,id])).rows[0]?.current_version_id;
      if(!version)throw new Error('Document transcription not found');
      const pages=(await client.query<{page_number:number;body:string}>(
        'SELECT page_number,body FROM document_text_pages WHERE version_id=$1 ORDER BY page_number',[version])).rows;
      await client.query('DELETE FROM document_text_chunks WHERE version_id=$1',[version]);
      let position=0;
      for(const page of pages){
       await client.query('UPDATE document_text_pages SET search_text=$3 WHERE version_id=$1 AND page_number=$2',
        [version,page.page_number,documentSearchText(page.body)]);
       for(const body of splitDocumentText(page.body)){
        await client.query(`INSERT INTO document_text_chunks(id,version_id,page_number,position,body,search_text)
          VALUES ($1,$2,$3,$4,$5,$6)`,[stableId(version,String(position)),version,page.page_number,position,body,documentSearchText(body)]);
        position++;
       }
      }
      return {documentId:id,chunks:position};
    });
  }

  async ingestMailAnalysis(mail: {id:string;account:string;sender:string;subject:string;body:string;
    receivedAt:string;hash:string}, analysis: {deadlines:Array<{at:string|null;text:string;confidence:number;evidence:string}>;
      referencedUrls?:string[];actionItems?:Array<{title:string;description:string;evidence:string;confidence:number}>}) {
    const acquiredAt=new Date().toISOString(),sourceItemId=`gmail:${mail.account}:${mail.id}`;
    await kernelTransaction(async client=>{
      const version=await sourceVersion(client,{id:sourceItemId,source:'gmail',scope:mail.account,
        externalId:mail.id,contentHash:mail.hash,raw:{subject:mail.subject,sender:mail.sender,
          receivedAt:mail.receivedAt,bodyHash:mail.hash},rawUri:`sqlite-mail://${mail.account}/${mail.id}`,
        rawSha256:mail.hash,acquiredAt,publishedAt:mail.receivedAt});
      const urls=analysis.referencedUrls||[];
      let matchedTask:{entity_id:string}|undefined;
      if(urls.length){
        const matches=(await client.query<{entity_id:string}>(
          'SELECT entity_id FROM tasks WHERE source_url=ANY($1::text[]) LIMIT 2',[urls])).rows;
        if(matches.length===1)matchedTask=matches[0];
      }
      for(const [index,claim] of analysis.deadlines.entries()){
        if(!claim.at)continue;
        const entityId=matchedTask?.entity_id||stableId('mail_claim',sourceItemId,String(index));
        if(!matchedTask)await entity(client,entityId,'mail_claim',`${sourceItemId}:${index}`,null,null);
        const due=parseDeadline(claim.at);
        await recordCandidate(client,{entityId,attribute:'due',value:due,sourceVersionId:version,
          source:'gmail',sourceItemId,originalExcerpt:(claim.evidence||claim.text).slice(0,4000),
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
