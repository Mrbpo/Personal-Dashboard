import { DashboardShell } from "@/components/dashboard-shell";
import { requireOwnerPage } from "@/lib/authz";
import Link from "next/link";
import { getSettings } from "@/lib/repository";

export const dynamic = "force-dynamic";

export default async function Home() {
  const { user, authorized } = await requireOwnerPage("/");
  if (!authorized) {
    return (
      <main className="grid min-h-screen place-items-center bg-background px-6">
        <section className="max-w-md rounded-3xl border bg-card p-8 text-center shadow-sm">
          <p className="text-sm font-semibold text-destructive">无法访问</p>
          <h1 className="mt-2 text-2xl font-semibold">这个学习空间属于另一位用户</h1>
          <p className="mt-3 text-muted-foreground">请输入此学习空间的访问密码。</p>
          <Link href="/login" className="mt-5 inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">进入登录页</Link>
        </section>
      </main>
    );
  }

  const settings = await getSettings(user.userId);
  return <DashboardShell displayName={settings.displayName || user.fullName} timezone={settings.timezone} />;
}
