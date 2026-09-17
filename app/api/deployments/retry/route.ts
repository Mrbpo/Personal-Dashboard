import {apiOwner,apiError} from '@/lib/api-guard';
import {retryDeployment} from '@/lib/deployments';
export async function POST(r:Request){try{await apiOwner(r);return Response.json(await retryDeployment(String((await r.json()).tag)));}catch(e){return apiError(e);}}
