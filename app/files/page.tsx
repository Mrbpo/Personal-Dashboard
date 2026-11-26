import {CourseFileBrowser} from '@/components/course-file-browser';
import {PageFrame} from '@/components/page-frame';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
export const dynamic='force-dynamic';
export default async function FilesPage(){
  const {authorized}=await requireOwnerPage('/files');
  return <PageFrame title="文件树" eyebrow="">{authorized?<CourseFileBrowser courses={(await listCourseSettings()).filter(c=>c.enabled).map(c=>({id:c.id,name:c.name||c.code}))}/>:<a href="/login">请先登录</a>}</PageFrame>;
}
