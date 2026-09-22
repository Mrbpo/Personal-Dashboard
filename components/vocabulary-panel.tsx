'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Languages, Plus, Sparkles, Trash2, Volume2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { MiniAiFeedback } from '@/components/mini-ai-feedback';

type Course = { id: string; code: string };
type Example = { sentence: string; translation: string; note: string };
type Entry = {
  id: string;
  courseId: string;
  term: string;
  originalTerm: string;
  correctedTerm: string;
  correctionNote: string;
  category: string;
  phonetic: string;
  contexts: string[];
  meaning: string;
  language: string;
  partOfSpeech: string;
  examples: Example[];
  definitionStatus: string;
  exampleStatus: string;
  error: string | null;
  mastered: boolean;
  updatedAt: string;
};
type AutoWord = { term: string; meaning: string; example: string; courseId: string; threadId: string; mastered: boolean; count: number };

function speechLanguage(language: string) {
  const value = language.toLocaleLowerCase();
  if (value.includes('中文') || value.includes('chinese')) return 'zh-CN';
  if (value.includes('法') || value.includes('french')) return 'fr-FR';
  if (value.includes('西班牙') || value.includes('spanish')) return 'es-ES';
  if (value.includes('德') || value.includes('german')) return 'de-DE';
  if (value.includes('日') || value.includes('japanese')) return 'ja-JP';
  if (value.includes('韩') || value.includes('korean')) return 'ko-KR';
  return 'en-US';
}

