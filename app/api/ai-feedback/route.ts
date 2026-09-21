import {apiOwner,apiError} from '@/lib/api-guard';
import {aiFeedbackSummary,saveAiFeedback} from '@/lib/ai-feedback';

export async function GET(r:Request){try{return Response.json(await aiFeedbackSummary(await apiOwner(r)),{headers:{'Cache-Control':'no-store'}});}catch(error){return apiError(error);}}
export async function POST(r:Request){try{return Response.json(await saveAiFeedback(await apiOwner(r),await r.json()));}catch(error){return apiError(error);}}
