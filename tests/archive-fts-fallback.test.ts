import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = ':memory:';
process.env.OPENAI_API_KEY = '';
const repo = await import('../lib/repository.ts');
const lib = await import('../lib/library.ts');
const { database, searchIndexAvailable } = await import('../lib/database.ts');
const { searchArchiveForAnswer } = await import('../lib/archive-search.ts');

test('archive search stays owner- and course-scoped when FTS tables are unavailable', async () => {
  await repo.upsertCourses([
    { id: 'math', name: 'Calculus I', course_code: 'MATA29H3' },
    { id: 'stats', name: 'Statistics I', course_code: 'STAB22H3' },
  ]);
  const mathDocument = await lib.saveDocument('student', 'math', 'upload', 'math-tut', 'MATA29 Tutorial 2.txt', 'text/plain', Buffer.from('Complete problems 1 and 2.'));
  const statsDocument = await lib.saveDocument('student', 'stats', 'upload', 'stats-tut', 'STAB22 Tutorial 2.txt', 'text/plain', Buffer.from('Create boxplots.'));
  await lib.indexDocument('student', mathDocument);
  await lib.indexDocument('student', statsDocument);
  const source = { id: 'math:tut2', courseId: 'math', sourceType: 'assignment', sourceId: 'tut2', title: 'Tutorial 2 requirements', body: 'Complete problems 1 and 2.', sourceUrl: null, updatedAt: null, dueAt: null, unlockAt: null, lockAt: null, submissionState: null, pointsPossible: null, prerequisiteBlocked: false };
  await repo.saveSource(source, null, await repo.hashSource(source), 'rule_only');

  assert.equal(await searchIndexAvailable(), true);
  await database.prepare('DROP TABLE source_items_fts').run();
  await database.prepare('DROP TABLE library_chunks_fts').run();

  const result = await searchArchiveForAnswer('student', 'MATA29 Tutorial 2 requirements');
  assert.equal(result.inferredCourseId, 'math');
  assert.ok(result.sources.some((item) => item.sourceType === 'assignment'));
  assert.ok(result.sources.some((item) => item.sourceId === mathDocument));
  assert.ok(result.sources.every((item) => item.courseId === 'math'));
  assert.ok(!result.sources.some((item) => item.sourceId === statsDocument));

  const missing = await searchArchiveForAnswer('student', 'ZZZNoSource42');
  assert.deepEqual(missing.sources, []);
});
