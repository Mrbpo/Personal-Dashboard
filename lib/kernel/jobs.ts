import { randomUUID } from 'node:crypto';
import { kernelPool, kernelTransaction } from './db.ts';
import type {DoclingProgress} from './docling-batches.ts';

export type IngestionJob = { id: string; kind: string; source: string; scope: string; payload: unknown; attempts: number; lease_token: string };

export async function queueIngestionJob(kind: string, source: string, scope: string, payload: unknown, idempotencyKey: string, reviveTerminal=false): Promise<string> {
  const id = randomUUID();
  const result = await kernelPool().query<{ id: string }>(
    `INSERT INTO ingestion_jobs(id,kind,source,scope,payload,idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO UPDATE SET
     updated_at=now(),payload=CASE WHEN $7::boolean AND ingestion_jobs.state IN ('complete','failed')
       THEN excluded.payload || CASE WHEN ingestion_jobs.kind='docling_document'
         AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['owner','id','sourceHash','formulaEnriched','formulaBackend','scanBackend']) AS settings(key)
           WHERE (ingestion_jobs.payload->key) IS DISTINCT FROM (excluded.payload->key))
         THEN jsonb_strip_nulls(jsonb_build_object('doclingProgress',ingestion_jobs.payload->'doclingProgress',
           'doclingTaskId',ingestion_jobs.payload->'doclingTaskId')) ELSE '{}'::jsonb END
       ELSE ingestion_jobs.payload END,
     state=CASE WHEN $7::boolean AND ingestion_jobs.state IN ('complete','failed')
       THEN 'queued' ELSE ingestion_jobs.state END,
     attempts=CASE WHEN $7::boolean AND ingestion_jobs.state IN ('complete','failed')
       THEN 0 ELSE ingestion_jobs.attempts END,
     available_at=CASE WHEN $7::boolean AND ingestion_jobs.state IN ('complete','failed')
       THEN now() ELSE ingestion_jobs.available_at END,
     last_error=CASE WHEN $7::boolean AND ingestion_jobs.state IN ('complete','failed')
       THEN NULL ELSE ingestion_jobs.last_error END RETURNING id`,
    [id, kind, source, scope, JSON.stringify(payload), idempotencyKey, reviveTerminal]);
  return result.rows[0].id;
}

export async function listIngestionJobs(){
  const rows=(await kernelPool().query(
    `SELECT id,kind,state status,attempts,last_error error,
      floor(extract(epoch from updated_at)*1000)::bigint updated_at
     FROM ingestion_jobs ORDER BY updated_at DESC LIMIT 60`)).rows;
  return rows.map(row=>({...row,updated_at:Number(row.updated_at)}));
}

export async function retryIngestionJob(id:string):Promise<boolean>{
  const result=await kernelPool().query(
    `UPDATE ingestion_jobs SET state='queued',attempts=0,last_error=NULL,available_at=now(),
      lease_until=NULL,lease_token=NULL,updated_at=now() WHERE id=$1 AND state='failed'`,[id]);
  return result.rowCount===1;
}

export async function hasRunningIngestionJob(kind:string):Promise<boolean>{
  return (await kernelPool().query(
    `SELECT 1 FROM ingestion_jobs WHERE kind=$1 AND state='running' AND lease_until>now() LIMIT 1`,[kind])).rowCount===1;
}

