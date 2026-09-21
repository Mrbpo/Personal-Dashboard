import { apiError, apiOwner } from '@/lib/api-guard';
import { codexMaintenanceStatus, enqueueCodexMaintenance } from '@/lib/codex-maintenance';

export async function GET(request: Request) {
  try {
    await apiOwner(request);
    return Response.json(await codexMaintenanceStatus(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return apiError(error); }
}

export async function POST(request: Request) {
  try {
    const owner = await apiOwner(request);
    const body = await request.json();
    return Response.json(await enqueueCodexMaintenance(owner, {
      sourceType: 'manual',
      sourceId: crypto.randomUUID(),
      title: String(body.title || '网站维护任务'),
      detail: String(body.detail || ''),
      metadata: { requestedFrom: 'settings' },
    }));
  } catch (error) { return apiError(error); }
}
