import {cookies} from 'next/headers';
import {apiOwner} from '@/lib/api-guard';
import {gmailCallback} from '@/lib/gmail';
export async function GET(r:Request){const jar=await cookies();try{const owner=await apiOwner(r),q=new URL(r.url).searchParams;await gmailCallback(q.get('code')||'',q.get('state')||'',jar.get('gmail_oauth')?.value||'',owner);return Response.redirect(new URL('/mail?connected=1',r.url));}catch{return Response.redirect(new URL('/mail?error=oauth',r.url));}finally{jar.delete({name:'gmail_oauth',path:'/api/mail/callback'});}}
