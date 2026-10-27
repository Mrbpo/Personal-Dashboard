import { apiOwner,apiError,boundedForm } from '@/lib/api-guard';
import { createTutorThread,tutorState,sendTutor,validateAttachment,deleteTutorThread,updateTutor } from '@/lib/tutor';
import {studyFailure,studyRoutingScope,StudyAnswerError} from '@/lib/study-answer';
import {studyAnswerBackend} from '@/lib/study-answer';
import {readStudySession,updateStudySession} from '@/lib/study-session';
export const runtime='nodejs';
export async function GET(r:Request){try{return Response.json(await tutorState(await apiOwner(r),new URL(r.url).searchParams.get('thread')||undefined),{headers:{'Cache-Control':'no-store'}});}catch(e){return apiError(e);}}
export async function POST(r:Request){try{
 const owner=await apiOwner(r);
 if(r.headers.get('content-type')?.includes('application/json')){
  const b=await r.json();
  if(b.routingScope!==undefined)throw new StudyAnswerError('configuration','routing-on-send-only','请在发送问题时指定检索范围');
  return Response.json({id:await createTutorThread(owner,String(b.courseId||''))});
 }
 const f=await boundedForm(r),routingScope=studyRoutingScope(f.get('routingScope'),true);
 const files=f.getAll('files').filter(v=>v instanceof File) as File[];
 const attachments=await Promise.all(files.map(async file=>validateAttachment(file.name,new Uint8Array(await file.arrayBuffer()))));
 const id=String(f.get('threadId')||'');
 let session;
 if(studyAnswerBackend()==='kernel'){
  session=await readStudySession(owner,id);
  if(f.has('documentIds')||f.has('queryMode')){
   let ids:unknown=session.documentIds;
   if(f.has('documentIds'))try{ids=JSON.parse(String(f.get('documentIds')));}catch{throw new Error('资料选择格式无效');}
   session=await updateStudySession(owner,id,{documentIds:ids,queryMode:f.get('queryMode')??session.queryMode,
    scopeRevision:Number(f.get('scopeRevision'))});
  }
  if(routingScope)throw new StudyAnswerError('configuration','ambiguous-selection','请使用会话资料选择，不能同时提供另一组检索范围');
 }
 await sendTutor(owner,id,String(f.get('requestId')||''),String(f.get('question')||''),attachments,
  session?false:f.get('online')!=='false',String(f.get('publicQuery')||''),routingScope,session);
 return Response.json({...await tutorState(owner,id),...(session?{session}:{})});
}catch(e){return e instanceof StudyAnswerError?Response.json({error:e.message,failure:studyFailure(e)},{status:e.code==='scope-conflict'?409:400}):apiError(e);}}
export async function PATCH(r:Request){try{await updateTutor(await apiOwner(r),await r.json());return Response.json({ok:true});}catch(e){return apiError(e);}}
export async function DELETE(r:Request){try{await deleteTutorThread(await apiOwner(r),String((await r.json()).id));return Response.json({ok:true});}catch(e){return apiError(e);}}
