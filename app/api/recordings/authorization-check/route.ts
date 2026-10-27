import {apiOwner,apiError} from '@/lib/api-guard';
import {assertRecordingOwner} from '@/lib/recording-catalog';
import {recordingControlStatus} from '@/lib/recording-control';
export const dynamic='force-dynamic';
export async function GET(request:Request){try{
 assertRecordingOwner(await apiOwner(request));
 const status=await recordingControlStatus();
 return new Response(null,{status:status.configured&&status.authorizationActive?204:409,headers:{'Cache-Control':'no-store'}});
}catch(error){return apiError(error);}}
