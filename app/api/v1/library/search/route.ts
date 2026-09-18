import { getCurrentOwner, requireOwnerApi } from '@/lib/authz';
import { searchLibrary } from '@/lib/library';
import { listCourseSettings } from '@/lib/repository';

export async function GET(request:Request){
  const denied=await requireOwnerApi();if(denied)return denied;
  try{
    const owner=(await getCurrentOwner())!,params=new URL(request.url).searchParams;
    const query=(params.get('q')||'').trim().slice(0,500),course=params.get('courseId')||'';
    if(query.length<2)throw new Error('请输入至少两个字符');
    if(course&&!(await listCourseSettings()).some(item=>item.enabled&&(item.id===course||item.code===course)))throw new Error('课程无效');
    const resolved=course?(await listCourseSettings()).find(item=>item.id===course||item.code===course)?.id||course:'';
    const matches=await searchLibrary(owner.userId,query,resolved,true);
    return Response.json({matches:matches.map(item=>({documentId:item.document_id,courseId:item.course_id,title:item.name,locator:item.locator,excerpt:item.body,score:item.score,url:`/api/library/${item.document_id}`})),count:matches.length},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return Response.json({error:error instanceof Error&&/^[\u3400-\u9fff]/.test(error.message)?error.message:'搜索失败'},{status:400});}
}
