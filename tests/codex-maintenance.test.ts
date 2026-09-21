import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const queue = await mkdtemp(join(tmpdir(), 'codex-queue-test-'));
process.env.CODEX_QUEUE_DIR = queue;
const maintenance = await import('../lib/codex-maintenance.ts');

test('a maintenance event is written atomically and appears in live status', async () => {
  const result = await maintenance.enqueueCodexMaintenance('owner', { sourceType: 'manual', title: '检查设置页面', detail: '按钮状态不清楚' });
  const files = (await readdir(join(queue, 'incoming'))).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  const task = JSON.parse(await readFile(join(queue, 'incoming', files[0]), 'utf8'));
  assert.equal(task.id, result.taskId);
  assert.equal(task.title, '检查设置页面');
  assert.deepEqual(await maintenance.codexMaintenanceStatus(), { configured: false, pending: 1, state: 'queued' });
});

test.after(async () => { await rm(queue, { recursive: true, force: true }); });
