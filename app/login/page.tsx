"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const [accessKey, setAccessKey] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    const response = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessKey }) });
    if (!response.ok) { const body = await response.json(); setError(body.error || "登录失败"); return; }
    router.replace("/"); router.refresh();
  }
  return <main className="grid min-h-screen place-items-center bg-background px-5"><form onSubmit={submit} className="w-full max-w-sm rounded-3xl border bg-card p-7 shadow-xl"><p className="section-kicker">PRIVATE ACCESS</p><h1 className="mt-2 text-2xl font-semibold">进入 Course Radar</h1><p className="mt-2 text-sm text-muted-foreground">这是你的私人课程数据库。</p><Input className="mt-6" type="password" value={accessKey} onChange={(event) => setAccessKey(event.target.value)} placeholder="访问密码" autoFocus /><Button className="mt-3 w-full" type="submit">登录</Button>{error && <p className="mt-3 text-sm text-destructive">{error}</p>}</form></main>;
}
