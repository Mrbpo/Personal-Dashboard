import {apiOwner,apiError} from '@/lib/api-guard';
import {checkDeploymentUpdate} from '@/lib/deployments';
export async function GET(request:Request){
  try{await apiOwner(request);return Response.json(await checkDeploymentUpdate(),{headers:{'Cache-Control':'no-store'}});}
  catch(error){return apiError(error);}
}
