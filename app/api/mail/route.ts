import {apiOwner,apiError} from '@/lib/api-guard';
import {mailState,analyzeMail} from '@/lib/gmail';
import {enqueue} from '@/lib/jobs';
import {archiveMail} from '@/lib/mail-library';
import {mailPage,analyzeMailThread} from '@/lib/mail-threads';
import {database as db} from '@/lib/database';
export async function GET(r:Request){try{const owner=await apiOwner(r),q=new URL(r.url).searchParams;return Response.json({...await mailState(owner),...await mailPage(owner,{query:q.get('q')||'',before:q.get('before')||'',thread:q.get('thread')||''})},{headers:{'Cache-Control':'no-store'}});}catch(e){return apiError(e);}}
export async function POST(r:Request){try{const owner=await apiOwner(r),b=await r.json();if(b.action==='thread-summary')return Response.json(await analyzeMailThread(owner,String(b.id)));if(b.action==='archive')return Response.json(await archiveMail(owner,String(b.id),String(b.courseId||''),b.attachment));if(b.action==='sync')return Response.json({job:await enqueue('gmail',{owner})});if(b.action==='analyze')return Response.json(await analyzeMail(owner,String(b.id)));if(b.action==='category'&&['学习','服务','账单','订阅','垃圾','其他'].includes(b.category)){const s=await mailState(owner);await db.prepare('UPDATE mail_messages SET category=? WHERE id=? AND account=?').bind(b.category,String(b.id),String(s.email||'')).run();return Response.json({ok:true});}throw new Error('操作无效');}catch(e){return apiError(e);}}
