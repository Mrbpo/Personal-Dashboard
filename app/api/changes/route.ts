import { requireOwnerApi } from "@/lib/authz";
import { listChanges } from "@/lib/repository";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  return Response.json({ changes: await listChanges() });
}
