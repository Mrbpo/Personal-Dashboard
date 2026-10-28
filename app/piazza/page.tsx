import { PageFrame } from "@/components/page-frame";
import { PiazzaCenter } from "@/components/piazza-center";
import { requireOwnerPage } from "@/lib/authz";
import { getPiazzaStatus } from "@/lib/piazza-sync";

export const dynamic = "force-dynamic";

export default async function Page() {
  const { authorized } = await requireOwnerPage("/piazza");
  return <PageFrame eyebrow="PIAZZA ARCHIVE" title="Piazza 消息、AI 每周总结与问答">
    {authorized ? <PiazzaCenter initialStatus={await getPiazzaStatus()} /> : <a href="/login">请先登录</a>}
  </PageFrame>;
}
