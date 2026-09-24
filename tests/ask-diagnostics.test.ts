import assert from 'node:assert/strict';
import test from 'node:test';
import { askFailureKind, askFailureMessage } from '../lib/ask-diagnostics.ts';

test('ask diagnostics expose fixed labels rather than private error text', () => {
  assert.equal(askFailureKind(Object.assign(new Error('private SQL query'), { code: 'SQLITE_BUSY' })), 'DATABASE_BUSY');
  assert.equal(askFailureKind(Object.assign(new Error('private SQL query'), { code: 'SQLITE_CORRUPT' })), 'DATABASE_ERROR');
  assert.equal(askFailureKind(new Error('private course question')), 'UNCLASSIFIED');
  assert.equal(askFailureKind(new Error('OPENAI_REQUEST_FAILED_502')), 'OPENAI_REQUEST_FAILED_502');
  assert.equal(askFailureKind(new TypeError('fetch failed')), 'UPSTREAM_FETCH_FAILED');
});

test('ask errors describe the failed stage without changing search results', () => {
  assert.match(askFailureMessage('answer', 'UNCLASSIFIED'), /AI 回答/);
  assert.match(askFailureMessage('search', 'DATABASE_BUSY'), /全站检索/);
  assert.match(askFailureMessage('answer', 'AI_BUDGET_EXCEEDED'), /预算/);
});
