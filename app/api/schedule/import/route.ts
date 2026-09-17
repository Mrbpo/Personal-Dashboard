import { requireOwnerApi } from "@/lib/authz";
import { saveScheduleEvents } from "@/lib/repository";
import { parseScheduleFile } from "@/lib/schedule-import";

export async function POST(request: Request) {
  const denied = await requireOwnerApi();
  if (denied) return denied;
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return Response.json({ error: "请选择日程文件" }, { status: 400 });
  if (file.size > 5 * 1024 * 1024) return Response.json({ error: "日程文件不能超过 5 MB" }, { status: 413 });
  try {
    const events = parseScheduleFile(file.name, await file.text());
    await saveScheduleEvents(file.name, events);
    return Response.json({ imported: events.length, sourceName: file.name });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "日程导入失败" }, { status: 400 });
  }
}
