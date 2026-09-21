import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export type CodexMaintenanceTask = {
  id: string;
  owner: string;
  sourceType: string;
  sourceId: string;
  title: string;
  detail: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

function rootDirectory() {
  if (process.env.CODEX_QUEUE_DIR) return resolve(process.env.CODEX_QUEUE_DIR);
  const databaseUrl = process.env.DATABASE_URL || 'file:./data/course-radar-v2.db';
  if (databaseUrl.startsWith('file:')) return join(dirname(resolve(databaseUrl.slice(5))), 'codex-queue');
  return resolve('./data/codex-queue');
}

function clean(value: unknown, limit: number) {
  return String(value || '').trim().slice(0, limit);
}

export async function enqueueCodexMaintenance(owner: string, input: {
  sourceType: string;
  sourceId?: string;
  title: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}) {
  const title = clean(input.title, 300);
  const sourceType = clean(input.sourceType, 80);
  if (!owner || !sourceType || !title) throw new Error('维护任务内容无效');
  const serializedMetadata = JSON.stringify(input.metadata || {});
  const task: CodexMaintenanceTask = {
    id: crypto.randomUUID(),
    owner,
    sourceType,
    sourceId: clean(input.sourceId, 500),
    title,
    detail: clean(input.detail, 4000),
    metadata: serializedMetadata.length <= 6000 ? JSON.parse(serializedMetadata) : { truncated: true, preview: serializedMetadata.slice(0, 5500) },
    createdAt: new Date().toISOString(),
  };
  const incoming = join(rootDirectory(), 'incoming');
  await mkdir(incoming, { recursive: true });
  const temporary = join(incoming, `.${task.id}.tmp`);
  const destination = join(incoming, `${task.id}.json`);
  await writeFile(temporary, JSON.stringify(task, null, 2), { encoding: 'utf8', mode: 0o640 });
  await rename(temporary, destination);
  return { ok: true, taskId: task.id, queuedFor: 'tonight' as const };
}

export async function codexMaintenanceStatus() {
  const root = rootDirectory();
  const incoming = join(root, 'incoming');
  let pending = 0;
  try { pending = (await readdir(incoming)).filter((name) => name.endsWith('.json')).length; } catch {}
  try {
    const status = JSON.parse(await readFile(join(root, 'status.json'), 'utf8'));
    return { configured: true, ...status, pending };
  } catch {
    return { configured: process.env.CLOUD_MODE === 'true', pending, state: pending ? 'queued' : 'idle' };
  }
}
