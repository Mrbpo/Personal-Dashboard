import test from 'node:test';
import assert from 'node:assert/strict';
import { addCalendarDays, calendarDay, dueWindow, formatTaskDeadline, taskDeadline } from '../lib/due-window.ts';
import type { LearningTask } from '../lib/domain.ts';

function task(id: string, fields: Partial<LearningTask> = {}) {
  return { id, dueAt: null, dueDate: null, duePrecision: null, localStatus: 'active' as const, canvasStatus: 'upcoming' as const, ...fields };
}
const zone = 'America/Toronto';

test('16 local calendar days include the last day and exclude the end, across spring DST', () => {
  const now = Date.parse('2026-03-01T17:00:00Z');
  assert.equal(calendarDay(now, zone), '2026-03-01');
  assert.equal(addCalendarDays('2026-03-01', 16), '2026-03-17');
  const rows = dueWindow([
    task('date-last', { duePrecision: 'date', dueDate: '2026-03-16' }),
    task('date-end', { duePrecision: 'date', dueDate: '2026-03-17' }),
    task('exact-last', { dueAt: '2026-03-17T03:59:59Z' }),
    task('exact-end', { dueAt: '2026-03-17T04:00:00Z' }),
    task('old-overdue', { duePrecision: 'date', dueDate: '2025-10-01' }),
  ], zone, now);
  assert.deepEqual(rows.map(row => row.id), ['old-overdue', 'date-last', 'exact-last']);
});

test('fall DST window ends at local midnight, not 16 times 24 hours', () => {
  const now = Date.parse('2026-10-25T16:00:00Z');
  assert.deepEqual(dueWindow([
    task('last', { dueAt: '2026-11-10T04:59:59Z' }),
    task('end', { dueAt: '2026-11-10T05:00:00Z' }),
  ], zone, now).map(row => row.id), ['last']);
});

test('date-only today stays all-day; exact elapsed deadlines today are overdue', () => {
  const now = Date.parse('2026-10-13T18:00:00Z');
  const allDay = task('day', { duePrecision: 'date', dueDate: '2026-10-13', dueAt: '2026-10-13T00:00:00Z' });
  assert.equal(taskDeadline(allDay, zone, now)?.overdue, false);
  assert.equal(taskDeadline(task('exact', { dueAt: '2026-10-13T17:00:00Z' }), zone, now)?.overdue, true);
  assert.match(formatTaskDeadline(allDay, 'Pacific/Honolulu'), /13.*全天/);
  assert.doesNotMatch(formatTaskDeadline(allDay, zone), /23:59|00:00/);
});

test('keep future restricted and missing-source tasks; exclude completed, ignored and explicit cancellation', () => {
  const now = Date.parse('2026-10-13T18:00:00Z');
  const due = { duePrecision: 'date' as const, dueDate: '2026-10-15' };
  const rows = dueWindow([
    task('locked', { ...due, canvasStatus: 'locked', prerequisiteBlocked: true }),
    task('not-open', { ...due, canvasStatus: 'not_open' }),
    task('uncertain-source', { ...due, canvasStatus: 'possibly_superseded' }),
    task('local-done', { ...due, localStatus: 'completed' }),
    task('canvas-done', { ...due, canvasStatus: 'completed' }),
    task('ignored', { ...due, localStatus: 'ignored' }),
    task('cancelled', { ...due, cancelledAt: '2026-10-13T12:00:00Z' }),
    task('unknown'),
    task('invalid-date', { duePrecision: 'date', dueDate: '2026-02-30' }),
    task('ambiguous-time', { dueAt: '2026-10-15T12:00:00' }),
  ], zone, now);
  assert.deepEqual(rows.map(row => row.id), ['locked', 'not-open', 'uncertain-source']);
});

test('exact timestamps use the configured user calendar rather than UTC or browser timezone', () => {
  const now = Date.parse('2026-10-13T01:00:00Z');
  assert.equal(calendarDay(now, 'Asia/Tokyo'), '2026-10-13');
  assert.equal(calendarDay(now, 'America/Los_Angeles'), '2026-10-12');
  const lastTokyoDay = task('exact', { dueAt: '2026-10-28T14:59:59Z' });
  assert.equal(dueWindow([lastTokyoDay], 'Asia/Tokyo', now).length, 1);
  assert.equal(dueWindow([task('end', { dueAt: '2026-10-28T15:00:00Z' })], 'Asia/Tokyo', now).length, 0);
});
