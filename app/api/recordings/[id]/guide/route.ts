import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner,readRecordingManifest,buildRecordingCatalog} from '@/lib/recording-catalog';
import {recordingTargetConfig} from '@/lib/recording-storage';
import {guideFiles,readGuideManifest,readGuideAsset,type GuideFormat} from '@/lib/recording-guide';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  assertRecordingOwner(await apiOwner(request));
  const {id}=await params;
  if(!/^[a-f0-9]{64}$/.test(id))return Response.json({error:'录像不存在'},{status:404});
  const {objects}=buildRecordingCatalog(await readRecordingManifest(),recordingTargetConfig()),object=objects.get(id);
  if(!object)return Response.json({error:'录像不存在'},{status:404});
  const url=new URL(request.url),format=url.searchParams.get('format');
  if(format&&!Object.hasOwn(guideFiles,format)||url.searchParams.has('download')&&url.searchParams.get('download')!=='1')return Response.json({error:'讲义格式无效'},{status:400});
  const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
  const manifest=await readGuideManifest(object);
  if(!format)return Response.json(manifest?{available:true,clipStartMs:manifest.clipStartMs,clipEndMs:manifest.clipEndMs,
   partial:manifest.clipStartMs>0||object.durationSeconds===null||manifest.clipEndMs<object.durationSeconds*1000-1000,reviewed:true}:{available:false},{headers});
  if(!manifest)return Response.json({error:'此录像暂无学习讲义'},{status:404,headers});
  const kind=format as GuideFormat,asset=await readGuideAsset(object,manifest,kind);
  let body:BodyInit=new Uint8Array(asset);
  if(kind==='html'){
   const base=`/api/recordings/${id}/guide`;
   body=asset.toString('utf8').replaceAll('output/pdf/course-slide-learning-detailed.pdf',base+'?format=pdf&amp;download=1')
    .replaceAll('output/pdf/course-outline-detailed.pdf',base+'?format=outlinePdf&amp;download=1')
    .replaceAll('course-outline-detailed.txt',base+'?format=outlineText&amp;download=1')
    .replaceAll('course-slide-learning-detailed.html',base+'?format=html&amp;download=1');
  }
  return new Response(body,{headers:{...headers,'Content-Type':guideFiles[kind].mime,
   'Content-Disposition':`${url.searchParams.has('download')||kind==='outlineText'?'attachment':'inline'}; filename="${guideFiles[kind].name}"`,
   'Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-downloads allow-top-navigation-by-user-activation"}});
 }catch(error){const response=apiError(error);return response.status===400?new Response(response.body,{status:503,headers:response.headers}):response;}
}
