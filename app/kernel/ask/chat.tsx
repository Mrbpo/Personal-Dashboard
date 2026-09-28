'use client';

import { useState, type FormEvent } from 'react';
import styles from './page.module.css';

type Course = { id: string; code: string; name: string };
type Citation = { ref: string; sourceId: string; sourceType: string; title: string; excerpt: string; sourceUrl: string | null; courseCode: string };
type Turn = { role: 'user' | 'assistant'; text: string; citations?: Citation[]; coverage?: string;
  feedbackId?: string; rating?: number; feedbackOpen?: boolean; feedbackReason?: string; feedbackMessage?: string };

function sourceLink(value: string | null) {
  if (!value) return null;
  if (value.startsWith('/api/library/')) return value;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

export function KernelChat({ courses }: { courses: Course[] }) {
  const [courseId, setCourseId] = useState('');
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedbackBusy, setFeedbackBusy] = useState<number | null>(null);
  const [error, setError] = useState('');
  function updateTurn(index: number, value: Partial<Turn>) {
    setTurns(previous => previous.map((turn, position) => position === index ? { ...turn, ...value } : turn));
  }
  async function sendFeedback(index: number, rating: 1 | -1) {
    const turn = turns[index];
    if (!turn?.feedbackId || feedbackBusy !== null) return;
    setFeedbackBusy(index);
    try {
      const response = await fetch('/api/ai-feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceType: 'kernel-answer', sourceId: turn.feedbackId, rating,
          reason: turn.feedbackReason || '', metadata: { question: turns[index - 1]?.text || '', answer: turn.text.slice(0, 1800),
            courseId, citations: turn.citations?.map(item => item.sourceId) || [] } }) });
      if (!response.ok) throw new Error('反馈保存失败');
      updateTurn(index, { rating, feedbackOpen: false, feedbackMessage: '已记录，供后续复核。' });
    } catch (cause) { updateTurn(index, { feedbackMessage: cause instanceof Error ? cause.message : '反馈保存失败' }); }
    finally { setFeedbackBusy(null); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = question.trim();
    if (busy || input.length < 2) return;
    const history = turns.filter(turn => turn.role === 'user').slice(-4).map(turn => turn.text);
    setTurns(previous => [...previous, { role: 'user', text: input }]);
    setQuestion(''); setError(''); setBusy(true);
    try {
      const response = await fetch('/kernel/ask/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: input, courseId, history }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '回答失败');
      setTurns(previous => [...previous, { role: 'assistant', text: result.answer, citations: result.citations, coverage: result.coverage,
        feedbackId: result.feedbackId }]);
      if (!courseId && result.inferredCourseId && courses.some(course => course.id === result.inferredCourseId)) setCourseId(result.inferredCourseId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回答失败');
      setQuestion(input);
    } finally { setBusy(false); }
  }
  return <>
    <label className={styles.course}>课程
      <select value={courseId} onChange={event => setCourseId(event.target.value)} disabled={busy}>
        <option value="">自动判断 / 全部课程</option>
        {courses.map(course => <option key={course.id} value={course.id}>{course.code} · {course.name}</option>)}
      </select>
    </label>
    <div className={styles.turns} aria-live="polite">
      {turns.length === 0 && <p className={styles.hint}>问课程内容、任务截止或日程。回答会列出实际使用的来源。</p>}
      {turns.map((turn, index) => <article key={index} className={styles.turn}>
        <strong>{turn.role === 'user' ? '你' : '回答'}</strong>
        <p>{turn.text}</p>
        {turn.citations && turn.citations.length > 0 && <details><summary>来源 · {turn.citations.length}</summary><ul>
          {turn.citations.map(item => <li key={item.ref}><span>[{item.ref}] {item.courseCode} · {item.title}</span>
            {sourceLink(item.sourceUrl) && <> · <a href={sourceLink(item.sourceUrl)!} target="_blank" rel="noopener noreferrer">打开原文</a></>}
            {item.excerpt && <small>{item.excerpt}</small>}
          </li>)}
        </ul></details>}
        {turn.coverage && <small>{turn.coverage}</small>}
        {turn.role === 'assistant' && turn.feedbackId && <div className={styles.feedback}>
          <button type="button" disabled={feedbackBusy === index} onClick={() => void sendFeedback(index, 1)}>有帮助</button>
          <button type="button" disabled={feedbackBusy === index} onClick={() => updateTurn(index, { feedbackOpen: true })}>需改进</button>
          {turn.feedbackOpen && <><input aria-label="错误或遗漏" placeholder="哪里不准确或遗漏了？" maxLength={500}
            value={turn.feedbackReason || ''} onChange={event => updateTurn(index, { feedbackReason: event.target.value })} />
            <button type="button" disabled={feedbackBusy === index || !(turn.feedbackReason || '').trim()} onClick={() => void sendFeedback(index, -1)}>提交反馈</button></>}
          {turn.feedbackMessage && <small role="status">{turn.feedbackMessage}</small>}
        </div>}
      </article>)}
      {busy && <p role="status">正在查找资料并生成回答…</p>}
    </div>
    <form className={styles.form} onSubmit={submit}>
      <label htmlFor="kernel-question">问题</label>
      <textarea id="kernel-question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={600} rows={3} placeholder="输入问题" disabled={busy} />
      <button type="submit" disabled={busy || question.trim().length < 2}>发送</button>
      {error && <p role="alert">{error}</p>}
    </form>
  </>;
}
