'use client';

import { FormEvent, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function AccessPasswordSettings({ configured }: { configured: boolean }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setMessage('');
    if (password !== confirmation) { setMessage('两次输入的密码不一致'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/auth/password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '保存失败');
      setPassword(''); setConfirmation(''); setMessage('自定义登录密码已启用。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }
  return <section className="mt-6 rounded-3xl border bg-card p-6 shadow-sm">
    <h2 className="font-semibold">私人访问密码</h2>
    <p className="mt-2 text-sm text-muted-foreground">{configured ? '已设置自定义密码，可在这里替换。' : '设置一个容易记住但足够长的登录密码。'}服务器只保存加盐后的不可逆摘要；部署时生成的访问密钥仍可用于紧急恢复。</p>
    <form className="mt-4 grid max-w-xl gap-4" onSubmit={submit}>
      <div className="space-y-1"><Label htmlFor="new-owner-password">新密码</Label><Input id="new-owner-password" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 个字符，推荐 12 位以上长短语" required /></div>
      <div className="space-y-1"><Label htmlFor="confirm-owner-password">再次输入</Label><Input id="confirm-owner-password" type="password" autoComplete="new-password" minLength={8} maxLength={128} value={confirmation} onChange={event => setConfirmation(event.target.value)} required /></div>
      <div className="flex items-center gap-3"><Button type="submit" disabled={busy}>{busy ? '保存中…' : configured ? '更换自定义密码' : '启用自定义密码'}</Button><span role="status" className="text-sm">{message}</span></div>
    </form>
  </section>;
}
