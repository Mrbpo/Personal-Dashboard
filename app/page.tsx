import { env } from "cloudflare:workers";
import { requireChatGPTUser } from "./chatgpt-auth";
import { DashboardShell } from "@/components/dashboard-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await requireChatGPTUser("/");
  const ownerEmail = typeof env.OWNER_EMAIL === "string" ? env.OWNER_EMAIL.trim().toLowerCase() : "";

  if (ownerEmail && user.email.toLowerCase() !== ownerEmail) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6">
        <section className="max-w-md rounded-3xl border bg-card p-8 text-center shadow-sm">
          <p className="text-sm font-semibold text-destructive">无法访问</p>
          <h1 className="mt-2 text-2xl font-semibold">这个学习空间属于另一位用户</h1>
          <p className="mt-3 text-muted-foreground">请使用网站所有者的 ChatGPT 账号登录。</p>
        </section>
      </main>
    );
  }

  return <DashboardShell displayName={user.fullName ?? user.email.split("@")[0]} />;
}
