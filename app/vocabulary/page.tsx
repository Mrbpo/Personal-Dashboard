import {PageFrame} from '@/components/page-frame';
import {VocabularyPanel} from '@/components/vocabulary-panel';
import {requireOwnerPage} from '@/lib/authz';
import {listCourseSettings} from '@/lib/repository';
import {tutorState} from '@/lib/tutor';

export const dynamic='force-dynamic';
export default async function Page(){
  const {authorized,user}=await requireOwnerPage('/vocabulary');
  if(!authorized)return <PageFrame eyebrow="VOCABULARY" title="请先登录" description="登录后才可查看私人词汇。"><a href="/login">前往登录</a></PageFrame>;
  const [courses,state]=await Promise.all([listCourseSettings(),tutorState(user.userId)]);
  return <PageFrame eyebrow="VOCABULARY NOTEBOOK" title="生词本"><VocabularyPanel automatic={state.vocabulary} courses={courses.filter(course=>course.enabled).map(course=>({id:course.id,code:course.code}))}/></PageFrame>;
}
