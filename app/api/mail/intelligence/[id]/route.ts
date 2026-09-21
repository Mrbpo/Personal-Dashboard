import {apiOwner,apiError} from '@/lib/api-guard';
import {analyzeMailIntelligence,getMailIntelligence} from '@/lib/mail-intelligence';

export async function GET(r:Request,{params}:{params:Promise<{id:string}>}){try{return Response.json(await getMailIntelligence(await apiOwner(r),(await params).id),{headers:{'Cache-Control':'no-store'}});}catch(error){return apiError(error);}}
export async function POST(r:Request,{params}:{params:Promise<{id:string}>}){try{const body=await r.json().catch(()=>({}));return Response.json(await analyzeMailIntelligence(await apiOwner(r),(await params).id,Boolean(body.reprocess)));}catch(error){return apiError(error);}}
