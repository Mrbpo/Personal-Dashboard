import { getCurrentOwner } from './authz';
import { sameOrigin } from './service-vault';
export async function apiOwner(request: Request) {
  const owner = await getCurrentOwner();
  if (!owner) throw new Error('UNAUTHORIZED');
  if (!['GET','HEAD'].includes(request.method) && !sameOrigin(request)) throw new Error('FORBIDDEN');
  return owner.userId;
}
export function apiError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'UNAUTHORIZED' || message === 'FORBIDDEN') return Response.json({error:'需要登录或同源请求'}, {status:message === 'UNAUTHORIZED' ? 401 : 403});
  // Never reflect provider errors, database queries or secrets to clients.
  return Response.json({error: /^[\u3400-\u9fff]/.test(message) ? message.slice(0,220) : '操作未完成，请检查连接配置或稍后重试'}, {status:400});
}
export async function boundedForm(request: Request, max = 13 * 1024 * 1024) {
  const reader = request.body?.getReader(); if (!reader) throw new Error('请求为空');
  const chunks: Uint8Array[] = []; let total = 0;
  while (true) { const {done,value} = await reader.read(); if(done) break; total += value.length; if(total > max) {await reader.cancel();throw new Error('上传总量超过限制');} chunks.push(value); }
  return new Response(Buffer.concat(chunks), {headers:{'Content-Type':request.headers.get('content-type') || ''}}).formData();
}
