import{createHash}from'node:crypto';import{isDeepStrictEqual}from'node:util';import type{PoolClient}from'pg';
import{paidOpenAI,AiBudgetDeferredError}from'../ai-budget.ts';
import{kernelPool,kernelTransaction}from'./db.ts';import type{IngestionJob}from'./jobs.ts';
import{prepareControlledTopics,importControlledTopics,CONTROLLED_TOPIC_VERSION}from'./content-topic-classification.ts';

export const CONTENT_TOPIC_JOB_KIND='document_topics';
export function contentTopicJobMode(){
 const mode=process.env.KERNEL_CONTENT_TOPICS??'off';
 if(mode!=='off'&&mode!=='controlled-v1')throw Error('Invalid KERNEL_CONTENT_TOPICS');return mode;
}
type Packet=Extract<Awaited<ReturnType<typeof prepareControlledTopics>>,{status:'ready'}>['packet'];
// JSONB reorders object keys. Preserve the frozen packet/request as exact JSON
// bytes so replay/audit use the actual provider request, not a reserialization.
type Checkpoint={packetJson:string;delivery:'prepared'|'attempted'|'received';rawResponse?:string;httpStatus?:number};
type Payload={owner:string;id:string;versionId:string;sourceVersionId:string;sourceHash:string;pageNumber:number;topicCheckpoint?:Checkpoint};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

/** Same transaction as the new source pointer. No bodies/models or backfill. */
export async function queueIngestedTopicJobs(client:PoolClient,owner:string,documentId:string,versionId:string){
 const rows=(await client.query(`SELECT v.source_version_id,d.source_hash,p.page_number FROM document_texts d
  JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id JOIN document_text_pages p ON p.version_id=v.id
  WHERE d.owner_id=$1 AND d.id=$2 AND v.id=$3 AND NOT d.hidden AND NOT EXISTS(
   SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin AND newer.origin_key=d.origin_key AND NOT newer.hidden
   AND(newer.created_at>d.created_at OR(newer.created_at=d.created_at AND newer.id>d.id))) ORDER BY p.page_number`,[owner,documentId,versionId])).rows;
 const jobs=rows.map(r=>{const id='topics:'+sha(JSON.stringify([CONTROLLED_TOPIC_VERSION,owner,documentId,versionId,r.page_number]));
  return{id,payload:{owner,id:documentId,versionId,sourceVersionId:r.source_version_id,sourceHash:r.source_hash,pageNumber:r.page_number}};});
 if(jobs.length)await client.query(`INSERT INTO ingestion_jobs(id,kind,source,scope,payload,idempotency_key)
  SELECT j.id,$2,$3,$4,j.payload,j.id FROM jsonb_to_recordset($1::jsonb) AS j(id text,payload jsonb)
  ON CONFLICT(idempotency_key) DO NOTHING`,[JSON.stringify(jobs),CONTENT_TOPIC_JOB_KIND,'content-topics',documentId]);
 return{queuedPages:jobs.length};
}

async function lease(client:PoolClient,job:IngestionJob):Promise<Payload>{
 const row=(await client.query<{payload:Payload}>(`SELECT payload FROM ingestion_jobs WHERE id=$1 AND lease_token=$2
  AND kind=$3 AND state='running' AND lease_until>now() FOR UPDATE`,[job.id,job.lease_token,CONTENT_TOPIC_JOB_KIND])).rows[0];
 if(!row)throw Error('Topic job lease lost');const p=row.payload;
 if(!p||typeof p.owner!=='string'||!p.owner.trim()||typeof p.id!=='string'||!p.id.trim()||job.scope!==p.id||
  ![p.versionId,p.sourceVersionId,p.sourceHash].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||!Number.isSafeInteger(p.pageNumber)||p.pageNumber<1)
  throw Error('Invalid current-source topic job');return p;
}
async function checkpoint(job:IngestionJob,value:Checkpoint,expected:Checkpoint['delivery']|undefined){
 await kernelTransaction(async client=>{const prior=(await lease(client,job)).topicCheckpoint;
  if(prior?.delivery!==expected||(prior&&prior.packetJson!==value.packetJson))throw Error('Topic job checkpoint changed');
  await client.query(`UPDATE ingestion_jobs SET
  payload=jsonb_set(payload,'{topicCheckpoint}',$3::jsonb),stage=$4,updated_at=now() WHERE id=$1 AND lease_token=$2`,
  [job.id,job.lease_token,JSON.stringify(value),'topics_'+value.delivery]);});
}

