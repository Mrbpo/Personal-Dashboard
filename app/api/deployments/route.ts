import {apiOwner,apiError} from '@/lib/api-guard';
import {deploymentState} from '@/lib/deployments';
export async function GET(r:Request){try{await apiOwner(r);return Response.json(await deploymentState(),{headers:{'Cache-Control':'no-store'}});}catch(e){return apiError(e);}}
