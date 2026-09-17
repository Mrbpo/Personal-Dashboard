import {apiOwner,apiError} from '@/lib/api-guard';
import {confirmReview} from '@/lib/review-schedule';
export async function POST(r:Request){try{return Response.json(await confirmReview(await apiOwner(r),await r.json()));}catch(e){return apiError(e);}}
