import {apiOwner,apiError} from '@/lib/api-guard';
import {createTutorThread,sendTutor,tutorState} from '@/lib/tutor';
import {studyAnswerBackend,studyFailure,studyRoutingScope,StudyAnswerError} from '@/lib/study-answer';
import {readStudySession,updateStudySession,findDocumentStudyThread,studyDocumentIds,resolveStudyQueryMode} from '@/lib/study-session';
import {factInstant} from '@/lib/kernel/fact-validity';
import {createHash} from 'node:crypto';

export const runtime='nodejs';
function failure(error:unknown){
 if(error instanceof StudyAnswerError)return Response.json({error:error.message,failure:studyFailure(error)},
  {status:error.code==='scope-conflict'?409:error.code==='document-unavailable'?422:400});
 return apiError(error);
}
async function state(owner:string,threadId?:string){
 return {...await tutorState(owner,threadId),threadId:threadId??'',
  session:threadId?await readStudySession(owner,threadId):{queryMode:'auto',documentIds:[],revision:0}};
}
export async function GET(request:Request){
 try{
  const owner=await apiOwner(request),params=new URL(request.url).searchParams;
  const documentId=params.get('documentId'),threadId=params.get('threadId')||
   (documentId?await findDocumentStudyThread(owner,documentId):undefined);
  const result=await state(owner,threadId);
  if(!threadId&&documentId)result.session.documentIds=studyDocumentIds([documentId]);
  return Response.json(result,{headers:{'Cache-Control':'no-store'}});
 }catch(error){return failure(error);}
}
export async function POST(request:Request){
 try{
  const owner=await apiOwner(request);
  if(Number(request.headers.get('content-length')||0)>20000)throw new Error('请求过大');
  const body=await request.json(),question=String(body.question||'').trim();
  if(body.asOf!==undefined&&factInstant(body.asOf)===null)throw new Error('历史查询须提供带时区偏移的 ISO 时间');
  if(body.history!==undefined&&typeof body.history!=='boolean')throw new Error('历史查询选项无效');
  const factQuery={...(body.asOf!==undefined?{asOf:body.asOf as string}:{}),...(body.history!==undefined?{history:body.history as boolean}:{})};
  if(!question||question.length>6000)throw new Error('问题须为 1 至 6000 字');
  const requestId=String(body.requestId||crypto.randomUUID());
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(requestId))throw new Error('请求标识须为 8 至 128 位字母、数字或连字符');
  const payloadHash=createHash('sha256').update(JSON.stringify({
   question,courseId:String(body.courseId||''),documentIds:studyDocumentIds(body.documentIds??[]),
   queryMode:body.queryMode??'auto',factQuery,routingScope:body.routingScope??null,
   online:body.online!==false,publicQuery:String(body.publicQuery||''),
  })).digest('hex');
  const created=!body.threadId,threadId=created?await createTutorThread(owner,String(body.courseId||''),{id:requestId,payloadHash}):String(body.threadId);
  if(created){
   const saved=await state(owner,threadId),answer=saved.messages.find(message=>message.id===`${threadId}:${requestId}:answer`);
   if(answer)return Response.json({...saved,answer,generatedAt:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});
   if(saved.session.revision>0&&(saved.session.queryMode!==(body.queryMode??'auto')||
    JSON.stringify(saved.session.documentIds)!==JSON.stringify(studyDocumentIds(body.documentIds??[]))))
    throw new StudyAnswerError('configuration','scope-conflict','初始请求后的资料范围已变化，请刷新后重新发送');
  }
  if(studyAnswerBackend()!=='kernel'){
   const routingScope=studyRoutingScope(body.routingScope);
   await sendTutor(owner,threadId,requestId,question,[],body.online!==false,String(body.publicQuery||''),routingScope);
  }else{
   let session=await readStudySession(owner,threadId);
   if(body.documentIds!==undefined||body.queryMode!==undefined)
    session=await updateStudySession(owner,threadId,{documentIds:body.documentIds??session.documentIds,
     queryMode:body.queryMode??session.queryMode,scopeRevision:created?session.revision:body.scopeRevision});
   else if(body.scopeRevision!==undefined&&body.scopeRevision!==session.revision)
    throw new StudyAnswerError('configuration','scope-conflict','资料范围已变化，请刷新后重试');
   if(body.routingScope!==undefined)throw new StudyAnswerError('configuration','ambiguous-selection','请使用会话资料选择，不能同时提供另一组检索范围');
   if(Object.keys(factQuery).length&&resolveStudyQueryMode(question,session)==='document')
    throw new StudyAnswerError('configuration','history-requires-facts','历史生效时间只用于课程事实查询，请选择课程事实或组合模式');
   await sendTutor(owner,threadId,requestId,question,[],false,'',undefined,session,factQuery);
  }
  const result=await state(owner,threadId),answer=result.messages.find(message=>message.id===`${threadId}:${requestId}:answer`);
  return Response.json({...result,answer,generatedAt:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});
 }catch(error){return failure(error);}
}
export async function PATCH(request:Request){
 try{
  const owner=await apiOwner(request),body=await request.json(),threadId=String(body.threadId||'');
  if(studyAnswerBackend()!=='kernel')throw new StudyAnswerError('configuration','routing-requires-kernel','资料问答需要启用内核路径');
  await updateStudySession(owner,threadId,{documentIds:body.documentIds,queryMode:body.queryMode,scopeRevision:body.scopeRevision});
  return Response.json(await state(owner,threadId),{headers:{'Cache-Control':'no-store'}});
 }catch(error){return failure(error);}
}
