import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('daily backup lease reset is idempotent and preserves job progress and other leases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'study-daily-backup-'));
  const env = { ...process.env, DATABASE_URL: `file:${join(directory, 'study.db')}` };
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    run(['--input-type=module', '-e', `
      import { createClient } from '@libsql/client';
      const db = createClient({ url: process.env.DATABASE_URL });
      await db.execute('CREATE TABLE service_leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)');
      await db.execute('CREATE TABLE background_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, available_at INTEGER NOT NULL, lease_until INTEGER, lease_token TEXT, error TEXT, updated_at INTEGER NOT NULL)');
      await db.execute("INSERT INTO service_leases(id,token,expires_at) VALUES('worker-primary','old-worker',9999999999999)");
      await db.execute("INSERT INTO service_leases(id,token,expires_at) VALUES('other-service','other-token',9999999999999)");
      await db.execute("INSERT INTO background_jobs(id,kind,payload,status,attempts,available_at,lease_until,lease_token,error,updated_at) VALUES('job-1','night','{}','running',2,1,9999999999999,'job-token',NULL,7)");
      db.close();
    `]);

    run(['--experimental-strip-types', 'scripts/clear-worker-primary-lease.ts']);
    run(['--experimental-strip-types', 'scripts/clear-worker-primary-lease.ts']);

    const actual = JSON.parse(run(['--input-type=module', '-e', `
      import { createClient } from '@libsql/client';
      const db = createClient({ url: process.env.DATABASE_URL });
      const leases = await db.execute("SELECT id,token,expires_at FROM service_leases WHERE id IN ('other-service','worker-primary') ORDER BY id");
      const jobs = await db.execute("SELECT status,attempts,lease_until,lease_token,updated_at FROM background_jobs WHERE id='job-1'");
      console.log(JSON.stringify({ leases: leases.rows, jobs: jobs.rows }));
      db.close();
    `]));
    assert.deepEqual(actual.leases, [{ id: 'other-service', token: 'other-token', expires_at: 9999999999999 }]);
    assert.deepEqual(actual.jobs, [{ status: 'running', attempts: 2, lease_until: 9999999999999, lease_token: 'job-token', updated_at: 7 }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('daily backup clears the lease only after stop confirmation and recovers services on failure', { skip: process.platform === 'win32' }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'study-daily-backup-flow-'));
  try {
    const events = join(directory, 'events');
    const daily = join(directory, 'daily-backup.sh');
    writeFileSync(daily, readFileSync('deploy/daily-backup.sh', 'utf8').replaceAll('/srv/study', directory));
    writeFileSync(join(directory, 'current-version'), 'a'.repeat(40));
    const docker = join(directory, 'docker');
    writeFileSync(docker, `#!/usr/bin/env bash
case "$4" in
  stop) echo stop >> "$MOCK_EVENTS" ;;
  ps) echo ps >> "$MOCK_EVENTS"; printf '%s\\n' "\${MOCK_RUNNING:-}" ;;
  run) echo clear >> "$MOCK_EVENTS" ;;
  up) echo up >> "$MOCK_EVENTS" ;;
esac
`);
    chmodSync(docker, 0o755);
    writeFileSync(join(directory, 'backup.sh'), `echo backup >> "$MOCK_EVENTS"
[[ "\${MOCK_BACKUP_FAIL:-0}" != 1 ]]
`);
    writeFileSync(join(directory, 'verify-backup.sh'), 'echo verify >> "$MOCK_EVENTS"\n');
    const run = (extra: Record<string, string>) => {
      writeFileSync(events, '');
      const result = spawnSync('bash', [daily], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, MOCK_EVENTS: events, ...extra },
      });
      return { result, events: readFileSync(events, 'utf8').trim().split('\n') };
    };
    const success = run({});
    assert.equal(success.result.status, 0, success.result.stderr);
    assert.deepEqual(success.events, ['stop', 'ps', 'clear', 'backup', 'up', 'verify']);

    const failedBackup = run({ MOCK_BACKUP_FAIL: '1' });
    assert.notEqual(failedBackup.result.status, 0);
    assert.deepEqual(failedBackup.events, ['stop', 'ps', 'clear', 'backup', 'clear', 'up']);

    const runningWorker = run({ MOCK_RUNNING: 'worker' });
    assert.notEqual(runningWorker.result.status, 0);
    assert.deepEqual(runningWorker.events, ['stop', 'ps', 'up']);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
