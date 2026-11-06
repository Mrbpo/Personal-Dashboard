import type { Metadata } from 'next';
import Link from 'next/link';
import { requireOwnerPage } from '@/lib/authz';
import { ConsoleShell } from '@/components/uiv2/console-shell';
import styles from '@/components/uiv2/console.module.css';

export const metadata: Metadata = { title: 'Study Console · UI v2' };
export const dynamic = 'force-dynamic';

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const { authorized } = await requireOwnerPage('/uiv2');
  return <ConsoleShell>{authorized ? children : <section className={styles.panel}><p className={styles.kicker}>PRIVATE WORKSPACE</p><h1>请先登录</h1><p>请使用学习空间的访问密码登录。未登录时不读取或显示私人数据。</p><Link href="/login">前往登录 ↗</Link></section>}</ConsoleShell>;
}
