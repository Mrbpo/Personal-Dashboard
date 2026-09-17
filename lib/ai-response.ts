import { serviceValue } from './service-vault.ts';
import { codexBridge } from './codex-bridge.ts';
import { paidOpenAI } from './ai-budget.ts';
export function hasAI() { return Boolean(serviceValue('OPENAI_API_KEY') || serviceValue('CHATGPT_AUTO') === 'true'); }
// A fetch-compatible boundary keeps existing structured output/error handling intact.
export async function aiResponse(_url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body));
  const fileInput = Array.isArray(body.input) && body.input.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === 'input_file' || c.type === 'input_image'));
  let reason = fileInput ? '文件附件使用 API' : '自动切换未开启';
  if (!fileInput && !body.tools?.length && process.env.CLOUD_MODE !== 'true' && serviceValue('CHATGPT_AUTO') === 'true') {
    const output = await codexBridge.serial(async () => {
      const status = await codexBridge.status();
      if (status.provider !== 'chatgpt') {
        reason = status.remaining === null ? '未登录或额度未知' : '剩余额度不高于 50%';
        return null;
      }
      try { return await codexBridge.generate(body); }
      catch { reason = 'ChatGPT 请求失败，改用 API'; return null; }
    });
    if (output) {
      codexBridge.lastRoute = { provider: 'chatgpt', reason: '剩余额度高于 50%', at: new Date().toISOString() };
      return Response.json(output);
    }
  }
  const key = serviceValue('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_NOT_CONFIGURED');
  codexBridge.lastRoute = { provider: 'api', reason, at: new Date().toISOString() };
  return paidOpenAI('responses',body,init.signal);
}
