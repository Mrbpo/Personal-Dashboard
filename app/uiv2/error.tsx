'use client';
import Link from 'next/link';
import styles from '@/components/uiv2/console.module.css';

export default function ConsoleError({ reset }: { reset: () => void }) {
  return <section className={styles.panel} role="alert"><p className={styles.kicker}>VIEW UNAVAILABLE</p><h1>当前视图暂不可用</h1><p>未能读取此模块的数据。导航仍可使用，请重试或进入经典界面检查。</p><div className={styles.systemLinks}><button onClick={reset}>重新读取</button><Link href="/uiv2">返回总览</Link><Link href="/">经典界面 ↗</Link></div></section>;
}
