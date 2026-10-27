import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner} from '@/lib/recording-catalog';
import {recordingControlStatus,requestRecordingControl} from '@/lib/recording-control';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
 assertRecordingOwner(await apiOwner(request));
 return Response.json(await recordingControlStatus(),{headers:{'Cache-Control':'private, no-store'}});
}catch(error){return apiError(error);}}
export async function POST(request:Request){try{
 assertRecordingOwner(await apiOwner(request));
 if(Number(request.headers.get('content-length'))>1024)return Response.json({error:'请求过大'},{status:413});
 const text=await request.text();if(text.length>1024)return Response.json({error:'请求过大'},{status:413});
 const body=JSON.parse(text);
 if(!body||Object.keys(body).length!==1||!['sync','reauthorize'].includes(body.action))return Response.json({error:'操作无效'},{status:400});
 const result=await requestRecordingControl(body.action);
 return result?Response.json(result,{status:202,headers:{'Cache-Control':'no-store'}}):Response.json({error:'已有录像任务正在处理，请稍候'},{status:409});
}catch(error){return apiError(error);}}
