import {PageFrame} from '@/components/page-frame';
import {LibraryCenter} from '@/components/library-center';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/library');return <PageFrame eyebrow="PRIVATE LIBRARY" title="资料库与后台任务" description="保存原件与版本，按课程检索。每天 03:00 增量维护语义索引。">{authorized?<LibraryCenter courses={(await listCourseSettings()).filter(c=>c.enabled).map(c=>({id:c.id,code:c.code}))}/>:<a href="/login">请先登录</a>}</PageFrame>;}
