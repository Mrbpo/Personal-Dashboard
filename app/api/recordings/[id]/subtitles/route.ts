import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner,readRecordingManifest,buildRecordingCatalog} from '@/lib/recording-catalog';
import {recordingTargetConfig} from '@/lib/recording-storage';
import {readRecordingSubtitles,subtitleMetadata,renderSubtitleVtt,type SubtitleMode} from '@/lib/recording-subtitles';
import {subtitleGenerationStatus,requestSubtitleGeneration} from '@/lib/recording-subtitle-request';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  assertRecordingOwner(await apiOwner(request));
  const {id}=await params;if(!/^[a-f0-9]{64}$/.test(id))return Response.json({error:'录像不存在'},{status:404});
  const mode=new URL(request.url).searchParams.get('mode');
  if(mode&&!['en','zh','bilingual'].includes(mode))return Response.json({error:'字幕模式无效'},{status:400});
  const {objects}=buildRecordingCatalog(await readRecordingManifest(),recordingTargetConfig());
  const object=objects.get(id);if(!object)return Response.json({error:'录像不存在'},{status:404});
  const bundle=await readRecordingSubtitles(object);
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
  if(!mode){
   const metadata=subtitleMetadata(bundle,object.durationSeconds);
   return Response.json({...metadata,generation:await subtitleGenerationStatus(object.sha256,metadata.available&&!metadata.partial&&metadata.translated)},{headers});
  }
  if(!bundle)return Response.json({error:'此录像尚未生成字幕'},{status:404,headers});
  return new Response(renderSubtitleVtt(bundle,mode as SubtitleMode),{headers:{...headers,'Content-Type':'text/vtt; charset=utf-8'}});
 }catch(error){const response=apiError(error);return response.status===400?new Response(response.body,{status:503,headers:response.headers}):response;}
}

export async function POST(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  assertRecordingOwner(await apiOwner(request));
  if(Number(request.headers.get('content-length')||0)>256)return Response.json({error:'请求过大'},{status:413});
  const text=await request.text();
  if(text.length>256)return Response.json({error:'请求过大'},{status:413});
  if(text.trim()){
   let body:unknown;try{body=JSON.parse(text);}catch{return Response.json({error:'请求无效'},{status:400});}
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)return Response.json({error:'不接受自定义字幕任务参数'},{status:400});
  }
  const {id}=await params;
  const {objects}=buildRecordingCatalog(await readRecordingManifest(),recordingTargetConfig());
  const object=/^[a-f0-9]{64}$/.test(id)?objects.get(id):undefined;
  if(!object)return Response.json({error:'录像不存在'},{status:404});
  const metadata=subtitleMetadata(await readRecordingSubtitles(object),object.durationSeconds);
  const complete=metadata.available&&!metadata.partial&&metadata.translated;
  const generation=await subtitleGenerationStatus(object.sha256,complete);
  if(complete)return Response.json({generation},{headers:{'Cache-Control':'no-store'}});
  if(!generation.configured)return Response.json({error:'字幕后台生成尚未启用'},{status:503});
  if(['running','queued'].includes(generation.state)&&!generation.canRequest)return Response.json({generation},{status:202});
  if(!generation.canRequest)return Response.json({error:generation.state==='deferred'?'字幕任务正在等待资源或预算恢复，请稍后查看':'字幕任务需要先检查上次失败记录，避免重复收费',generation},{status:409});
  const accepted=await requestSubtitleGeneration(object.sha256);
  if(!accepted)return Response.json({error:'另一条字幕请求正在提交，请稍后再试'},{status:409});
  return Response.json({...accepted,generation:{...generation,state:'queued',requested:true,canRequest:false}},{status:202,headers:{'Cache-Control':'no-store'}});
 }catch(error){const response=apiError(error);return response.status===400?new Response(response.body,{status:503,headers:response.headers}):response;}
}
