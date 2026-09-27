import styles from './kernel.module.css';

export default function Loading() {
  return <main className={styles.kernel} role="status"><h1>Kernel</h1><p>正在读取资料…</p></main>;
}
