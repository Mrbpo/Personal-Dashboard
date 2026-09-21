import { serviceValue } from "@/lib/service-vault";
import { PageFrame } from "@/components/page-frame";
import { SettingsForm } from "@/components/settings-form";
import { CourseSettings } from "@/components/course-settings";
import { PiazzaSettings } from "@/components/piazza-settings";
import { ServiceSettings } from "@/components/service-settings";
import { DeploymentSettings } from '@/components/deployment-settings';
import { AccessPasswordSettings } from '@/components/access-password-settings';
import { requireOwnerPage } from "@/lib/authz";
import { hasCustomOwnerPassword } from '@/lib/owner-password';
import { getSettings, listCourseSettings } from "@/lib/repository";
import { getPiazzaStatus } from "@/lib/piazza-sync";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { user, authorized } = await requireOwnerPage("/settings");
  if (!authorized) return <PageFrame eyebrow="PRIVATE" title="无法访问">请使用网站所有者账号登录。</PageFrame>;
  const settings = await getSettings(user.userId).catch(() => ({ timezone: "America/Toronto", dailyMinutes: 150 }));
  const courses = await listCourseSettings().catch(() => []);
  const piazza = await getPiazzaStatus().catch(() => ({ connected: false, status: "disconnected", classes: [], lastSyncedAt: null, postCount: 0, error: null }));
  const services = [
    { name: "Quercus", ready: Boolean(serviceValue("CANVAS_TOKEN")), detail: process.env.CANVAS_BASE_URL || "https://q.utoronto.ca" },
    { name: "AI 分析", ready: Boolean(serviceValue("OPENAI_API_KEY")), detail: serviceValue("OPENAI_MODEL") || "gpt-5-mini" },
    { name: "DeepSeek", ready: Boolean(serviceValue("DEEPSEEK_API_KEY")), detail: "余额与服务状态" },
    { name: "xAI", ready: Boolean(serviceValue("XAI_API_KEY") || serviceValue("XAI_MANAGEMENT_KEY")), detail: serviceValue("XAI_MANAGEMENT_KEY") ? "Management 用量已启用" : "推理 API" },
    { name: "私人访问", ready: hasCustomOwnerPassword() || Boolean(process.env.OWNER_ACCESS_KEY) || process.env.NODE_ENV !== "production", detail: hasCustomOwnerPassword() ? "自定义密码与恢复密钥已启用" : process.env.NODE_ENV === "production" ? "生成的访问密钥已启用" : "本地开发模式" },
  ];
  return (
    <PageFrame eyebrow="PREFERENCES" title="个人与学习设置" description="设置显示姓名、时区和每日学习时间。">
      <SettingsForm initial={settings} />
      <AccessPasswordSettings configured={hasCustomOwnerPassword()} />
      <ServiceSettings />
      <DeploymentSettings />
      <section className="mt-6 rounded-3xl border bg-card p-6 shadow-sm">
        <h2 className="font-semibold">纳入计划的课程</h2>
        <div className="mt-4"><CourseSettings initial={courses} /></div>
      </section>
      <PiazzaSettings initial={piazza} />
      <section className="mt-6 rounded-3xl border bg-card p-6 shadow-sm">
        <h2 className="font-semibold">连接状态</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
