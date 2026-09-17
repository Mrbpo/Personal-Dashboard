import { randomBytes, createHash } from 'node:crypto';
import { cookies } from 'next/headers';
import { requireOwnerApi } from '@/lib/authz';
import { healthConfig, healthScopes } from '@/lib/health';
import { seal, sameOrigin } from '@/lib/service-vault';
export async function POST(request: Request) {
  const denied = await requireOwnerApi(); if (denied) return denied;
  if (!sameOrigin(request)) return Response.json({ error: '请从健康页连接' }, { status: 403 });
  try {
    const config = healthConfig(); if (!config.configured) throw new Error();
    if (new URL(config.redirectUri).origin !== new URL(request.url).origin) return Response.json({ error: '回调地址需与当前网站地址一致，请在设置中调整' }, { status: 400 });
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    (await cookies()).set('health_oauth', seal({ state, verifier, expires: Date.now() + 600000 }), { httpOnly: true, secure: new URL(config.redirectUri).protocol === 'https:', sameSite: 'lax', path: '/api/health', maxAge: 600 });
    const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code', scope: healthScopes.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return Response.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + query });
  } catch { return Response.json({ error: '请先在设置页配置 Google Health Client ID 和 Client Secret' }, { status: 400 }); }
}
