"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

export function SettingsForm({ initial }: { initial: { timezone: string; dailyMinutes: number } }) {
  const [timezone, setTimezone] = useState(initial.timezone);
  const [dailyMinutes, setDailyMinutes] = useState(initial.dailyMinutes);
  const [message, setMessage] = useState("");

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setMessage("正在保存…");
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timezone, dailyMinutes }),
    });
    setMessage(response.ok ? "设置已保存" : "保存失败，请稍后再试");
  }

  return (
    <form onSubmit={save} className="max-w-xl space-y-6 rounded-3xl border bg-card p-6 shadow-sm">
      <div className="space-y-2">
        <Label htmlFor="timezone">时区</Label>
        <Input id="timezone" value={timezone} onChange={(event) => setTimezone(event.target.value)} />
        <p className="text-sm text-muted-foreground">Canvas 截止时间和每日计划都按此时区显示。</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="minutes">每天可用学习时间（分钟）</Label>
        <Input id="minutes" type="number" min={30} max={720} step={15} value={dailyMinutes} onChange={(event) => setDailyMinutes(Number(event.target.value))} />
      </div>
      <div className="flex items-center gap-3"><Button type="submit" className="rounded-xl">保存设置</Button><span aria-live="polite" className="text-sm text-muted-foreground">{message}</span></div>
    </form>
  );
}
