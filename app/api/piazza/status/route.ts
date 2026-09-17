import { requireOwnerApi } from "@/lib/authz";
import { getPiazzaStatus } from "@/lib/piazza-sync";

export const runtime = "nodejs";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  return Response.json(await getPiazzaStatus());
}
