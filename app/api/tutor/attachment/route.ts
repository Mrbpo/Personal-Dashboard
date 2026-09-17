import { apiOwner,apiError } from '@/lib/api-guard';
import { tutorAttachment } from '@/lib/tutor';
export async function GET(r:Request){try{const q=new URL(r.url).searchParams,a=await tutorAttachment(await apiOwner(r),q.get('message')||'',Number(q.get('index')));return new Response(Buffer.from(a.data,'base64'),{headers:{'Content-Type':a.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}});}catch(e){return apiError(e);}}
