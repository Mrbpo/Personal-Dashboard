import { cookies } from 'next/headers';
import { timingSafeEqual } from 'node:crypto';
import { requireOwnerApi } from '@/lib/authz';
import { connectHealth } from '@/lib/health';
import { unseal } from '@/lib/service-vault';
export async function GET(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  const jar = await cookies(); const saved = jar.get('health_oauth')?.value;
  jar.set('health_oauth', '', { httpOnly: true, sameSite: 'lax', path: '/api/health', maxAge: 0 });
  const url = new URL(request.url);
  const destination = new URL('/health', url.origin);
  try {
    if (!saved || url.searchParams.has('error')) throw new Error();
    const pending = unseal<{ state: string; verifier: string; expires: number }>(saved);
    const actual = Buffer.from(url.searchParams.get('state') || ''); const expected = Buffer.from(pending.state);
    if (Date.now() > pending.expires || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const code = url.searchParams.get('code'); if (!code) throw new Error();
    await connectHealth(code, pending.verifier);
    destination.searchParams.set('connection', 'success');
  } catch { destination.searchParams.set('connection', 'failed'); }
  return Response.redirect(destination, 303);
}
