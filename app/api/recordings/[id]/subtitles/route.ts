import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner,readRecordingManifest,buildRecordingCatalog} from '@/lib/recording-catalog';
import {recordingTargetConfig} from '@/lib/recording-storage';
import {readRecordingSubtitles,subtitleMetadata,renderSubtitleVtt,type SubtitleMode} from '@/lib/recording-subtitles';
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
  if(!mode)return Response.json(subtitleMetadata(bundle,object.durationSeconds),{headers});
  if(!bundle)return Response.json({error:'此录像尚未生成字幕'},{status:404,headers});
  return new Response(renderSubtitleVtt(bundle,mode as SubtitleMode),{headers:{...headers,'Content-Type':'text/vtt; charset=utf-8'}});
 }catch(error){const response=apiError(error);return response.status===400?new Response(response.body,{status:503,headers:response.headers}):response;}
}
