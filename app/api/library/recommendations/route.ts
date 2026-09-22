import {apiOwner,apiError} from '@/lib/api-guard';
import {recommendLibraryForNow} from '@/lib/library';
import {listCourseSettings} from '@/lib/repository';

export async function GET(request:Request){
  try{
    const owner=await apiOwner(request),course=new URL(request.url).searchParams.get('course')||'';
    if(!course)throw new Error('请先选择课程');
    if(!(await listCourseSettings()).some(item=>item.id===course&&item.enabled))throw new Error('课程无效');
    return Response.json(await recommendLibraryForNow(owner,course),{headers:{'Cache-Control':'no-store'}});
  }catch(error){return apiError(error);}
}
