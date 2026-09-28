import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const backup = readFileSync('deploy/backup.sh', 'utf8');
const sourceLine = 'source /srv/study/backup-s3.env';
const start = backup.indexOf(sourceLine);
const end = backup.indexOf(': "${S3_BUCKET:?S3_BUCKET required}"', start);
assert.ok(start >= 0 && end > start, 'backup credential-loading block exists');

// Exercise the real loading block with disposable input, before any backup commands run.
const credentialBlock = backup.slice(start, end);

for (const token of [undefined, 'dummy-session-token']) {
  test(`backup exports AWS credentials to a child process${token ? ' with a session token' : ''}`, () => {
    const fixture = [
      'AWS_ACCESS_KEY_ID=dummy-access-key',
      'AWS_SECRET_ACCESS_KEY=dummy-secret-key',
      ...(token ? [`AWS_SESSION_TOKEN=${token}`] : []),
    ];
    const loadCredentials = credentialBlock.replace(
      sourceLine,
      `source <(printf '%s\n' ${fixture.map(line => JSON.stringify(line)).join(' ')})`,
    );
    const environment = {...process.env};
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'BASH_ENV']) {
      delete environment[name];
    }
    const probe = `set -euo pipefail\nunset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN\n${loadCredentials}\nbash -c 'env | grep ^AWS_'`;
    const result = spawnSync('bash', ['-c', probe], {encoding: 'utf8', env: environment});
    assert.equal(result.status, 0, result.error?.message ?? 'AWS credentials were not available to the child process');
    const childEnvironment = Object.fromEntries(result.stdout.trim().split(/\r?\n/).map(line => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
    assert.equal(childEnvironment.AWS_ACCESS_KEY_ID, 'dummy-access-key');
    assert.equal(childEnvironment.AWS_SECRET_ACCESS_KEY, 'dummy-secret-key');
    assert.equal(childEnvironment.AWS_SESSION_TOKEN, token);
    assert.equal(result.stderr, '');
  });
}
