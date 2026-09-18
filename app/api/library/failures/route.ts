import {apiOwner,apiError} from '@/lib/api-guard';
import {listSourceFailures} from '@/lib/library';

export async function GET(request:Request){try{return Response.json({failures:await listSourceFailures(await apiOwner(request))},{headers:{'Cache-Control':'no-store'}});}catch(error){return apiError(error);}}
