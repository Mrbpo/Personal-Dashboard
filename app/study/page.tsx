import {PageFrame} from '@/components/page-frame';
import {StudyWorkbench} from '@/components/study-workbench';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
import {studyAnswerBackend} from '@/lib/study-answer';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/study');return <PageFrame eyebrow="LEARNING JOURNAL" title="学习对话与档案" description="从一个问题开始，连接课程资料、原文与自己的理解。">{authorized?<StudyWorkbench kernelEnabled={studyAnswerBackend()==='kernel'} courses={(await listCourseSettings()).filter(c=>c.enabled).map(c=>({id:c.id,code:c.code}))}/>:<a href="/login">请先登录</a>}</PageFrame>;}
