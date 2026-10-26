import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = ':memory:';
const { kernel } = await import('../lib/kernel/service.ts');
const repository = await import('../lib/repository.ts');

test('dashboard reads canonical deadline tasks without reading or rewriting retired plan history', async () => {
  const db = repository.getDatabase();
  const day = '2026-10-13';
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_plans'").first(),null);
  // Simulate an upgraded database; the retired table is no longer provisioned.
  await db.prepare('CREATE TABLE daily_plans(date TEXT PRIMARY KEY,plan_json TEXT,source_version TEXT,ai_available INTEGER,generated_at TEXT)').run();
  // Invalid legacy JSON would break the dashboard if a plan read still existed.
  await db.prepare('INSERT INTO daily_plans(date,plan_json,source_version,ai_available,generated_at) VALUES(?,?,?,?,?)')
    .bind(day, 'retired invalid JSON', 'historical-version', 1, 'historical-time').run();
  const previousTasks = kernel.taskRows;
  const previousCourses = kernel.listCourses;
  const base = { course_id: 'test-course', course_code: 'TEST100', course_name: 'Test course', source_type: 'assignment',
    source_item_id: 'source', source_id: 'assignment', source_url: null, title: 'Same title', action: 'Submit work',
    requirements_json: '[]', due_at: null, due_precision: 'date', due_timezone: 'America/Toronto',
    canvas_status: 'locked', local_status: 'active', prerequisite_blocked: 1, start_at: null, due_date: null,
    evidence: 'Original confirmed requirement', points_possible: null, updated_at: '2026-10-12T12:00:00Z' };
  kernel.taskRows = async () => [
    { ...base, id: 'first-date', due_date: day },
    { ...base, id: 'second-date', due_date: '2026-10-15' },
    { ...base, id: 'week-overdue', due_date: '2026-10-06' },
    { ...base, id: 'old-overdue', due_date: '2026-10-05' },
    { ...base, id: 'outside', title: 'Later', due_date: '2026-10-29' },
    { ...base, id: 'cancelled', title: 'Cancelled', due_date: day, cancelled_at: '2026-10-12T12:00:00Z' },
  ];
  kernel.listCourses = async () => [{ id: 'test-course', code: 'TEST100', name: 'Test course', enabled: true,
    synced_at: null, start_at: null, end_at: null }];
  try {
    const result = await repository.dashboardData(day, 'America/Toronto', Date.parse('2026-10-13T18:00:00Z'));
    assert.deepEqual(result.tasks.map(task => task.id), ['week-overdue','first-date', 'second-date']);
    assert.equal(result.tasks[0].canvasStatus, 'locked');
    assert.equal('plan' in result, false);
    assert.equal('aiAvailable' in result, false);
    const history = await db.prepare('SELECT * FROM daily_plans WHERE date=?').bind(day).first();
    assert.equal(history?.plan_json, 'retired invalid JSON');
    assert.equal(history?.source_version, 'historical-version');
    assert.equal(history?.generated_at, 'historical-time');
  } finally {
    kernel.taskRows = previousTasks;
    kernel.listCourses = previousCourses;
  }
});
