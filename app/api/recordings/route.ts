import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner,readRecordingManifest,buildRecordingCatalog} from '@/lib/recording-catalog';
import {recordingTargetConfig} from '@/lib/recording-storage';
import {listCourseSettings} from '@/lib/repository';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request){
 try{
  assertRecordingOwner(await apiOwner(request));
  const config=recordingTargetConfig();
  const [manifest,courses]=await Promise.all([readRecordingManifest(),listCourseSettings().catch(()=>[])]);
  const names=new Map(courses.map(c=>[c.id,[c.code,c.name].filter(Boolean).join(' · ')]));
  return Response.json(buildRecordingCatalog(manifest,config,names).catalog,{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){
  const response=apiError(error);
  return response.status===400?new Response(response.body,{status:503,headers:response.headers}):response;
 }
}
