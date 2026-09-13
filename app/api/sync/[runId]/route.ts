import { requireOwnerApi } from "@/lib/authz";
import { getSyncRun } from "@/lib/repository";

export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { runId } = await params;
  const run = await getSyncRun(runId);
  return run ? Response.json(run) : Response.json({ error: "同步记录不存在" }, { status: 404 });
}
