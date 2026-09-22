import { PageFrame } from "@/components/page-frame";
import { PiazzaCenter } from "@/components/piazza-center";
import { requireOwnerPage } from "@/lib/authz";
import { getPiazzaStatus } from "@/lib/piazza-sync";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { authorized } = await requireOwnerPage("/piazza");
  return <PageFrame eyebrow="PIAZZA ARCHIVE" title="Piazza 消息、AI 每周总结与问答" description="逐日查看已同步消息，按周生成覆盖全部归档的 AI 总结，并依据 Piazza 原帖提问和核对答案。">
    {authorized ? <PiazzaCenter initialStatus={await getPiazzaStatus()} /> : <a href="/login">请先登录</a>}
  </PageFrame>;
}
