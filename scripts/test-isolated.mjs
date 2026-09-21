import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const directory = mkdtempSync(join(tmpdir(), 'study-tests-'));
try {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', 'tests/*.test.ts'], { stdio: 'inherit', env: { ...process.env, SERVICE_VAULT_DIR: directory, LIBRARY_DIR: directory + '/library', CODEX_QUEUE_DIR: directory + '/codex-queue', AI_BUDGET_TEST_BYPASS: 'true', CHATGPT_AUTO: 'false' } });
  process.exitCode = result.status ?? 1;
} finally {
  // Only this test-created temporary directory is removed.
  rmSync(directory, { recursive: true, force: true });
}
