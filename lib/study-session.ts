import {createHash} from 'node:crypto';
import {database as db} from './database.ts';
import {kernel} from './kernel/service.ts';
import {StudyAnswerError} from './study-answer.ts';

export const STUDY_QUERY_MODES=['auto','document','facts','combined'] as const;
export type StudyQueryMode=(typeof STUDY_QUERY_MODES)[number];
export type StudySession={queryMode:StudyQueryMode;documentIds:string[];revision:number};
export type StudySessionRow={query_mode:string;document_ids_json:string;revision:number};
export function studyQueryMode(value:unknown):StudyQueryMode {
 if(typeof value!=='string'||!STUDY_QUERY_MODES.includes(value as StudyQueryMode))
  throw new StudyAnswerError('configuration','invalid-query-mode','问答模式无效');
 return value as StudyQueryMode;
}
export function studyDocumentIds(value:unknown):string[] {
 if(!Array.isArray(value)||value.length>8||value.some(id=>typeof id!=='string'||!id.trim()||id.length>200))
  throw new StudyAnswerError('configuration','invalid-document-selection','请选择最多 8 份资料库文件');
 return [...new Set(value as string[])].sort();
}
function decode(row:StudySessionRow):StudySession {
 return {queryMode:studyQueryMode(row.query_mode),documentIds:studyDocumentIds(JSON.parse(row.document_ids_json)),revision:Number(row.revision)};
}
async function owned(owner:string,threadId:string){
 const row=await db.prepare('SELECT id FROM tutor_threads WHERE id=? AND owner_id=?').bind(threadId,owner).first();
 if(!row)throw new StudyAnswerError('configuration','thread-unavailable','学习对话不存在或无权访问');
}
export async function readStudySession(owner:string,threadId:string):Promise<StudySession>{
 await owned(owner,threadId);
 const now=new Date().toISOString();
 await db.batch([
  db.prepare("INSERT INTO tutor_study_sessions(thread_id,owner_id,query_mode,document_ids_json,revision,updated_at) VALUES (?,?,'auto','[]',0,?) ON CONFLICT(thread_id) DO NOTHING").bind(threadId,owner,now),
  db.prepare('INSERT INTO tutor_study_scope_versions(thread_id,revision,query_mode,document_ids_json,created_at) SELECT thread_id,revision,query_mode,document_ids_json,updated_at FROM tutor_study_sessions WHERE thread_id=? AND owner_id=? ON CONFLICT(thread_id,revision) DO NOTHING').bind(threadId,owner),
 ]);
 const row=await db.prepare('SELECT query_mode,document_ids_json,revision FROM tutor_study_sessions WHERE thread_id=? AND owner_id=?').bind(threadId,owner).first<StudySessionRow>();
 if(!row)throw new Error('Study session unavailable');
 return decode(row);
}
export async function validateStudyDocuments(owner:string,documentIds:string[]){
 for(const id of documentIds){
  const source=await kernel.selectedStudyDocuments(owner,[id]);
  if(source.length!==1)throw new StudyAnswerError('retrieval','document-unavailable','所选 PDF 尚未完成解析、已被移除或无权访问；请重新选择');
 }
}
export async function updateStudySession(owner:string,threadId:string,input:{documentIds:unknown;queryMode:unknown;scopeRevision:unknown}){
 const documentIds=studyDocumentIds(input.documentIds),queryMode=studyQueryMode(input.queryMode);
 if(!Number.isSafeInteger(input.scopeRevision)||Number(input.scopeRevision)<0)
  throw new StudyAnswerError('configuration','scope-revision-required','请刷新后使用当前资料范围版本');
 if(queryMode!=='facts')await validateStudyDocuments(owner,documentIds);
 const current=await readStudySession(owner,threadId);
 if(current.revision!==input.scopeRevision)throw new StudyAnswerError('configuration','scope-conflict','资料范围已被其他请求修改，请刷新');
 if(current.queryMode===queryMode&&JSON.stringify(current.documentIds)===JSON.stringify(documentIds))return current;
 const now=new Date().toISOString();
 const changed=await db.batch([db.prepare(`UPDATE tutor_study_sessions SET query_mode=?,document_ids_json=?,revision=revision+1,updated_at=?
  WHERE thread_id=? AND owner_id=? AND revision=? AND NOT EXISTS(
   SELECT 1 FROM service_leases WHERE id=? AND expires_at>?) RETURNING revision`)
  .bind(queryMode,JSON.stringify(documentIds),now,threadId,owner,current.revision,'tutor:'+threadId,Date.now()),
  db.prepare(`INSERT INTO tutor_study_scope_versions(thread_id,revision,query_mode,document_ids_json,created_at)
   SELECT thread_id,revision,query_mode,document_ids_json,updated_at FROM tutor_study_sessions
   WHERE thread_id=? AND owner_id=? AND revision=? ON CONFLICT(thread_id,revision) DO NOTHING`)
   .bind(threadId,owner,current.revision+1)]);
 if(!changed[0].rows.length)throw new StudyAnswerError('configuration','scope-conflict','对话正在回答或资料范围已变化，请稍后刷新');
 return {queryMode,documentIds,revision:current.revision+1};
}
export async function findDocumentStudyThread(owner:string,documentId:string){
 const rows=(await db.prepare(`SELECT s.thread_id,s.document_ids_json FROM tutor_study_sessions s
  JOIN tutor_threads t ON t.id=s.thread_id AND t.owner_id=s.owner_id WHERE s.owner_id=?
  ORDER BY t.updated_at DESC`).bind(owner).all<{thread_id:string;document_ids_json:string}>()).results;
 return rows.find(row=>{const ids=JSON.parse(row.document_ids_json);return ids.length===1&&ids[0]===documentId;})?.thread_id;
}
export function resolveStudyQueryMode(question:string,session:StudySession):Exclude<StudyQueryMode,'auto'>{
 if(session.queryMode!=='auto')return session.queryMode;
 const original=/(?:这份|该份|这篇|本文|原文|文档中|PDF\s*(?:里|中|写))|\b(?:this (?:pdf|paper|document)|according to (?:this|the) (?:pdf|paper|document))\b/i.test(question);
 const facts=/(?:截止|什么时候交|何时交|近期.*(?:考试|作业)|考试.*(?:时间|安排)|评分规则|提交要求|课程政策)|\b(?:deadline|due date|when.*(?:due|exam)|upcoming (?:exam|assignment)|grading (?:policy|scheme)|submission requirements)\b/i.test(question);
 const academic=/(?:解释|推导|为什么|公式|证明)|\b(?:explain|derive|prove|why)\b/i.test(question);
 return original?'document':facts?(academic&&session.documentIds.length?'combined':'facts'):'document';
}
export function studySessionWitness(session:StudySession,question:string,factQuery:{asOf?:string;history?:boolean}={}){
 const mode=resolveStudyQueryMode(question,session);
 const value={...session,effectiveMode:mode,...(Object.keys(factQuery).length?{factQuery}:{})};
 return {...value,fingerprint:createHash('sha256').update(JSON.stringify(value)).digest('hex')};
}
