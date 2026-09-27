'use client';

import styles from './kernel.module.css';

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className={styles.kernel} role="alert">
    <h1>Kernel</h1><p>资料暂时无法读取。</p><button type="button" onClick={reset}>重试</button>
  </main>;
}
