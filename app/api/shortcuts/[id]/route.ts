import { requireOwnerApi } from "@/lib/authz";
import { deleteShortcut } from "@/lib/repository";

export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const { id } = await params;
  await deleteShortcut(id);
  return Response.json({ deleted: true });
}
