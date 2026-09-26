import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CanvasSource, ExtractedAnalysis } from '../domain.ts';
import { kernelPool, kernelTransaction } from './db.ts';

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
const safeDate = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

export type Deadline = {
  date: string | null; at: string | null; localTime: string | null;
  timezone: string | null; precision: 'date' | 'hour' | 'minute' | 'second' | null;
  original: string | null;
};

export function parseDeadline(raw: string | null, timezone: string | null = null): Deadline {
  if (!raw) return { date: null, at: null, localTime: null, timezone: null, precision: null, original: null };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  if (date) return { date, at: null, localTime: null, timezone: null, precision: 'date', original: raw };
  // Only an explicit offset or Z establishes an instant. A local time without a zone stays a candidate.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})(?::(\d{2}))?(?::(\d{2})(?:\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/.exec(raw);
  if (!match || !Number.isFinite(Date.parse(raw))) return { date: null, at: null, localTime: null, timezone: null, precision: null, original: raw };
  const precision = match[4] !== undefined ? 'second' : match[3] !== undefined ? 'minute' : 'hour';
  const instant = new Date(raw).toISOString();
  // Without a trusted course zone, normalize the explicit instant to the IANA UTC zone.
  // The source's offset and wording remain in original for later interpretation.
  return { date: instant.slice(0,10), at: instant, localTime: instant.slice(11,19), timezone: timezone ?? 'Etc/UTC', precision, original: raw };
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
  const candidate = (await client.query<{entity_id:string;attribute:string;value:unknown;evidence_id:string}>(
    'SELECT entity_id,attribute,value,evidence_id FROM candidate_facts WHERE id=$1 FOR UPDATE', [candidateId])).rows[0];
  if (!candidate) throw new Error('Candidate not found');
  const factId = stableId(candidate.entity_id,candidate.attribute);
  const previous = (await client.query<{version:number}>(
    'SELECT version FROM facts WHERE id=$1 FOR UPDATE', [factId])).rows[0];
  const version = (previous?.version ?? 0) + 1;
  await client.query(
    `INSERT INTO facts(id,entity_id,attribute,canonical_value,chosen_candidate_id,version)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
     canonical_value=excluded.canonical_value,chosen_candidate_id=excluded.chosen_candidate_id,
     version=excluded.version,updated_at=now()`,
    [factId,candidate.entity_id,candidate.attribute,JSON.stringify(candidate.value),candidateId,version]);
  await client.query(
    `INSERT INTO fact_versions(fact_id,version,value,candidate_id,reason)
     VALUES ($1,$2,$3,$4,$5)`, [factId,version,JSON.stringify(candidate.value),candidateId,reason]);
  await client.query('UPDATE candidate_facts SET status=\'accepted\',reason=$2,decided_at=now() WHERE id=$1', [candidateId,reason]);
  await client.query('INSERT INTO fact_evidence(fact_id,evidence_id,candidate_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
    [factId,candidate.evidence_id,candidateId]);
}

