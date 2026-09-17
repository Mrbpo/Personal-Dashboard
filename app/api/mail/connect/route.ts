import {cookies} from 'next/headers';
import {apiOwner,apiError} from '@/lib/api-guard';
import {gmailStart} from '@/lib/gmail';
export async function POST(r:Request){try{const start=gmailStart(await apiOwner(r));(await cookies()).set('gmail_oauth',start.cookie,{httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:600,path:'/api/mail/callback'});return Response.json({url:start.url});}catch(e){return apiError(e);}}
