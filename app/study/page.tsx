import {PageFrame} from '@/components/page-frame';
import {StudyWorkbench} from '@/components/study-workbench';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
import {studyAnswerBackend} from '@/lib/study-answer';
export const dynamic='force-dynamic';
export default async function Page(){const {authorized}=await requireOwnerPage('/study'),factsOnly=process.env.STUDY_FACTS_ONLY==='true';return <PageFrame eyebrow="LEARNING JOURNAL" title={factsOnly?'课程事实查询':'学习对话与档案'} description={factsOnly?'查询已确认的课程安排与截止时间。PDF 问答暂时暂停，资料阅读保留。':'从一个问题开始，连接课程资料、原文与自己的理解。'}>{authorized?<StudyWorkbench kernelEnabled={studyAnswerBackend()==='kernel'} factsOnly={factsOnly} courses={(await listCourseSettings()).filter(c=>c.enabled).map(c=>({id:c.id,code:c.code}))}/>:<a href="/login">请先登录</a>}</PageFrame>;}
