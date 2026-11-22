import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner,readRecordingManifest,buildRecordingCatalog} from '@/lib/recording-catalog';
import {recordingTargetConfig} from '@/lib/recording-storage';
import {guideFiles,readGuideManifest,readGuideAsset,type GuideFormat} from '@/lib/recording-guide';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  assertRecordingOwner(await apiOwner(request));
  const {id}=await params;
  if(!/^[a-f0-9]{64}$/.test(id))return Response.json({error:'录像不存在'},{status:404,headers});
  const {objects}=buildRecordingCatalog(await readRecordingManifest(),recordingTargetConfig()),object=objects.get(id);
  if(!object)return Response.json({error:'录像不存在'},{status:404,headers});
  const query=new URL(request.url).searchParams,format=query.get('format');
  const version=query.get('version'),edition=query.get('edition');
  if((format!==null&&!Object.hasOwn(guideFiles,format))||(query.has('download')&&query.get('download')!=='1')||
     (version!==null&&!/^[a-f0-9]{64}$/.test(version))||(edition!==null&&edition!=='reviewed')||(version&&edition))
    return Response.json({error:'讲义格式无效'},{status:400,headers});
  // Old outline links always refer to the previously reviewed sample.
  const selection=edition??version??((format==='outlinePdf'||format==='outlineText')?'reviewed':undefined);
  const manifest=await readGuideManifest(object,selection);
  if(!format){
   if(!manifest)return Response.json({available:false},{headers});
   const partial=manifest.clipStartMs>0||object.durationSeconds===null||manifest.clipEndMs<object.durationSeconds*1000-1000;
   const base={available:true,clipStartMs:manifest.clipStartMs,clipEndMs:manifest.clipEndMs,partial};
   if(manifest.schemaVersion===1)return Response.json({...base,reviewed:true},{headers});
   return Response.json({...base,version:manifest.version,courseName:manifest.courseName,publishedAt:manifest.publishedAt,
    frameCount:manifest.frameCount,translatedCues:manifest.translatedCues,totalCues:manifest.totalCues,
    hasReviewed:!!await readGuideManifest(object,'reviewed')},{headers});
  }
  if(!manifest||!Object.hasOwn(manifest.files,format))
    return Response.json({error:'此录像暂无该讲义文件'},{status:404,headers});
  const kind=format as GuideFormat,asset=await readGuideAsset(object,manifest,kind);
  let body:BodyInit=new Uint8Array(asset);
  if(kind==='html'&&manifest.schemaVersion===1){
   const base=`/api/recordings/${id}/guide?edition=reviewed&amp;`;
   body=asset.toString('utf8').replaceAll('output/pdf/course-slide-learning-detailed.pdf',base+'format=pdf&amp;download=1')
    .replaceAll('output/pdf/course-outline-detailed.pdf',base+'format=outlinePdf&amp;download=1')
    .replaceAll('course-outline-detailed.txt',base+'format=outlineText&amp;download=1')
    .replaceAll('course-slide-learning-detailed.html',base+'format=html&amp;download=1');
  }
  return new Response(body,{headers:{...headers,'Content-Type':guideFiles[kind].mime,
   'Content-Disposition':`${query.has('download')||kind==='outlineText'?'attachment':'inline'}; filename="${guideFiles[kind].name}"`,
   'Content-Security-Policy':"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-downloads allow-top-navigation-by-user-activation"}});
 }catch(error){const response=apiError(error);return response.status===400?new Response(response.body,{status:503,headers}):response;}
}
