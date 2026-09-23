import {database as db} from './database.ts';
import {budgetStatus,estimateEmbeddingReservation,paidOpenAI} from './ai-budget.ts';
import {acquireLease,releaseLease} from './jobs.ts';

export const EMBED_MODEL='text-embedding-3-small';
export const MAIL_EMBED_VERSION='subject-body-v1:';
export type MailEmbeddingInput={id:string;account:string;subject:string;body:string;hash:string};

// Keep one vector per message. For long messages, include the beginning, middle,
// and end; exact searches continue to use the complete stored body.
export function mailEmbeddingText(mail:Pick<MailEmbeddingInput,'subject'|'body'>){
 const body=mail.body.length<=6000?mail.body:[mail.body.slice(0,2000),mail.body.slice(Math.floor((mail.body.length-2000)/2),Math.floor((mail.body.length-2000)/2)+2000),mail.body.slice(-2000)].join('\n');
 return `${mail.subject.slice(0,500)}\n${body}`;
}

export async function storeMailEmbeddings(mails:MailEmbeddingInput[]){
 if(!mails.length)return 0;
 const account=mails[0].account;if(mails.some(mail=>mail.account!==account))throw new Error('邮件向量批次须属于同一账户');
 const lease=`mail-embedding:${account}`,token=crypto.randomUUID();
 if(!await acquireLease(lease,token))return 0;
 try{
  const pending:MailEmbeddingInput[]=[];
  for(const mail of mails){const existing=await db.prepare('SELECT input_hash FROM mail_embeddings WHERE email_id=? AND model=?').bind(mail.id,EMBED_MODEL).first<{input_hash:string}>();if(existing?.input_hash!==MAIL_EMBED_VERSION+mail.hash)pending.push(mail);}
  if(!pending.length)return 0;
  const response=await paidOpenAI('embeddings',{model:EMBED_MODEL,input:pending.map(mailEmbeddingText),dimensions:768});
  if(!response.ok)throw new Error('邮件向量索引失败');
  const data=(await response.json()).data;
  if(!Array.isArray(data)||data.length!==pending.length)throw new Error('邮件向量结果不完整');
  const vectors=new Map<number,number[]>();
  for(const item of data){if(!Number.isInteger(item.index)||item.index<0||item.index>=pending.length||vectors.has(item.index)||!Array.isArray(item.embedding)||item.embedding.length!==768||!item.embedding.every(Number.isFinite))throw new Error('邮件向量格式无效');vectors.set(item.index,item.embedding);}
  const now=new Date().toISOString();
  // A sync can change a message while the paid request is in flight. Never
  // replace its old vector with an embedding of a no-longer-current body.
  const writes=await db.batch(pending.map((mail,index)=>db.prepare(`INSERT INTO mail_embeddings(email_id,model,input_hash,vector,created_at)
    SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM mail_messages m WHERE m.id=? AND m.account=? AND m.hash=? AND m.removed=0)
    ON CONFLICT(email_id,model) DO UPDATE SET input_hash=excluded.input_hash,vector=excluded.vector,created_at=excluded.created_at`)
    .bind(mail.id,EMBED_MODEL,MAIL_EMBED_VERSION+mail.hash,JSON.stringify(vectors.get(index)),now,mail.id,account,mail.hash)));
  return writes.reduce((count,result)=>count+Number(result.rowsAffected||0),0);
 }finally{await releaseLease(lease,token);}
}

export async function mailEmbeddingCoverage(){
 const row=await db.prepare(`SELECT COUNT(*) active,
   COALESCE(SUM(CASE WHEN e.email_id IS NULL THEN 1 ELSE 0 END),0) missing,
   COALESCE(SUM(CASE WHEN e.email_id IS NOT NULL AND e.input_hash=?||m.hash THEN 1 ELSE 0 END),0) valid,
   COALESCE(SUM(CASE WHEN e.email_id IS NOT NULL AND e.input_hash!=?||m.hash THEN 1 ELSE 0 END),0) stale
   FROM mail_messages m LEFT JOIN mail_embeddings e ON e.email_id=m.id AND e.model=? WHERE m.removed=0`)
   .bind(MAIL_EMBED_VERSION,MAIL_EMBED_VERSION,EMBED_MODEL).first<{active:number;missing:number;valid:number;stale:number}>();
 const orphan=await db.prepare(`SELECT COUNT(*) count FROM mail_embeddings e LEFT JOIN mail_messages m ON m.id=e.email_id
   WHERE e.model=? AND (m.id IS NULL OR m.removed!=0)`).bind(EMBED_MODEL).first<{count:number}>();
 return {active:Number(row?.active||0),missing:Number(row?.missing||0),valid:Number(row?.valid||0),stale:Number(row?.stale||0),orphan:Number(orphan?.count||0)};
}

