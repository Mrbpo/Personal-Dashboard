import test from 'node:test';
import assert from 'node:assert/strict';
import { remainingQuota, shouldUseSubscription as useSubscription } from '../lib/ai-routing.ts';
test('subscription threshold uses lower window and includes exactly fifty', () => {
  const remaining = remainingQuota({ rateLimits: { primary: { usedPercent: 20 }, secondary: { usedPercent: 50 } } });
  assert.equal(remaining, 50);
  assert.equal(useSubscription(true, true, remaining), false);
  assert.equal(useSubscription(true, true, 50.01), true);
  assert.equal(useSubscription(true, false, 90), false);
  assert.equal(useSubscription(false, true, 90), false);
  assert.equal(useSubscription(true, true, null), false);
});
test('quota prefers multi-bucket and fails closed on unknown or invalid windows', () => {
  assert.equal(remainingQuota({ rateLimits: { primary: { usedPercent: 0 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 10 } }, other: { primary: { usedPercent: 70 } } } }), 30);
  assert.equal(remainingQuota(null), null);
  assert.equal(remainingQuota({ rateLimits: { primary: { usedPercent: null } } }), null);
  assert.equal(remainingQuota({ rateLimits: { primary: { usedPercent: 100 } } }), 0);
});
