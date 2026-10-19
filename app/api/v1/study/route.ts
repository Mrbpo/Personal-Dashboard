import { getCurrentOwner, requireOwnerApi } from '@/lib/authz';
import { createTutorThread, sendTutor, tutorState } from '@/lib/tutor';
import {studyFailure,studyRoutingScope} from '@/lib/study-answer';

export const runtime='nodejs';

export async function GET(request:Request){
  const denied=await requireOwnerApi();if(denied)return denied;
  try{const owner=(await getCurrentOwner())!;return Response.json(await tutorState(owner.userId,new URL(request.url).searchParams.get('threadId')||undefined),{headers:{'Cache-Control':'no-store'}});}
  catch{return Response.json({error:'无法读取学习对话'},{status:400});}
}

export async function POST(request:Request){
  const denied=await requireOwnerApi();if(denied)return denied;
  try{
    if(Number(request.headers.get('content-length')||0)>20000)throw new Error('请求过大');
    const owner=(await getCurrentOwner())!,body=await request.json();
    const routingScope=studyRoutingScope(body.routingScope);
    const question=String(body.question||'').trim(),courseId=String(body.courseId||''),requestId=String(body.requestId||crypto.randomUUID());
    if(!question||question.length>6000)throw new Error('问题须为 1 至 6000 字');
    const threadId=body.threadId?String(body.threadId):await createTutorThread(owner.userId,courseId);
    await sendTutor(owner.userId,threadId,requestId,question,[],body.online!==false,String(body.publicQuery||''),routingScope);
    const state=await tutorState(owner.userId,threadId),answer=[...state.messages].reverse().find(message=>message.role==='assistant');
    return Response.json({threadId,answer,courses:state.threads.filter(thread=>thread.id===threadId).map(thread=>({id:thread.course_id})),generatedAt:new Date().toISOString()},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    const message=error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'学习问答暂时不可用';
    return Response.json({error:message,...(studyFailure(error)?{failure:studyFailure(error)}:{})},{status:400});
  }
}
