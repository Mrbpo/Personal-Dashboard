import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
process.env.DATABASE_URL ||= `file:${resolve(root, 'qasper.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
process.env.CHATGPT_AUTO = 'false';
const { database } = await import('../lib/database.ts');
const { answerCourseQuestion } = await import('../lib/course-qa.ts');
const failed = process.env.BENCHMARK_ONLY_FAILED === '1'
  ? new Set(JSON.parse(await readFile(resolve(root, 'qasper-judgments.json'), 'utf8')).results.filter(row => !row.correct).map(row => row.id)) : null;
const evidence = JSON.parse(await readFile(resolve(root, process.env.BENCHMARK_SELECTION_FILE || 'qasper-selection-14.json'), 'utf8')).results
  .filter(row => (!failed || failed.has(row.id)) && (!process.env.BENCHMARK_ONLY_QUESTIONS
    || process.env.BENCHMARK_ONLY_QUESTIONS.split('|').some(term => row.question.includes(term))));
const cases = new Map(JSON.parse(await readFile(resolve(root, 'qasper-retrieval.json'), 'utf8')).results.map(row => [row.id, row]));
const output = resolve(root, process.env.BENCHMARK_ANSWERS_FILE || (failed ? 'qasper-answers-retry.json' : 'qasper-answers.json'));
let results = [];
try { results = JSON.parse(await readFile(output, 'utf8')).results || []; } catch { /* first run */ }
const done = new Set(results.map(row => row.id));
for (const selected of evidence) {
  if (done.has(selected.id)) continue;
  const row = cases.get(selected.id);
  const sources = [];
  const selectedIds = process.env.BENCHMARK_SORT_POSITION === '1'
    ? [...selected.selected].sort((a, b) => Number(a.split(':').at(-1)) - Number(b.split(':').at(-1))) : selected.selected;
  for (const id of selectedIds) {
    const chunk = await database.prepare('SELECT c.body,c.locator,d.name,d.course_id FROM library_chunks c JOIN library_documents d ON d.id=c.document_id WHERE c.id=?').bind(id).first();
    if (chunk) sources.push({ ref: `S${sources.length + 1}`, sourceId: id, courseId: chunk.course_id,
      courseCode: 'SELECTED PAPER', sourceType: 'document', title: `${chunk.name} · ${chunk.locator}`,
      excerpt: chunk.body.slice(0, 300), body: chunk.body, sourceUrl: null, updatedAt: null });
  }
  try {
    const response = await answerCourseQuestion(row.question, sources, { kernelMode: true });
    results.push({ id: selected.id, question: row.question, expected: row.answer, answer: response.answer,
      cited: sources.filter(source => response.citationRefs.includes(source.ref)).map(source => source.sourceId),
      goldEvidenceSelected: selected.evidenceSelected });
  } catch (error) { results.push({ id: selected.id, question: row.question, expected: row.answer, error: String(error),
    cited: [], goldEvidenceSelected: selected.evidenceSelected }); }
  await writeFile(output, JSON.stringify({ dataset: 'QASPER official validation', results }, null, 2));
  if (results.length % 10 === 0) console.log(`Answered ${results.length}/${evidence.length}`);
}
console.log(JSON.stringify({ queries: results.length, cited: results.filter(row => row.cited?.length).length,
  goldEvidenceSelected: results.filter(row => row.goldEvidenceSelected).length, errors: results.filter(row => row.error).length }));
