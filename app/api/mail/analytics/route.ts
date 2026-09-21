import {apiOwner,apiError} from '@/lib/api-guard';
import {mailAnalytics} from '@/lib/mail-intelligence';

export async function GET(r:Request){try{return Response.json(await mailAnalytics(await apiOwner(r)),{headers:{'Cache-Control':'no-store'}});}catch(error){return apiError(error);}}
