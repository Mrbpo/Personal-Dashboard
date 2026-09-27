import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deadlineLabel, reviewValue, safeSourceUrl } from '../app/kernel/format.ts';

test('kernel deadline label preserves date-only precision', () => {
  assert.equal(deadlineLabel({ due_date: '2026-10-15', due_at: '2026-10-15',
    due_local_time: null, due_timezone: null, due_precision: 'date', due_original: '2026-10-15' }),
  '2026-10-15（仅日期）');
  assert.equal(deadlineLabel({ due_date: '2026-10-15', due_at: '2026-10-16T03:59:00.000Z',
    due_local_time: '23:59:00', due_timezone: 'America/Toronto', due_precision: 'minute',
    due_original: '2026-10-15T23:59-04:00' }), '2026-10-15 23:59 America/Toronto');
});

test('pending deadline review retains date-only and local-time precision', () => {
  assert.equal(reviewValue('due', { date: '2026-10-16', at: null, precision: 'date', original: '2026-10-16' }),
    '2026-10-16（仅日期）');
  assert.equal(reviewValue('due', { date: '2026-10-16', at: '2026-10-17T03:30:00Z',
    localTime: '23:30:00', timezone: 'America/Toronto', precision: 'minute' }),
  '2026-10-16 23:30 America/Toronto');
});

test('kernel provenance links accept only web URLs', () => {
  assert.equal(safeSourceUrl('https://example.edu/task'), 'https://example.edu/task');
  assert.equal(safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeSourceUrl('not a url'), null);
});
