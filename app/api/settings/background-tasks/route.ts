import {apiOwner,apiError} from '@/lib/api-guard';
import {backgroundStatus,triggerBackgroundTask} from '@/lib/background-tasks';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{return Response.json(await backgroundStatus(await apiOwner(request)),{headers:{'Cache-Control':'private, no-store'}});}
 catch(error){return apiError(error);}
}
export async function POST(request:Request){
 try{
  const owner=await apiOwner(request);
  if(Number(request.headers.get('content-length')??0)>256)return Response.json({error:'请求过大'},{status:413});
  const text=await request.text();if(text.length>256)return Response.json({error:'请求过大'},{status:413});
  const body=JSON.parse(text);
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.task!=='string')return Response.json({error:'任务请求无效'},{status:400});
  return Response.json(await triggerBackgroundTask(owner,body.task),{status:202,headers:{'Cache-Control':'no-store'}});
 }catch(error){return apiError(error);}
}
