import {database as db} from './database.ts';
import {paidOpenAI} from './ai-budget.ts';
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
  await db.batch(pending.map((mail,index)=>db.prepare('INSERT INTO mail_embeddings VALUES (?,?,?,?,?) ON CONFLICT(email_id,model) DO UPDATE SET input_hash=excluded.input_hash,vector=excluded.vector,created_at=excluded.created_at').bind(mail.id,EMBED_MODEL,MAIL_EMBED_VERSION+mail.hash,JSON.stringify(vectors.get(index)),now)));
  return pending.length;
 }finally{await releaseLease(lease,token);}
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
