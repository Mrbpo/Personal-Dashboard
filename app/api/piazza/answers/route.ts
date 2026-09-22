import { requireOwnerApi } from "@/lib/authz";
import { searchConfirmedPiazzaAnswers } from "@/lib/piazza-digest";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  return Response.json(await searchConfirmedPiazzaAnswers(
    params.get("q") || "", params.get("courseId") || "", Number(params.get("offset") || 0), 30,
  ));
}