/** A single existing worker task. Durable attempted-without-response means the
 * provider outcome is unknown: never repeat a possibly billed request. */
export async function runDocumentTopicJob(job:IngestionJob){
 if(contentTopicJobMode()!=='controlled-v1'||job.kind!==CONTENT_TOPIC_JOB_KIND)throw Error('Topic jobs are disabled or unsupported');
 const p=await kernelTransaction(client=>lease(client,job));let saved=p.topicCheckpoint;
 if(saved?.delivery==='attempted')throw Error('Topic provider outcome unknown; administrator reconciliation required');
 if(!saved||saved.delivery==='prepared'){
  const prepared=await prepareControlledTopics(kernelPool(),p.owner,p.id,[p.pageNumber]);
  if(prepared.status!=='ready'){
   await kernelTransaction(async client=>{await lease(client,job);await client.query(`UPDATE ingestion_jobs SET
    payload=jsonb_set(payload,'{topicUnavailable}',$3::jsonb),stage='topics_unavailable',updated_at=now() WHERE id=$1 AND lease_token=$2`,
    [job.id,job.lease_token,JSON.stringify({reason:prepared.reason,pageNumber:p.pageNumber})]);});return{status:'unavailable' as const,reason:prepared.reason};
  }
  const packet=prepared.packet;
  if(packet.source.currentVersionId!==p.versionId||packet.source.sourceVersionId!==p.sourceVersionId||packet.source.sourceHash!==p.sourceHash)
   throw Error('Topic job source version changed');
  if(saved&&!isDeepStrictEqual(JSON.parse(saved.packetJson),packet))throw Error('Prepared topic source or vocabulary changed');
  const packetJson=saved?.packetJson??JSON.stringify(packet),priorDelivery=saved?.delivery;
  saved={packetJson,delivery:'prepared'};await checkpoint(job,saved,priorDelivery);
  saved={...saved,delivery:'attempted'};await checkpoint(job,saved,'prepared');
  let response:Response;
  try{response=await paidOpenAI('responses',(JSON.parse(packetJson)as Packet).request,AbortSignal.timeout(55000),{kind:'document-topic-classification',dailyLimit:20});}
  catch(error){
   // This exception is raised by reservation before transport; all other errors
   // retain attempted, even if the client did not receive a response.
   if(error instanceof AiBudgetDeferredError)await checkpoint(job,{packetJson,delivery:'prepared'},'attempted');throw error;
  }
  const rawResponse=await response.text();
  if(Buffer.byteLength(rawResponse)>65536)throw Error('Topic raw response exceeds checkpoint capacity; reconcile provider outcome');
  saved={packetJson,delivery:'received',rawResponse,httpStatus:response.status};await checkpoint(job,saved,'attempted');
 }
 if(saved.delivery!=='received'||typeof saved.rawResponse!=='string'||!Number.isInteger(saved.httpStatus)||saved.httpStatus!<200||saved.httpStatus!>=300)
  throw Error('Topic provider response unavailable or unsuccessful; review required');
 return kernelTransaction(async client=>{
  const current=await lease(client,job),cp=current.topicCheckpoint;
  if(!cp||!isDeepStrictEqual(cp,saved))throw Error('Topic job checkpoint changed');
  const packet=JSON.parse(saved!.packetJson)as Packet;
  const imported=await importControlledTopics(client,p.owner,packet,saved!.rawResponse!,'kernel:content-topics','Incremental current-source page proposal','kernel-worker-output');
  await client.query(`UPDATE ingestion_jobs SET payload=jsonb_set(payload,'{topicImported}',$3::jsonb),stage='topics_imported',updated_at=now()
   WHERE id=$1 AND lease_token=$2`,[job.id,job.lease_token,JSON.stringify({...imported,rawResponseSha256:sha(saved!.rawResponse!),requestSha256:sha(JSON.stringify(packet.request))})]);
  return{status:'imported' as const,...imported};
 });
}
