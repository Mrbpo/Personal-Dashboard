import { PageFrame } from "@/components/page-frame";
import { PiazzaCenter } from "@/components/piazza-center";
import { requireOwnerPage } from "@/lib/authz";
import { getPiazzaStatus } from "@/lib/piazza-sync";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { authorized } = await requireOwnerPage("/piazza");
  return <PageFrame eyebrow="PIAZZA ARCHIVE" title="Piazza 每日摘要与问答" description="逐日查看所有已同步的课程消息，搜索有教师明确回答的问答，并打开原帖核对。">
    {authorized ? <PiazzaCenter initialStatus={await getPiazzaStatus()} /> : <a href="/login">请先登录</a>}
  </PageFrame>;
}
