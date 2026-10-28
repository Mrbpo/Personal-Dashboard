import {PageFrame} from '@/components/page-frame';
import {MailCenter} from '@/components/mail-center';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/mail');return <PageFrame eyebrow="CORRESPONDENCE" title="邮件中心">{authorized?<MailCenter courses={(await listCourseSettings()).filter(c=>c.enabled).map(c=>({id:c.id,code:c.code}))}/>:<a href="/login">请先登录</a>}</PageFrame>;}
