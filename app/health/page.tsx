import { PageFrame } from '@/components/page-frame';
import { HealthDashboard } from '@/components/health-dashboard';
import { requireOwnerPage } from '@/lib/authz';
export const dynamic = 'force-dynamic';
export default async function HealthPage() {
  const { authorized } = await requireOwnerPage('/health');
  if (!authorized) return <PageFrame eyebrow="PRIVATE" title="需要登录">请先登录个人网站。</PageFrame>;
  return <PageFrame ornament eyebrow="HEALTH JOURNAL" title="健康数据与 AI 分析" description="连接 Fitbit，查看睡眠、活动和静息心率的近期记录。"><HealthDashboard /></PageFrame>;
}
