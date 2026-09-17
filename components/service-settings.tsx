'use client';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { serviceFields } from '@/lib/service-fields';
import { ChatGPTSettings } from './chatgpt-settings';
type Field = (typeof serviceFields)[number] & { configured: boolean; value: string; source: string };
export function ServiceSettings() {
  const [fields, setFields] = useState<Field[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { fetch('/api/services').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setFields).catch(() => setMessage('无法读取服务配置')); }, []);
  async function save() {
    setBusy(true);
    try {
      const response = await fetch('/api/services', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
      if (!response.ok) throw new Error();
      setFields(await response.json()); setDraft({}); setMessage('已加密保存，下次请求立即使用新配置。');
    } catch { setMessage('保存失败，请稍后重试'); } finally { setBusy(false); }
  }
  return <><ChatGPTSettings /><section id="services" className="parchment-panel mt-6 p-5">
    <h2 className="text-xl font-semibold">服务连接与 API 配置</h2>
    <p className="mt-2 text-sm text-muted-foreground">密钥只保存在本机服务器，不回传明文。未修改的字段保持原值；移除会停用该密钥。</p>
    <div className="mt-5 grid gap-5 lg:grid-cols-2">{[...new Set(serviceFields.map(f => f.group))].map(group => <fieldset key={group} className="min-w-0 rounded-lg border p-4"><legend className="px-2 font-semibold">{group}</legend>{fields.filter(f => f.group === group).map(f => <div key={f.key} className="mt-3 space-y-1"><Label htmlFor={f.key}>{f.label} · {f.configured ? '已配置' : '未配置'}</Label><div className="flex gap-2"><Input id={f.key} type={f.secret ? 'password' : 'text'} autoComplete="off" value={draft[f.key] ?? f.value} placeholder={f.configured && f.secret ? '已保存，填写以替换' : f.key === 'GOOGLE_HEALTH_REDIRECT_URI' ? 'http://localhost:3000/api/health/callback' : ''} onChange={e => setDraft({ ...draft, [f.key]: e.target.value })} /><Button variant="outline" type="button" onClick={() => setDraft({ ...draft, [f.key]: '' })}>移除</Button></div>{draft[f.key] === '' && <p className="text-xs text-amber-800">保存后停用此项</p>}</div>)}</fieldset>)}</div>
    <div className="mt-5 flex flex-wrap items-center gap-3"><Button disabled={busy || !Object.keys(draft).length} onClick={save}>{busy ? '保存中…' : '保存服务配置'}</Button><span role="status" className="text-sm">{message}</span></div>
    <p className="mt-3 text-sm">Fitbit 使用 Google Health 授权。<a className="underline" href="https://developers.google.com/health/setup" target="_blank" rel="noreferrer">创建 Google OAuth 应用</a>，类型选 Web application，并登记上面的回调地址，然后前往健康模块连接。</p>
  </section></>;
}
