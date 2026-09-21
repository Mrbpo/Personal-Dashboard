import {apiOwner,apiError} from '@/lib/api-guard';
import {recordMailFeedback} from '@/lib/mail-intelligence';

export async function POST(r:Request){try{const owner=await apiOwner(r),body=await r.json();return Response.json(await recordMailFeedback(owner,String(body.emailId||''),String(body.field||''),body.value,String(body.reason||'')));}catch(error){return apiError(error);}}
