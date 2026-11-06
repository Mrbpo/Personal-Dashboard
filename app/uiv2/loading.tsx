import styles from '@/components/uiv2/console.module.css';
export default function ConsoleLoading() {
  return <section className={styles.panel} role="status" aria-live="polite"><p className={styles.kicker}>LOADING VIEW</p><h2>正在读取工作空间…</h2><p>等待当前模块的真实数据。</p></section>;
}
