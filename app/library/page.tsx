import {PageFrame} from '@/components/page-frame';
import {LibraryCenter} from '@/components/library-center';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/library');return <PageFrame eyebrow="PRIVATE LIBRARY" title="课程资料库" description="按课程与 Canvas 目录逐层浏览，用共同关键词精确查找，并根据当前教学周推荐课堂资料。">{authorized?<LibraryCenter courses={(await listCourseSettings()).filter(c=>c.enabled).map(c=>({id:c.id,code:c.code}))}/>:<a href="/login">请先登录</a>}</PageFrame>;}
