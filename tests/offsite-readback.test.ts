import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const name = 'study-v1-20260927T010203Z.tar.age';
const key = `study-backups/${name}`;

for (const scenario of ['success', 'archive mismatch', 'sidecar mismatch', 'download failure'] as const) {
  test(`offsite readback: ${scenario}`, {skip: process.platform === 'win32' ? 'requires POSIX paths' : false}, () => {
    const directory = mkdtempSync(join(tmpdir(), 'study-readback-test-'));
    try {
      const archive = join(directory, name);
      const remote = join(directory, 'remote');
      const bin = join(directory, 'bin');
      mkdirSync(remote);
      mkdirSync(bin);
      const bytes = Buffer.from('encrypted-archive-test');
      writeFileSync(archive, bytes);
      const digest = createHash('sha256').update(bytes).digest('hex');
      writeFileSync(`${archive}.sha256`, `${digest}  ${archive}\n`);
      copyFileSync(archive, join(remote, name));
      copyFileSync(`${archive}.sha256`, join(remote, `${name}.sha256`));
      if (scenario === 'archive mismatch') writeFileSync(join(remote, name), 'encrypted-archive-tesu');
      if (scenario === 'sidecar mismatch') writeFileSync(join(remote, `${name}.sha256`), `${'0'.repeat(64)}  ${archive}\n`);
      if (scenario === 'download failure') rmSync(join(remote, name));

      const config = join(directory, 'backup-s3.env');
      writeFileSync(config, 'S3_BUCKET=test-bucket\nS3_ENDPOINT=https://r2.invalid\nAWS_ACCESS_KEY_ID=dummy-access-key\nAWS_SECRET_ACCESS_KEY=dummy-secret-key\n');
      const aws = join(bin, 'aws');
      writeFileSync(aws, `#!/usr/bin/env bash
set -euo pipefail
[[ "\${AWS_ACCESS_KEY_ID:-}" == dummy-access-key && "\${AWS_SECRET_ACCESS_KEY:-}" == dummy-secret-key ]]
[[ "$#" == 7 && "$1" == --endpoint-url && "$2" == https://r2.invalid && "$3" == s3 && "$4" == cp && "$5" == --only-show-errors ]]
[[ "$6" == s3://test-bucket/study-backups/* ]]
cp -- "$MOCK_R2_DIR/\${6##*/}" "$7"
`);
      chmodSync(aws, 0o700);
      const result = spawnSync('bash', ['deploy/verify-offsite-backup.sh', archive, key, config], {
        encoding: 'utf8',
        env: {...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, MOCK_R2_DIR: remote},
      });
      assert.equal(result.status === 0, scenario === 'success', 'readback result did not match the scenario');
      assert.equal(result.stdout, '');
      assert.equal(readdirSync(directory).filter(entry => entry.startsWith('readback.')).length, 0, 'download was not cleaned up');
    } finally {
      rmSync(directory, {recursive: true, force: true});
    }
  });
}
