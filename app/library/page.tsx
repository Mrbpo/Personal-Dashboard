import {PageFrame} from '@/components/page-frame';
import {LibraryCenter} from '@/components/library-center';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/library');return <PageFrame eyebrow="PRIVATE LIBRARY" title="课程资料库">{authorized?<LibraryCenter courses={(await listCourseSettings()).filter(c=>c.enabled).map(c=>({id:c.id,code:c.code}))}/>:<a href="/login">请先登录</a>}</PageFrame>;}
