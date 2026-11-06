import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireOwnerPage } from '@/lib/authz';
import { getSettings, listCourseSettings } from '@/lib/repository';
import { studyAnswerBackend } from '@/lib/study-answer';
import { hasCustomOwnerPassword } from '@/lib/owner-password';
import { resolveSection, sectionHref } from '@/lib/uiv2/sections';
import { ConsoleDashboard } from '@/components/uiv2/dashboard';
import { StudyWorkbench } from '@/components/study-workbench';
import { LibraryCenter } from '@/components/library-center';
import { RecordingPlayer } from '@/components/recording-player';
import { RecordingSyncControl } from '@/components/recording-sync-control';
import { MailCenter } from '@/components/mail-center';
import { HealthDashboard } from '@/components/health-dashboard';
import { AiUsagePanel } from '@/components/ai-usage-panel';
import { SettingsForm } from '@/components/settings-form';
import { CourseSettings } from '@/components/course-settings';
import { AccessPasswordSettings } from '@/components/access-password-settings';
import { ServiceSettings } from '@/components/service-settings';
import { GmailImportSettings } from '@/components/gmail-import-settings';
import { AiFeedbackSettings } from '@/components/ai-feedback-settings';
import { BackgroundTasksSettings } from '@/components/background-tasks-settings';
import { DeploymentSettings } from '@/components/deployment-settings';
import styles from '@/components/uiv2/console.module.css';

export const dynamic = 'force-dynamic';
export default async function ConsolePage({ params }: { params: Promise<{ section?: string[] }> }) {
  const { section: parts } = await params;
  const resolved = resolveSection(parts);
  if (!resolved) notFound();
  const { section, classicDetail } = resolved;
  // Layouts and pages render independently; guard here before every private loader.
  const { user, authorized } = await requireOwnerPage(sectionHref(section.key));
  if (!authorized) return null;
  if (classicDetail) return <section className={styles.panel}><p className={styles.kicker}>CLASSIC DETAIL VIEW</p><h1>在经典界面继续</h1><p>课程详情与文档阅读器保留原有完整功能，不在此重建。</p><Link href={classicDetail}>打开{section.label}详情 ↗</Link><p><Link href={sectionHref(section.key)}>返回{section.label}</Link></p></section>;
  const settings = await getSettings(user.userId);
  const needsCourses = ['study', 'library', 'mail', 'settings'].includes(section.key);
  const courses = needsCourses ? await listCourseSettings() : [];
  const enabled = courses.filter(course => course.enabled).map(course => ({ id: course.id, code: course.code }));
  return <>
    <header className={styles.pageHeader}><div><p className={styles.kicker}>{section.english} / {section.group}</p><h1>{section.label}</h1><p>{section.key === 'overview' ? `${settings.displayName || user.fullName} 的工作空间。先查看状态，再处理事项。` : section.description}</p></div><Link className={styles.classicLink} href={section.classic}>经典{section.label} ↗</Link></header>
    <div className={styles.embedded}>
      {(['overview', 'tasks', 'courses'] as string[]).includes(section.key) && <ConsoleDashboard timezone={settings.timezone} mode={section.key as 'overview' | 'tasks' | 'courses'} />}
      {section.key === 'study' && <StudyWorkbench courses={enabled} kernelEnabled={studyAnswerBackend() === 'kernel'} factsOnly={process.env.STUDY_FACTS_ONLY === 'true'} />}
      {section.key === 'library' && <LibraryCenter courses={enabled} />}
      {section.key === 'recordings' && <><RecordingSyncControl /><RecordingPlayer /></>}
      {section.key === 'mail' && <MailCenter courses={enabled} />}
      {section.key === 'health' && <HealthDashboard />}
      {section.key === 'ai-usage' && <AiUsagePanel />}
      {section.key === 'settings' && <div className={styles.settingsStack}><SettingsForm initial={settings} /><section className={styles.panel}><h2>显示的课程</h2><CourseSettings initial={courses} /></section><AccessPasswordSettings configured={hasCustomOwnerPassword()} /><ServiceSettings /><GmailImportSettings /><AiFeedbackSettings /><p><Link href="/settings">Piazza 授权与连接状态在经典设置中管理 ↗</Link></p></div>}
      {section.key === 'system' && <><BackgroundTasksSettings timezone={settings.timezone} /><DeploymentSettings /><section className={styles.panel}><h2>工作空间与核验</h2><div className={styles.systemLinks}><a href="/hermes/">Hermes ↗</a><a href="/terminal/">服务器终端 ↗</a><Link href="/kernel">已确认事实与待核实候选（经典）↗</Link><Link href="/changes">最近变更（经典）↗</Link></div></section></>}
    </div>
  </>;
}
