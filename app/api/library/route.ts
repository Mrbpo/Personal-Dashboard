import {apiOwner,apiError,boundedForm} from '@/lib/api-guard';
import {listDocuments,saveDocument,MAX_LIBRARY_BYTES} from '@/lib/library';
import {validateAttachment} from '@/lib/tutor';
import {enqueue} from '@/lib/jobs';
import {listCourseSettings} from '@/lib/repository';
export async function GET(r:Request){try{return Response.json(await listDocuments(await apiOwner(r)),{headers:{'Cache-Control':'no-store'}});}catch(e){return apiError(e);}}
export async function POST(r:Request){try{const owner=await apiOwner(r),f=await boundedForm(r,MAX_LIBRARY_BYTES+1024*1024),file=f.get('file');if(!(file instanceof File))throw new Error('请选择文件');const course=String(f.get('courseId')||'');if(course&&!(await listCourseSettings()).some(c=>c.id===course&&c.enabled))throw new Error('课程无效');const bytes=new Uint8Array(await file.arrayBuffer()),a=validateAttachment(file.name,bytes,MAX_LIBRARY_BYTES);const id=await saveDocument(owner,course,'upload',String(f.get('originKey')||a.name).slice(0,500),a.name,a.mime,bytes);await enqueue('index',{owner,id},`index:${id}`);return Response.json({id});}catch(e){return apiError(e);}}
