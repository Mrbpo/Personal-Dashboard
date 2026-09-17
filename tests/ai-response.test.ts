import test from 'node:test';
import assert from 'node:assert/strict';
import { aiResponse } from '../lib/ai-response.ts';
import { codexBridge } from '../lib/codex-bridge.ts';
test('text uses subscription; threshold, errors and files fall back to API', async () => {
  const oldFetch = globalThis.fetch;
  const oldStatus = codexBridge.status;
  const oldGenerate = codexBridge.generate;
  const oldAuto = process.env.CHATGPT_AUTO;
  const oldKey = process.env.OPENAI_API_KEY;
  process.env.CHATGPT_AUTO = 'true'; process.env.OPENAI_API_KEY = 'test-key';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ output_text: 'api' }); };
  const status = { available: true, enabled: true, connected: true, remaining: 80, threshold: 50, provider: 'chatgpt', apiConfigured: true, lastRoute: null };
  codexBridge.status = async () => status;
  codexBridge.generate = async () => ({ status: 'completed', output_text: 'subscription', model: 'test', provider: 'chatgpt' });
  const request = { method: 'POST', body: JSON.stringify({ input: 'hello' }) };
  try {
    assert.equal((await (await aiResponse('', request)).json()).output_text, 'subscription');
    assert.equal(calls, 0);
    status.provider = 'api'; status.remaining = 50;
    assert.equal((await (await aiResponse('', request)).json()).output_text, 'api');
    status.provider = 'chatgpt'; status.remaining = 80;
    codexBridge.generate = async () => { throw new Error('simulated'); };
    assert.equal((await (await aiResponse('', request)).json()).output_text, 'api');
    assert.equal((await (await aiResponse('', { method: 'POST', body: JSON.stringify({ input: [{ content: [{ type: 'input_file', file_id: 'file-test' }] }] }) })).json()).output_text, 'api');
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = oldFetch; codexBridge.status = oldStatus; codexBridge.generate = oldGenerate;
    if (oldAuto == null) delete process.env.CHATGPT_AUTO; else process.env.CHATGPT_AUTO = oldAuto;
    if (oldKey == null) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  }
});
