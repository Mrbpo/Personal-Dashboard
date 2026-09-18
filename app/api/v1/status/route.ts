import { serviceValue } from "@/lib/service-vault";
import { requireOwnerApi } from "@/lib/authz";
import { dashboardData, getSettings } from "@/lib/repository";
import { getCurrentOwner } from "@/lib/authz";
import { hasOpenAI } from "@/lib/openai-analysis";

export async function GET() {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const owner = await getCurrentOwner();
  const settings = await getSettings(owner!.userId);
  const today = new Date().toLocaleDateString("en-CA", { timeZone: settings.timezone });
  const data = await dashboardData(today);
  return Response.json({
    ok: true,
    database: process.env.DATABASE_URL?.startsWith("libsql:") || process.env.DATABASE_URL?.startsWith("https:") ? "remote" : "local",
    canvasConfigured: Boolean(serviceValue("CANVAS_TOKEN")),
    aiConfigured: hasOpenAI(),
    courseCount: data.courses.length,
    taskCount: data.tasks.length,
    lastSync: data.lastSync,
    capabilities: {
      courseSearch: "/api/v1/library/search?q=...&courseId=...",
      study: "/api/v1/study",
      authentication: "Authorization: Bearer <MOBILE_API_TOKEN>",
    },
  });
}