export type MailBackfillOptions={limit:number;batchSize:number;maxReservedUsd:number;apply:boolean};
export async function backfillMailEmbeddings(options:MailBackfillOptions){
 const {limit,batchSize,maxReservedUsd,apply}=options;
 if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(batchSize)||batchSize<1||batchSize>32||!Number.isFinite(maxReservedUsd)||maxReservedUsd<=0||maxReservedUsd>1)throw new Error('邮件回填限额无效');
 const before=await mailEmbeddingCoverage(),budget=await budgetStatus();
 const headroom=Math.max(0,budget.limit-budget.used),cap=Math.min(maxReservedUsd,headroom);
 const rows=(await db.prepare(`SELECT m.id,m.account,m.subject,m.body,m.hash FROM mail_messages m
   JOIN mail_embeddings e ON e.email_id=m.id AND e.model=?
   WHERE m.removed=0 AND e.input_hash!=?||m.hash
   ORDER BY m.account,m.received_at DESC,m.id DESC LIMIT ?`)
   .bind(EMBED_MODEL,MAIL_EMBED_VERSION,limit).all<MailEmbeddingInput>()).results;
 const selected:MailEmbeddingInput[]=[];let estimatedReservedUsd=0,capReached=false;
 for(const row of rows){
  // Per-message reservation slightly exceeds the reservation for a batch,
  // so both the run cap and monthly-budget preflight remain conservative.
  const estimate=estimateEmbeddingReservation([mailEmbeddingText(row)],EMBED_MODEL);
  if(estimatedReservedUsd+estimate>cap+1e-12){capReached=true;break;}
  selected.push(row);estimatedReservedUsd+=estimate;
 }
 let written=0,stopped=capReached?(headroom<=maxReservedUsd?'monthly_budget':'run_cost_cap'):'';
 if(apply)for(let offset=0;offset<selected.length;){
  const account=selected[offset].account,batch:MailEmbeddingInput[]=[];
  while(offset<selected.length&&selected[offset].account===account&&batch.length<batchSize)batch.push(selected[offset++]);
  const count=await storeMailEmbeddings(batch);
  if(!count){stopped='busy_or_changed';break;}
  written+=count;
 }
 const after=apply?await mailEmbeddingCoverage():before;
 return {apply,selected:selected.length,written,estimatedReservedUsd,budgetBefore:budget,budgetAfter:apply?await budgetStatus():budget,before,after,stopped};
}

export async function ensureMailEmbedding(account:string,emailId:string){
 const mail=await db.prepare('SELECT id,account,subject,body,hash FROM mail_messages WHERE id=? AND account=?').bind(emailId,account).first<MailEmbeddingInput>();
 if(!mail)return false;
 const existing=await db.prepare('SELECT input_hash FROM mail_embeddings WHERE email_id=? AND model=?').bind(emailId,EMBED_MODEL).first<{input_hash:string}>();
 if(existing?.input_hash===MAIL_EMBED_VERSION+mail.hash)return false;
 await storeMailEmbeddings([mail]);return true;
}

export async function retireMailEmbedding(account:string,emailId:string,sourceHash:string){
 await db.batch([
  db.prepare(`INSERT OR IGNORE INTO mail_embedding_versions(account,email_id,model,source_hash,vector)
    SELECT ?,e.email_id,e.model,?,e.vector FROM mail_embeddings e WHERE e.email_id=? AND e.model=? AND e.input_hash=?||?
    AND EXISTS (SELECT 1 FROM library_mail_sources s JOIN library_documents d ON d.id=s.document_id
      WHERE s.account=? AND s.email_id=? AND s.source_hash=? AND d.deleted=0)`).bind(account,sourceHash,emailId,EMBED_MODEL,MAIL_EMBED_VERSION,sourceHash,account,emailId,sourceHash),
  db.prepare('DELETE FROM mail_embeddings WHERE email_id=?').bind(emailId),
 ]);
}
