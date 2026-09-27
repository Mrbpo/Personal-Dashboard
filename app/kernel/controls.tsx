'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import styles from './kernel.module.css';

async function post(url: string, body: unknown) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
}

export function TaskStatusControl({ taskId, current }: { taskId: string; current: string }) {
  const router = useRouter();
  const [status, setStatus] = useState(current);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await post('/kernel/api/task', { taskId, status });
      setMessage('状态已保存'); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }
  return <form className={styles.control} onSubmit={submit}>
    <label>任务状态 <select value={status} onChange={event => setStatus(event.target.value)} disabled={busy}>
      <option value="active">进行中</option><option value="completed">已完成</option><option value="ignored">忽略</option>
    </select></label>
    <button type="submit" disabled={busy || status === current}>{busy ? '保存中…' : '保存'}</button>
    {message && <span role="status">{message}</span>}
  </form>;
}

export function CandidateControl({ candidateId, canAccept, explanation }: {
  candidateId: string; canAccept: boolean; explanation?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const decision = submitter?.value;
    if (decision !== 'accept' && decision !== 'reject') return;
    const reason = new FormData(form).get('reason');
    setBusy(true); setMessage('');
    try {
      await post('/kernel/api/candidate', { candidateId, decision, reason });
      form.reset(); setMessage(decision === 'accept' ? '已接受' : '已拒绝'); router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : '审核失败'); }
    finally { setBusy(false); }
  }
  return <form className={styles.control} onSubmit={submit}>
    <label>审核理由 <input name="reason" required maxLength={2000} disabled={busy} /></label>
    <button type="submit" value="accept" disabled={busy || !canAccept}>接受</button>
    <button type="submit" value="reject" disabled={busy}>拒绝</button>
    {explanation && <span>{explanation}</span>}
    {message && <span role="status">{message}</span>}
  </form>;
}
