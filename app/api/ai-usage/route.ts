import { requireOwnerApi } from "@/lib/authz";
import { getAiUsage } from "@/lib/ai-usage";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  return Response.json(await getAiUsage());
}