export async function claimIngestionJob(jobId?:string,excludeKinds:string[]=[]): Promise<IngestionJob | null> {
  return kernelTransaction(async client => {
    const result = await client.query<IngestionJob>(
      `SELECT id,kind,source,scope,payload,attempts FROM ingestion_jobs
       WHERE ((state='queued' AND available_at<=now()) OR (state='running' AND lease_until<now()))
         AND ($1::text IS NULL OR id=$1)
         AND NOT(kind=ANY($2::text[]))
       ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,[jobId??null,excludeKinds]);
    const job = result.rows[0];
    if (!job) return null;
    const token = randomUUID();
    await client.query(
      `UPDATE ingestion_jobs SET state='running',lease_token=$2,lease_until=now()+interval '3 minutes',
       attempts=attempts+1,updated_at=now() WHERE id=$1`, [job.id, token]);
    if(['canvas','canvas-course','gmail','piazza'].includes(job.kind))await client.query(
      `INSERT INTO source_status(source,scope,last_started_at,state) VALUES ($1,$2,now(),'running')
       ON CONFLICT(source,scope) DO UPDATE SET last_started_at=now(),state='running'`,
      [job.source,job.scope]);
    return { ...job, attempts: job.attempts + 1, lease_token: token };
  });
}

/** The refused provider request was not attempted. Preserve earlier completed checkpoints and prior failures,
 * release this lease and undo only this claim's attempt increment. */
export async function deferIngestionJob(id:string,token:string,retryAt:Date,reason:string):Promise<boolean>{
  if(!Number.isFinite(retryAt.getTime()))throw new Error('Invalid budget deferral time');
  return kernelTransaction(async client=>{
    const saved=await client.query<{kind:string;source:string;scope:string}>(`UPDATE ingestion_jobs SET state='queued',
      available_at=GREATEST($3::timestamptz,now()+interval '1 minute')+interval '3 seconds',
      attempts=GREATEST(0,attempts-1),last_error=$4,lease_token=NULL,lease_until=NULL,updated_at=now()
      WHERE id=$1 AND lease_token=$2 AND state='running' AND lease_until>now() RETURNING kind,source,scope`,
      [id,token,retryAt.toISOString(),`AI_BUDGET_DEFERRED:${reason}`]);
    const job=saved.rows[0];
    if(job&&['canvas','canvas-course','gmail','piazza'].includes(job.kind))await client.query(
      `UPDATE source_status SET state='deferred',last_error=$3 WHERE source=$1 AND scope=$2`,
      [job.source,job.scope,`AI_BUDGET_DEFERRED:${reason}`]);
    return Boolean(job);
  });
}

export async function renewIngestionJob(id: string, token: string, stage?: string): Promise<boolean> {
  const result = await kernelPool().query(
    `UPDATE ingestion_jobs SET stage=COALESCE($3,stage),lease_until=now()+interval '3 minutes',updated_at=now()
     WHERE id=$1 AND lease_token=$2 AND state='running'`, [id, token, stage??null]);
  return result.rowCount === 1;
}

export async function rememberDoclingTask(id:string,token:string,taskId:string|null):Promise<void>{
  const saved=await kernelPool().query(`UPDATE ingestion_jobs SET payload=CASE WHEN $3::text IS NULL
    THEN payload-'doclingTaskId' ELSE jsonb_set(payload,'{doclingTaskId}',to_jsonb($3::text)) END,
    stage='remote_parse',updated_at=now() WHERE id=$1 AND lease_token=$2 AND kind='docling_document' AND state='running' AND lease_until>now()`,[id,token,taskId]);
  if(saved.rowCount!==1)throw new Error('PDF ingestion lease lost');
}

export async function doclingJobPayload(id:string,token:string):Promise<Record<string,unknown>>{
  const row=(await kernelPool().query<{payload:Record<string,unknown>}>(`SELECT payload FROM ingestion_jobs
    WHERE id=$1 AND lease_token=$2 AND kind='docling_document' AND state='running' AND lease_until>now()`,[id,token])).rows[0];
  if(!row)throw new Error('PDF ingestion lease lost');
  return row.payload;
}
export async function rememberDoclingProgress(id:string,token:string,progress:DoclingProgress):Promise<void>{
  const result=await kernelPool().query(`UPDATE ingestion_jobs SET payload=jsonb_set(payload,'{doclingProgress}',$3::jsonb),
    stage=$4,updated_at=now() WHERE id=$1 AND lease_token=$2 AND kind='docling_document' AND state='running' AND lease_until>now()
      AND payload->>'owner'=$5 AND payload->>'id'=$6
      AND (payload->>'sourceHash' IS NULL OR payload->>'sourceHash'=$7)`,
    [id,token,JSON.stringify(progress),`remote_parse:${progress.batches.filter(batch=>batch.resultHash).length}/${progress.batches.length}`,
      progress.identity.owner,progress.identity.documentId,progress.identity.sourceHash]);
  if(result.rowCount!==1)throw new Error('PDF ingestion lease or source identity lost');
}
export async function doclingStageBlobHashes():Promise<string[]>{
  const rows=(await kernelPool().query<{payload:{owner:string;id:string;sourceHash?:string;doclingProgress:DoclingProgress}}>(
    `SELECT payload FROM ingestion_jobs WHERE kind='docling_document' AND payload ? 'doclingProgress'`)).rows;
  const {parsingProvenanceBlobHashes}=await import('./docling-batches.ts'),hashes=new Set<string>();
  for(const {payload} of rows)for(const hash of await parsingProvenanceBlobHashes(payload.doclingProgress,
    {owner:payload.owner,documentId:payload.id,sourceHash:payload.sourceHash??payload.doclingProgress?.identity?.sourceHash,
     totalPages:payload.doclingProgress?.identity?.totalPages}))hashes.add(hash);
  return [...hashes];
}

export async function finishIngestionJob(id: string, token: string, error?: string): Promise<void> {
  await kernelTransaction(async client=>{
    const result=await client.query<{source:string;scope:string;kind:string}>(
      `UPDATE ingestion_jobs SET state=CASE WHEN $3::text IS NULL THEN 'complete' WHEN attempts>=5 OR kind='document_topics' THEN 'failed' ELSE 'queued' END,
       last_error=$3,stage=CASE WHEN $3::text IS NULL THEN 'complete' ELSE stage END,
       available_at=CASE WHEN $3::text IS NULL THEN now() ELSE now()+make_interval(secs=>LEAST(3600,30*power(2,attempts)::int)) END,
       lease_until=NULL,lease_token=NULL,updated_at=now()
       WHERE id=$1 AND lease_token=$2 RETURNING source,scope,kind`, [id, token, error ?? null]);
    const job=result.rows[0];
    if(job&&['canvas','canvas-course','gmail','piazza'].includes(job.kind))await client.query(
      `UPDATE source_status SET state=$3,last_error=$4,
       last_completed_at=CASE WHEN $4::text IS NULL THEN now() ELSE last_completed_at END
       WHERE source=$1 AND scope=$2`,[job.source,job.scope,error?'error':'idle',error??null]);
  });
}

export async function completeSourcePage(source: string, scope: string, cursor: string | null, completed: boolean): Promise<void> {
  if (!completed) throw new Error('A partial or failed scan cannot advance the source cursor');
  await kernelPool().query(
    `INSERT INTO source_status(source,scope,cursor_value,last_completed_at,state)
     VALUES ($1,$2,$3,now(),'idle') ON CONFLICT(source,scope) DO UPDATE SET
     cursor_value=excluded.cursor_value,last_completed_at=excluded.last_completed_at,last_error=NULL,state='idle'`,
    [source, scope, cursor]);
}

export async function claimOutboxJob(): Promise<{id:string;kind:string;payload:unknown;lease_token:string}|null> {
  return kernelTransaction(async client=>{
    const row=(await client.query<{id:string;kind:string;payload:unknown}>(
      `SELECT id,kind,payload FROM kernel_outbox WHERE (state='queued' AND available_at<=now())
       OR (state='running' AND lease_until<now()) ORDER BY available_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
    if(!row)return null;
    const token=randomUUID();
    await client.query(`UPDATE kernel_outbox SET state='running',lease_token=$2,lease_until=now()+interval '3 minutes',
      attempts=attempts+1 WHERE id=$1`,[row.id,token]);
    return {...row,lease_token:token};
  });
}

export async function finishOutboxJob(id:string,token:string,error?:string):Promise<void>{
  await kernelPool().query(
    `UPDATE kernel_outbox SET state=CASE WHEN $3::text IS NULL THEN 'complete' WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
     last_error=$3,available_at=CASE WHEN $3::text IS NULL THEN now() ELSE now()+make_interval(secs=>LEAST(3600,30*power(2,attempts)::int)) END,
     lease_until=NULL,lease_token=NULL WHERE id=$1 AND lease_token=$2`,[id,token,error??null]);
}

export async function listOutboxJobs(){
  const rows=(await kernelPool().query(
    `SELECT id,kind,state status,attempts,last_error error,
      floor(extract(epoch from available_at)*1000)::bigint updated_at
     FROM kernel_outbox ORDER BY available_at DESC LIMIT 30`)).rows;
  return rows.map(row=>({...row,updated_at:Number(row.updated_at)}));
}

export async function retryOutboxJob(id:string):Promise<boolean>{
  const result=await kernelPool().query(
    `UPDATE kernel_outbox SET state='queued',attempts=0,last_error=NULL,available_at=now(),
      lease_until=NULL,lease_token=NULL WHERE id=$1 AND state='failed'`,[id]);
  return result.rowCount===1;
}
