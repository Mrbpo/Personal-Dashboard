import {apiOwner,apiError} from '@/lib/api-guard';
import {enqueue,listJobs} from '@/lib/jobs';
import {budgetStatus} from '@/lib/ai-budget';
import {database as db} from '@/lib/database';
import {retryIngestionJob,retryOutboxJob} from '@/lib/kernel/jobs';
export async function GET(r:Request){try{await apiOwner(r);return Response.json({jobs:await listJobs(),budget:await budgetStatus(),worker:await db.prepare("SELECT * FROM worker_state WHERE id='primary'").first()},{headers:{'Cache-Control':'no-store'}});}catch(e){return apiError(e);}}
export async function POST(r:Request){try{const owner=await apiOwner(r),b=await r.json();if(b.retry){const id=String(b.retry);if(!await retryIngestionJob(id)&&!await retryOutboxJob(id))await db.prepare("UPDATE background_jobs SET status='queued',attempts=0,error=NULL,available_at=? WHERE id=? AND status='failed'").bind(Date.now(),id).run();return Response.json({ok:true});}if(!['canvas','gmail','piazza','night'].includes(b.kind))throw new Error('任务类型无效');return Response.json({id:await enqueue(b.kind,{owner})});}catch(e){return apiError(e);}}
