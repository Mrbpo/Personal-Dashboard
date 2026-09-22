import {apiOwner,apiError} from '@/lib/api-guard';
import {searchLibrary} from '@/lib/library';
import {listCourseSettings} from '@/lib/repository';

export async function GET(request:Request){
  try{
    const owner=await apiOwner(request),params=new URL(request.url).searchParams;
    const query=(params.get('q')||'').trim().slice(0,500),course=params.get('course')||'',path=(params.get('path')||'').slice(0,1000);
    if(query.length<2)throw new Error('请输入至少两个字符');
    if(course&&!(await listCourseSettings()).some(item=>item.id===course&&item.enabled))throw new Error('课程无效');
    return Response.json({matches:await searchLibrary(owner,query,course,false,{strict:true,path,metadataFirst:true,limit:20})},{headers:{'Cache-Control':'no-store'}});
  }catch(error){return apiError(error);}
}
