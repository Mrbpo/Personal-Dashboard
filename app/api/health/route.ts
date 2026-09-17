import { requireOwnerApi } from '@/lib/authz';
import { healthStatus } from '@/lib/health';
export async function GET() {
  const denied = await requireOwnerApi(); if (denied) return denied;
  return Response.json(await healthStatus(), { headers: { 'Cache-Control': 'no-store' } });
}
