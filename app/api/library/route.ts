import {apiOwner,apiError,boundedForm} from '@/lib/api-guard';
import {listDocuments,saveDocument,MAX_LIBRARY_BYTES,type DocumentRow} from '@/lib/library';
import {validateAttachment} from '@/lib/tutor';
import {enqueue} from '@/lib/jobs';
import {listCourseSettings} from '@/lib/repository';
import {classifyContentMetadata} from '@/lib/kernel/content-tags';
function documentTypes(document:DocumentRow){
 try{return classifyContentMetadata({courseId:document.course_id||null,termId:null,origin:document.origin,
  originKey:document.origin_key,name:document.original_name||document.name,mime:document.mime},'catalog-v2')
  .tags.filter(tag=>tag.facet==='document_type').map(tag=>tag.key);}
 catch{return [];}
}
export async function GET(r:Request){try{
 const owner=await apiOwner(r);
 const [documents,courses]=await Promise.all([listDocuments(owner),listCourseSettings().catch(()=>[])]);
 const courseMap=new Map(courses.map(course=>[course.id,course]));
 return Response.json(documents.map(document=>({...document,course_code:courseMap.get(document.course_id)?.code,
  course_name:courseMap.get(document.course_id)?.name,
  document_types:documentTypes(document)})),{headers:{'Cache-Control':'no-store'}});
}catch(e){return apiError(e);}}
export async function POST(r:Request){try{const owner=await apiOwner(r),f=await boundedForm(r,MAX_LIBRARY_BYTES+1024*1024),file=f.get('file');if(!(file instanceof File))throw new Error('请选择文件');const course=String(f.get('courseId')||''),folderPath=String(f.get('folderPath')||'上传').slice(0,1000);if(course&&!(await listCourseSettings()).some(c=>c.id===course&&c.enabled))throw new Error('课程无效');const bytes=new Uint8Array(await file.arrayBuffer()),a=validateAttachment(file.name,bytes,MAX_LIBRARY_BYTES);const id=await saveDocument(owner,course,'upload',String(f.get('originKey')||a.name).slice(0,500),a.name,a.mime,bytes,folderPath,file.name!==a.name?file.name:undefined);await enqueue('index',{owner,id},`index:${id}`);return Response.json({id,folderPath});}catch(e){return apiError(e);}}
