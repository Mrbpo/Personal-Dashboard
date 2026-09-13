import { PageFrame } from "@/components/page-frame";
import { SettingsForm } from "@/components/settings-form";
import { requireOwnerPage } from "@/lib/authz";
import { getSettings } from "@/lib/repository";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, authorized } = await requireOwnerPage("/settings");
  if (!authorized) return <PageFrame eyebrow="PRIVATE" title="无法访问">请使用网站所有者账号登录。</PageFrame>;
  const settings = await getSettings(user.userId).catch(() => ({ timezone: "America/Toronto", dailyMinutes: 150 }));
  const services = [
    { name: "Quercus", ready: Boolean(env.CANVAS_TOKEN), detail: env.CANVAS_BASE_URL || "https://q.utoronto.ca" },
    { name: "AI 分析", ready: Boolean(env.OPENAI_API_KEY), detail: env.OPENAI_MODEL || "gpt-5-mini" },
    { name: "Owner 限制", ready: Boolean(env.OWNER_EMAIL), detail: env.OWNER_EMAIL ? "已启用邮箱二次校验" : "由 Sites 私人访问控制保护" },
  ];
  return (
    <PageFrame eyebrow="PREFERENCES" title="学习计划设置" description="控制截止时间显示和每日任务容量。">
      <SettingsForm initial={settings} />
      <section className="mt-6 rounded-3xl border bg-card p-6 shadow-sm">
        <h2 className="font-semibold">连接状态</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {services.map((service) => (
            <div key={service.name} className="rounded-2xl border bg-background p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className={`size-2 rounded-full ${service.ready ? "bg-emerald-500" : "bg-amber-400"}`} />
                {service.name}
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{service.ready ? service.detail : "等待服务器端配置"}</p>
            </div>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}
