import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { daysEnding, normalizeHealth } from '../lib/health-data.ts';
import { seal, unseal, saveServiceValues, serviceStatus, serviceValue, sameOrigin } from '../lib/service-vault.ts';
import { saveOwnerPassword, verifyCustomOwnerPassword } from '../lib/owner-password.ts';

test('health maps civil dates, retains missing values and does not duplicate sleep', () => {
  const days = daysEnding('2026-09-14');
  const sleep = { name: 'one', sleep: { interval: { endTime: '2026-09-14T01:00:00Z' }, summary: { minutesAsleep: '420' } } };
  const result = normalizeHealth(days, {
    steps: { rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 9, day: 14 } }, steps: { countSum: '0' } }] },
    sleep: { dataPoints: [sleep, sleep] },
    heart: { dataPoints: [{ dailyRestingHeartRate: { date: { year: 2026, month: 9, day: 14 }, beatsPerMinute: '62' } }] },
  }, 'America/Toronto');
  assert.equal(result.at(-1)?.steps, 0);
  assert.equal(result.at(-1)?.restingHeartRate, 62);
  assert.equal(result.at(-1)?.sleepMinutes, null);
  assert.equal(result.at(-2)?.sleepMinutes, 420);
  assert.equal(result[0].steps, null);
  assert.equal(days.at(-1)?.steps, null);
});

test('service vault encrypts secrets, redacts status, persists and can disable environment fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-vault-test-'));
  const previous = process.env.SERVICE_VAULT_DIR;
  const previousKey = process.env.OPENAI_API_KEY;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSiteDomain = process.env.SITE_DOMAIN;
  process.env.SERVICE_VAULT_DIR = dir;
  process.env.OPENAI_API_KEY = 'environment-test-value';
  try {
    saveServiceValues({ OPENAI_API_KEY: 'unit-test-secret', OPENAI_MODEL: 'test-model' });
    assert.equal(serviceValue('OPENAI_API_KEY'), 'unit-test-secret');
    assert.ok(!readFileSync(join(dir, 'services.enc'), 'utf8').includes('unit-test-secret'));
    assert.ok(!JSON.stringify(serviceStatus()).includes('unit-test-secret'));
    assert.equal(serviceStatus().find(f => f.key === 'OPENAI_MODEL')?.value, 'test-model');
    const encrypted = seal({ value: 'private' });
    assert.deepEqual(unseal(encrypted), { value: 'private' });
    const parts = encrypted.split('.'); parts[1] = Buffer.alloc(16).toString('base64url');
    assert.throws(() => unseal(parts.join('.')));
    saveServiceValues({ OPENAI_API_KEY: '' });
    assert.equal(serviceValue('OPENAI_API_KEY'), '');
    assert.throws(() => saveServiceValues({ SESSION_SECRET: 'forbidden' }));
    assert.throws(() => saveOwnerPassword('short'));
    saveOwnerPassword('correct horse battery staple');
    assert.equal(verifyCustomOwnerPassword('correct horse battery staple'), true);
    assert.equal(verifyCustomOwnerPassword('wrong password value'), false);
    assert.ok(!readFileSync(join(dir, 'services.enc'), 'utf8').includes('correct horse battery staple'));
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production'; process.env.SITE_DOMAIN = 'baipiao.fun';
    saveServiceValues({ GOOGLE_HEALTH_REDIRECT_URI: 'http://localhost:3000/api/health/callback' });
    assert.equal(serviceValue('GOOGLE_HEALTH_REDIRECT_URI'), 'https://baipiao.fun/api/health/callback');
    assert.equal(sameOrigin(new Request('http://localhost:3000/api/services', { headers: { origin: 'https://elsewhere.test' } })), false);
  } finally {
    if (previous === undefined) delete process.env.SERVICE_VAULT_DIR; else process.env.SERVICE_VAULT_DIR = previous;
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previousKey;
    if (previousNodeEnv === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV; else (process.env as Record<string, string | undefined>).NODE_ENV = previousNodeEnv;
    if (previousSiteDomain === undefined) delete process.env.SITE_DOMAIN; else process.env.SITE_DOMAIN = previousSiteDomain;
    rmSync(dir, { recursive: true });
  }
});