async function recordCandidate(client: PoolClient, input: CandidateInput): Promise<string> {
  await client.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE',[input.entityId]);
  const evidenceId = stableId(input.sourceVersionId,input.locator);
  await client.query(
    `INSERT INTO evidence(id,source_version_id,source,source_item_id,acquired_at,published_at,original_excerpt,
      parsed_value,confidence,valid_from,locator)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
    [evidenceId,input.sourceVersionId,input.source,input.sourceItemId,input.acquiredAt,safeDate(input.publishedAt),
      input.originalExcerpt,JSON.stringify(input.value),input.confidence,safeDate(input.validFrom),input.locator]);
  const candidateId = stableId(input.entityId,input.attribute,evidenceId);
  await client.query(
    `INSERT INTO candidate_facts(id,entity_id,attribute,value,evidence_id,status,authority)
     VALUES ($1,$2,$3,$4,$5,'pending',$6) ON CONFLICT(id) DO NOTHING`,
    [candidateId,input.entityId,input.attribute,JSON.stringify(input.value),evidenceId,input.authority]);
  const existing = (await client.query<{id:string;canonical_value:unknown;chosen_candidate_id:string}>(
    'SELECT id,canonical_value,chosen_candidate_id FROM facts WHERE entity_id=$1 AND attribute=$2 FOR UPDATE',
    [input.entityId,input.attribute])).rows[0];
  const status = (await client.query<{status:string}>('SELECT status FROM candidate_facts WHERE id=$1',[candidateId])).rows[0].status;
  if (status !== 'pending') return candidateId;
  if (existing && JSON.stringify(existing.canonical_value) === JSON.stringify(input.value)) {
    await client.query('UPDATE candidate_facts SET status=\'accepted\',reason=\'corroborating evidence\',decided_at=now() WHERE id=$1',[candidateId]);
    await client.query('INSERT INTO fact_evidence(fact_id,evidence_id,candidate_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [existing.id,evidenceId,candidateId]);
    return candidateId;
  }
  if (!existing && ['canvas','verified_official','legacy_import','calendar_import'].includes(input.authority)) {
    await acceptCandidate(client,candidateId,'first validated evidence');
    return candidateId;
  }
  if (existing && ['canvas','calendar_import'].includes(input.authority)) {
    const prior = (await client.query<{source:string;remote_updated_at:Date|null}>(
      `SELECT e.source,v.remote_updated_at FROM candidate_facts c JOIN evidence e ON e.id=c.evidence_id
       JOIN source_item_versions v ON v.id=e.source_version_id WHERE c.id=$1`,[existing.chosen_candidate_id])).rows[0];
    if (prior?.source === 'legacy_import' && input.authority === 'canvas') {
      await acceptCandidate(client,candidateId,'current Canvas evidence supersedes legacy import');
    } else if (input.authority === 'calendar_import' && prior?.source === 'calendar_import') {
      await acceptCandidate(client,candidateId,'new explicitly imported calendar version');
    } else if (prior?.source === 'canvas' && safeDate(input.publishedAt) && prior.remote_updated_at &&
      Date.parse(input.publishedAt!) > prior.remote_updated_at.getTime()) {
      await acceptCandidate(client,candidateId,'newer Canvas version');
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

async function projectTask(client: PoolClient, entityId: string, sourceItemId: string): Promise<void> {
  const result = await client.query<{attribute:string;canonical_value:unknown}>(
    'SELECT attribute,canonical_value FROM facts WHERE entity_id=$1',[entityId]);
  const facts = Object.fromEntries(result.rows.map(row=>[row.attribute,row.canonical_value]));
  const payload = facts.task_payload as Json | undefined;
  if (!payload) return;
  const existingTask=(await client.query<{id:string;source_item_id:string}>(
    'SELECT id,source_item_id FROM tasks WHERE entity_id=$1',[entityId])).rows[0];
  const due = (facts.due as Deadline | undefined) ?? parseDeadline(null);
  const cancelled = facts.cancelled === true;
  await client.query(
    `INSERT INTO tasks(id,entity_id,course_id,source_item_id,source_type,source_id,source_url,title,action,requirements,
      start_at,due_date,due_at,due_local_time,due_timezone,due_precision,due_original,unlock_at,lock_at,canvas_status,
      urgency,confidence,evidence_excerpt,estimated_minutes,points_possible,prerequisite_blocked,cancelled_at,source_missing)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
       CASE WHEN $27::boolean THEN now() ELSE NULL END,false)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title,action=excluded.action,requirements=excluded.requirements,
       start_at=excluded.start_at,due_date=excluded.due_date,due_at=excluded.due_at,due_local_time=excluded.due_local_time,
       due_timezone=excluded.due_timezone,due_precision=excluded.due_precision,due_original=excluded.due_original,
       unlock_at=excluded.unlock_at,lock_at=excluded.lock_at,canvas_status=excluded.canvas_status,
       urgency=excluded.urgency,confidence=excluded.confidence,evidence_excerpt=excluded.evidence_excerpt,
       estimated_minutes=excluded.estimated_minutes,points_possible=excluded.points_possible,
       prerequisite_blocked=excluded.prerequisite_blocked,cancelled_at=excluded.cancelled_at,
       source_missing=false,updated_at=now()`,
    [existingTask?.id||String(payload.id),entityId,payload.courseId,existingTask?.source_item_id||sourceItemId,
      payload.sourceType,payload.sourceId,payload.sourceUrl,
      payload.title,payload.action,JSON.stringify(payload.requirements ?? []),safeDate(payload.startAt),due.date,due.at,
      due.localTime,due.timezone,due.precision,due.original,safeDate(payload.unlockAt),safeDate(payload.lockAt),
      cancelled ? 'possibly_superseded' : payload.canvasStatus,payload.urgency,payload.confidence,payload.evidence,
      payload.estimatedMinutes,payload.pointsPossible,payload.prerequisiteBlocked,cancelled]);
}

export class KernelService {
  async upsertCourse(course: Json, source = 'canvas'): Promise<void> {
    const id = String(course.id);
    const term = course.term as Json | undefined;
    const termName = String(term?.name ?? course.term_name ?? '').trim();
    const termId = termName ? `term:${String(term?.id ?? termName).toLowerCase()}` : null;
    const raw = { id, termId, name: course.name ?? course.course_code ?? '未命名课程', enabled: course.enabled !== false,
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
        sourceItemId:sourceId,originalExcerpt:JSON.stringify(raw),confidence:1,authority:source==='canvas'?'canvas':'legacy_import',
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
    const raw={...source,analysis};
    await kernelTransaction(async client => {
      const version=await sourceVersion(client,{id:source.id,source:'canvas',scope:source.courseId,
        externalId:`${source.sourceType}:${source.sourceId}`,courseId:source.courseId,sourceUrl:source.sourceUrl,
        contentHash:provenance==='legacy_import'?`legacy:${hash}`:hash,raw,acquiredAt,remoteUpdatedAt:source.updatedAt});
      const actions=analysis?.actions?.length ? analysis.actions :
        source.sourceType==='assignment' || source.dueAt ? [{title:source.title,action:`完成并提交 ${source.title}`,
          requirements:[],recommendedStartAt:null,inferredDueAt:null,confidence:'certain' as const,
          evidence:source.body.slice(0,220),estimatedMinutes:null,possiblyCancelled:false}] : [];
      for (const [index,action] of actions.entries()) {
        const identityKey=source.sourceUrl && ['assignment','quiz','planner'].includes(source.sourceType)
          ? `${source.courseId}|${source.sourceUrl.replace(/\?.*$/,'')}` : `${source.courseId}|${source.sourceType}|${source.sourceId}|${index}`;
        const entityId=stableId('task',identityKey);
        await entity(client,entityId,'task',identityKey,source.courseId,null);
        const deterministic=source.sourceType==='assignment' || Boolean(source.dueAt);
        const payload={id:`${source.id}:${index}`,courseId:source.courseId,sourceType:source.sourceType,
          sourceId:source.sourceId,sourceUrl:source.sourceUrl,title:action.title || source.title,action:action.action,
          requirements:action.requirements,startAt:action.recommendedStartAt,unlockAt:source.unlockAt,lockAt:source.lockAt,
          canvasStatus:source.submissionState==='submitted'?'completed':'upcoming',urgency:'upcoming',
          confidence:action.confidence,evidence:action.evidence || '',estimatedMinutes:action.estimatedMinutes,
          pointsPossible:source.pointsPossible ?? null,prerequisiteBlocked:Boolean(source.prerequisiteBlocked)};
        await recordCandidate(client,{entityId,attribute:'task_payload',value:payload,sourceVersionId:version,
          source:provenance,sourceItemId:source.id,originalExcerpt:source.body.slice(0,2000)||source.title,
          confidence:deterministic?1:0.5,authority:deterministic?provenance:'ai',locator:`task_payload:${index}`,
          acquiredAt,publishedAt:source.updatedAt});
        const rawDue=source.dueAt || action.inferredDueAt;
        if (rawDue) {
          const due=parseDeadline(rawDue);
          await recordCandidate(client,{entityId,attribute:'due',value:due,sourceVersionId:version,source:provenance,
            sourceItemId:source.id,originalExcerpt:rawDue,confidence:source.dueAt?1:0.5,
            authority:source.dueAt&&due.precision?provenance:'ai',locator:`due:${index}`,acquiredAt,publishedAt:source.updatedAt});
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
        authority:'legacy_import',locator:`task_payload:${id}`,acquiredAt});
      if(row.due_at){const due=parseDeadline(String(row.due_at));await recordCandidate(client,{entityId,attribute:'due',
        value:due,sourceVersionId:version,source:'legacy_import',sourceItemId,originalExcerpt:String(row.due_at),
        confidence:0.8,authority:due.precision?'legacy_import':'ai',locator:`due:${id}`,acquiredAt});}
      await projectTask(client,entityId,sourceItemId);
      if(override && ['active','completed','ignored'].includes(override)){
        await recordCandidate(client,{entityId,attribute:'local_status',value:override,sourceVersionId:version,
          source:'legacy_import',sourceItemId,originalExcerpt:JSON.stringify({taskId:id,override}),
          confidence:1,authority:'legacy_import',locator:`local_status:${id}`,acquiredAt});
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
      if(!row.is_active)await client.query(
        `UPDATE source_items SET state='missing',missing_at=$2 WHERE id=$1`,[id,safeDate(row.missing_at)??acquiredAt]);
    });
  }

  async ingestParsedDocument(document: {id:string;courseId:string;name:string;hash:string;mime:string;origin:string;originKey:string}, pages: Array<{locator:string;text:string}>) {
    const sourceItemId=`document:${document.id}`,acquiredAt=new Date().toISOString();
    await kernelTransaction(async client=>{
      const version=await sourceVersion(client,{id:sourceItemId,source:`document:${document.origin}`,scope:document.courseId||'unscoped',
        externalId:document.originKey||document.id,courseId:document.courseId||null,
        contentHash:stableId(document.hash,'docling-v1'),raw:{id:document.id,name:document.name,mime:document.mime,
          pages:pages.map(page=>({locator:page.locator,length:page.text.length}))},
        rawUri:`library://${document.hash}`,rawSha256:document.hash,acquiredAt});
      for(const [index,page] of pages.entries()){
        const evidenceId=stableId(version,`page:${index}`);
        await client.query(
          `INSERT INTO evidence(id,source_version_id,source,source_item_id,acquired_at,original_excerpt,
            parsed_value,confidence,locator) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
          [evidenceId,version,`document:${document.origin}`,sourceItemId,acquiredAt,page.text.slice(0,4000),
            JSON.stringify({textLength:page.text.length,parser:'docling-v1'}),0.9,page.locator]);
      }
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

  async completeSourceScan(source: string, scope: string, seenIds: string[], cursor: string | null = null): Promise<number> {
    return kernelTransaction(async client => {
      const current=await client.query<{id:string}>(
        `SELECT id FROM source_items WHERE source=$1 AND scope=$2 AND state='active' FOR UPDATE`,[source,scope]);
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

  async taskRows(courseId?: string) {
    const result=await kernelPool().query(
      `SELECT t.*,c.code course_code,c.name course_name,'complete' analysis_status
       FROM tasks t JOIN courses c ON c.id=t.course_id
       WHERE c.enabled=true AND t.local_status!='ignored' AND ($1::text IS NULL OR t.course_id=$1)
       ORDER BY t.due_at NULLS LAST,t.due_date NULLS LAST`,[courseId ?? null]);
    return result.rows.map(row=>({ ...row,requirements_json:JSON.stringify(row.requirements),
      evidence:row.evidence_excerpt,local_status:row.local_status,points_possible:row.points_possible==null?null:Number(row.points_possible),
      prerequisite_blocked:Number(row.prerequisite_blocked),start_at:iso(row.start_at),due_date:dateOnly(row.due_date),
      due_at:iso(row.due_at)??dateOnly(row.due_date),
      unlock_at:iso(row.unlock_at),lock_at:iso(row.lock_at),updated_at:iso(row.updated_at) }));
  }

  async taskTarget(taskId: string) {
    return (await kernelPool().query<{source_type:string;source_id:string}>(
      'SELECT source_type,source_id FROM tasks WHERE id=$1',[taskId])).rows[0] ?? null;
  }

  async setTaskStatus(taskId: string, status: 'active'|'completed'|'ignored', syncCanvas=false) {
    await kernelTransaction(async client => {
      const task=(await client.query<{entity_id:string;source_item_id:string}>(
        'SELECT entity_id,source_item_id FROM tasks WHERE id=$1 FOR UPDATE',[taskId])).rows[0];
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
      await client.query('UPDATE tasks SET local_status=$2,updated_at=now() WHERE id=$1',[taskId,status]);
      if(syncCanvas && status!=='ignored')await client.query(
        `INSERT INTO kernel_outbox(id,kind,payload,idempotency_key) VALUES ($1,'canvas_task_status',$2,$3)
         ON CONFLICT(idempotency_key) DO NOTHING`,
        [randomUUID(),JSON.stringify({taskId,status}),`canvas_task_status:${taskId}:${status}:${acquiredAt}`]);
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

  async pendingCandidates() {
    return (await kernelPool().query(
      `SELECT c.id,c.entity_id,c.attribute,c.value,c.authority,c.created_at,e.source,e.original_excerpt,
       f.canonical_value FROM candidate_facts c JOIN evidence e ON e.id=c.evidence_id
       LEFT JOIN facts f ON f.entity_id=c.entity_id AND f.attribute=c.attribute
       WHERE c.status='pending' ORDER BY c.created_at LIMIT 100`)).rows;
  }

  async candidate(id: string) {
    return (await kernelPool().query(
      `SELECT c.*,e.source,e.original_excerpt,e.acquired_at,e.published_at,e.confidence,
       f.canonical_value FROM candidate_facts c JOIN evidence e ON e.id=c.evidence_id
       LEFT JOIN facts f ON f.entity_id=c.entity_id AND f.attribute=c.attribute WHERE c.id=$1`,[id])).rows[0] ?? null;
  }

  async adjudicate(id: string, decision: 'accept'|'reject', reason: string, actor: string) {
    if (!reason.trim() || !actor.trim()) throw new Error('Actor and reason are required');
    await kernelTransaction(async client => {
      const candidate=(await client.query<{entity_id:string;attribute:string;value:unknown;status:string}>(
        'SELECT entity_id,attribute,value,status FROM candidate_facts WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!candidate || candidate.status!=='pending') throw new Error('Candidate is not pending');
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
}

export const kernel = new KernelService();