export function VocabularyPanel({ automatic, courses }: { automatic: AutoWord[]; courses: Course[] }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [term, setTerm] = useState('');
  const [background, setBackground] = useState('');
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState('');
  const [message, setMessage] = useState('');
  const label = (id: string) => courses.find((item) => item.id === id)?.code || '通用词汇';

  async function load() {
    const response = await fetch('/api/vocabulary');
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    setEntries(json.entries || []);
  }

  useEffect(() => { void load().catch((error) => setMessage(error.message)); }, []);

  async function add() {
    if (!term.trim() || busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch('/api/vocabulary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term, background }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      setTerm(''); setBackground('');
      const correction = json.entry.originalTerm !== json.entry.term ? `，已纠正为“${json.entry.term}”` : '';
      setMessage(json.entry.definitionStatus === 'complete' ? `生词已保存${correction}，并完成自动分类。` : '生词已保存；AI 整理暂时失败，可稍后重试。');
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }

  async function action(id: string, actionName: 'define' | 'examples') {
    setActive(id + actionName); setMessage('');
    try {
      const response = await fetch('/api/vocabulary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, action: actionName }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      setMessage(actionName === 'examples' ? (json.entry.exampleStatus === 'complete' ? '例句已生成。' : '例句生成失败，可稍后重试。') : (json.entry.definitionStatus === 'complete' ? '纠错、分类和释义已更新。' : 'AI 整理失败，可稍后重试。'));
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); }
    finally { setActive(''); }
  }

  async function remove(entry: Entry) {
    if (!confirm(`移除生词“${entry.term}”？`)) return;
    setActive(entry.id + 'delete');
    try {
      const response = await fetch('/api/vocabulary', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: entry.id }) });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : '删除失败'); }
    finally { setActive(''); }
  }

  async function updateMastered(word: string, courseId: string, mastered: boolean) {
    const response = await fetch('/api/tutor', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ term: word, courseId, mastered }) });
    if (!response.ok) throw new Error((await response.json()).error);
  }

  async function mastered(entry: Entry, value: boolean) {
    setActive(entry.id + 'mastered');
    try { await updateMastered(entry.term, entry.courseId, value); await load(); }
    catch (error) { setMessage(error instanceof Error ? error.message : '更新失败'); }
    finally { setActive(''); }
  }

  function speak(entry: Entry) {
    if (!('speechSynthesis' in window)) { setMessage('当前浏览器不支持朗读。'); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(entry.term);
    utterance.lang = speechLanguage(entry.language);
    utterance.rate = 0.86;
    window.speechSynthesis.speak(utterance);
  }

  const manualTerms = useMemo(() => new Set(entries.map((entry) => entry.term.toLocaleLowerCase())), [entries]);
  const remainingAutomatic = automatic.filter((word) => !manualTerms.has(word.term.toLocaleLowerCase()));

  return <div className="space-y-5">
    <section className="rounded-2xl border bg-card p-5">
      <div className="flex items-start gap-3"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Languages className="size-5" /></span><div><h2 className="text-lg font-semibold">加入生词</h2><p className="mt-1 text-sm text-muted-foreground">只需输入词汇和可选背景。AI 会在后台纠错、分类、生成音标并结合语境解释。</p></div></div>
      <div className="mt-4 grid gap-3 md:grid-cols-[minmax(12rem,.7fr)_minmax(16rem,1.5fr)]">
        <label className="grid gap-1 text-sm font-medium">词汇框<input aria-label="生词" value={term} maxLength={100} onChange={(event) => setTerm(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void add(); } }} placeholder="例如：inertia；按 Enter 直接保存" className="rounded-xl border bg-background p-3 font-normal" /></label>
        <label className="grid gap-1 text-sm font-medium">背景框<textarea aria-label="生词背景" value={background} maxLength={6000} rows={4} onChange={(event) => setBackground(event.target.value)} placeholder="粘贴这个词来自的句子或段落（可选）" className="rounded-xl border bg-background p-3 font-normal" /></label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3"><Button disabled={busy || !term.trim()} onClick={() => void add()}><Plus className="size-4" />{busy ? 'AI 正在整理…' : '保存生词'}</Button><span className="text-xs text-muted-foreground">不需要选择课程或类别；背景仅用于纠错、判断词义与生成例句。</span></div>
      {message && <p className="mt-3 rounded-lg border p-2 text-sm" role="status">{message}</p>}
    </section>

    <section className="grid gap-4 lg:grid-cols-2">
      {entries.map((entry) => <article key={entry.id} className="rounded-2xl border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-xl font-semibold">{entry.term}</h3><Button size="xs" variant="outline" onClick={() => speak(entry)} aria-label={`朗读 ${entry.term}`}><Volume2 />朗读</Button></div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{entry.category && <Badge variant="secondary">{entry.category}</Badge>}{entry.phonetic && <span className="font-mono text-sm text-foreground">{entry.phonetic}</span>}{entry.language && <span>{entry.language}</span>}{entry.partOfSpeech && <span>· {entry.partOfSpeech}</span>}</div>
          </div>
          <Button size="icon-sm" variant="ghost" aria-label={`移除 ${entry.term}`} disabled={active.startsWith(entry.id)} onClick={() => void remove(entry)}><Trash2 className="size-4" /></Button>
        </div>
        {entry.originalTerm && entry.originalTerm.toLocaleLowerCase() !== entry.term.toLocaleLowerCase() && <p className="mt-3 rounded-lg bg-sky-50 px-3 py-2 text-xs text-sky-900">输入“{entry.originalTerm}”已纠正为“{entry.term}”{entry.correctionNote ? `：${entry.correctionNote}` : ''}</p>}
        {entry.definitionStatus === 'complete' ? <><p className="mt-4 text-sm leading-6">{entry.meaning}</p><MiniAiFeedback sourceType="vocabulary-definition" sourceId={entry.id} metadata={{ term: entry.term, category: entry.category }} /></> : entry.definitionStatus === 'pending' ? <p className="mt-4 animate-pulse text-sm text-muted-foreground">正在纠错、分类并生成释义…</p> : <div className="mt-4 rounded-lg border border-amber-700/30 p-3 text-sm text-amber-800"><p>{entry.error || 'AI 整理失败'}</p><Button className="mt-2" size="sm" variant="outline" disabled={Boolean(active)} onClick={() => void action(entry.id, 'define')}>重试</Button></div>}
        {entry.contexts.length > 0 && <details className="mt-4 rounded-xl bg-muted/45 p-3"><summary className="cursor-pointer text-sm font-medium">原始背景 · {entry.contexts.length} 条</summary><div className="mt-2 space-y-2 text-sm text-muted-foreground">{entry.contexts.map((context, index) => <p key={index} className="whitespace-pre-wrap border-l-2 pl-3">{context}</p>)}</div></details>}
        <div className="mt-4 flex flex-wrap items-center gap-3"><Button size="sm" variant="outline" disabled={Boolean(active) || entry.definitionStatus !== 'complete'} onClick={() => void action(entry.id, 'examples')}><Sparkles className="size-4" />{active === entry.id + 'examples' ? '生成中…' : entry.examples.length ? '重新生成例句' : '生成例句'}</Button><label className="text-xs text-muted-foreground"><input type="checkbox" checked={entry.mastered} disabled={Boolean(active)} onChange={(event) => void mastered(entry, event.target.checked)} /> 已掌握</label></div>
        {entry.examples.length > 0 && <div className="mt-4 border-t pt-4"><p className="mb-3 flex items-center gap-2 text-sm font-semibold"><BookOpen className="size-4 text-primary" />语境例句</p><ol className="space-y-3">{entry.examples.map((example, index) => <li key={index} className="rounded-xl bg-muted/40 p-3 text-sm"><p className="font-medium">{index + 1}. {example.sentence}</p><p className="mt-1 text-muted-foreground">{example.translation}</p>{example.note && <p className="mt-1 text-xs text-primary">{example.note}</p>}</li>)}</ol><MiniAiFeedback sourceType="vocabulary-example" sourceId={entry.id} metadata={{ term: entry.term, category: entry.category }} /></div>}
      </article>)}
      {!entries.length && <p className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground lg:col-span-2">还没有手动加入的生词。</p>}
    </section>

    {remainingAutomatic.length > 0 && <details className="rounded-2xl border bg-card p-5"><summary className="cursor-pointer font-semibold">从学习对话自动收集 · {remainingAutomatic.length} 个</summary><div className="mt-4 grid gap-3 md:grid-cols-2">{remainingAutomatic.map((word) => <article key={word.courseId + word.term} className="rounded-xl border p-4"><h3 className="font-semibold">{word.term}</h3><p className="my-2 text-sm">{word.meaning}</p><p className="text-sm text-muted-foreground">{word.example}</p><label className="mt-3 block text-xs"><input type="checkbox" checked={word.mastered} onChange={async (event) => { try { await updateMastered(word.term, word.courseId, event.target.checked); setMessage('掌握状态已更新。'); } catch (error) { setMessage(error instanceof Error ? error.message : '更新失败'); } }} /> 已掌握 · {label(word.courseId)} · 出现 {word.count} 次</label></article>)}</div></details>}
  </div>;
}
