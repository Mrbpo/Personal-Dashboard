import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner,readRecordingManifest,buildRecordingCatalog} from '@/lib/recording-catalog';
import {recordingStorageConfig,recordingPlaybackUrl} from '@/lib/recording-storage';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  assertRecordingOwner(await apiOwner(request));
  const {id}=await params;
  if(!/^[a-f0-9]{64}$/.test(id))return Response.json({error:'录像不存在'},{status:404});
  const config=recordingStorageConfig();
  const {objects}=buildRecordingCatalog(await readRecordingManifest(),config);
  const object=objects.get(id);
  if(!object)return Response.json({error:'录像不存在或尚未完成私有归档'},{status:404});
  // Redirect preserves Range. Video bytes stream straight from private R2, not this server.
  const url=await recordingPlaybackUrl(object);
  return new Response(null,{status:307,headers:{Location:url,'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer'}});
 }catch(error){
  const response=apiError(error);
  return response.status===400?new Response(response.body,{status:503,headers:response.headers}):response;
 }
}
