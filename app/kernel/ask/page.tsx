import type { Metadata } from 'next';
import Link from 'next/link';
import { requireOwnerPage } from '@/lib/authz';
import { kernel } from '@/lib/kernel/service';
import { KernelChat } from './chat';
import styles from './page.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '内核问答 · Study Cabinet' };

export default async function KernelAskPage() {
  const { authorized } = await requireOwnerPage('/kernel/ask');
  if (!authorized) return <main className={styles.page}><h1>内核问答</h1><p>请先登录。</p><Link href="/login">前往登录</Link></main>;
  const courses = (await kernel.listCourses()).filter(row => row.enabled).map(row => ({ id: String(row.id), code: String(row.code), name: String(row.name) }));
  return <main className={styles.page}>
    <header><h1>内核问答</h1><Link href="/kernel">查看内核记录</Link></header>
    <KernelChat courses={courses} />
  </main>;
}
