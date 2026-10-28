"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export function SettingsForm({ initial }: { initial: { timezone: string; displayName?: string } }) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initial.displayName || "");
  const [timezone, setTimezone] = useState(initial.timezone);
  const [message, setMessage] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage("正在保存…");
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone, displayName }),
    });
    setMessage(response.ok ? "设置已保存" : "保存失败，请稍后再试");
    if (response.ok) router.refresh();
  }

  return (
    <form onSubmit={save} className="max-w-xl space-y-6 rounded-3xl border bg-card p-6 shadow-sm">
      <div className="space-y-2">
        <Label htmlFor="display-name">显示姓名</Label>
        <Input id="display-name" autoComplete="nickname" maxLength={40} placeholder="你希望网站怎么称呼你" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="timezone">时区</Label>
        <Input id="timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
        <p className="text-sm text-muted-foreground">临近截止及最近一周逾期按此时区显示；仅日期的截止按全天显示。</p>
      </div>
      <div className="flex items-center gap-3"><Button type="submit" className="rounded-xl">保存设置</Button><span aria-live="polite" className="text-sm text-muted-foreground">{message}</span></div>
    </form>
  );
}
