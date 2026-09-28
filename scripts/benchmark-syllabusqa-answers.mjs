import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
process.env.DATABASE_URL ||= `file:${resolve(root, 'syllabusqa.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
process.env.CHATGPT_AUTO = 'false';
const { searchLibrary } = await import('../lib/library.ts');
const { answerCourseQuestion } = await import('../lib/course-qa.ts');
const cases = JSON.parse(await readFile(resolve(root, 'syllabusqa-retrieval.json'), 'utf8')).results;
const output = resolve(root, process.env.BENCHMARK_ANSWERS_FILE || 'syllabusqa-answers-target.json');
let results = [];
try { results = JSON.parse(await readFile(output, 'utf8')).results || []; } catch { /* first run */ }
const done = new Set(results.map(row => row.id));
for (const row of cases) {
  if (done.has(row.id)) continue;
  // The syllabus title represents a student-selected course; unrelated course
  // outlines remain in the same large FTS index as hard negatives.
  const documentId = createHash('sha256').update(`syllabusqa:${row.syllabus}`).digest('hex');
  const hits = await searchLibrary('syllabusqa-owner', row.question, 'syllabusqa-course', false, { documentId, limit: 15 });
  const sources = hits.map((hit, index) => ({ ref: `S${index + 1}`, sourceId: hit.document_id,
    courseId: 'syllabusqa-course', courseCode: 'SELECTED COURSE', sourceType: 'document', title: `${hit.name} · ${hit.locator}`,
    excerpt: hit.body.slice(0, 300), body: hit.body, sourceUrl: null, updatedAt: null }));
  try {
    const response = await answerCourseQuestion(row.question, sources, { kernelMode: true });
    results.push({ ...row, answer: response.answer, cited: sources.filter(source => response.citationRefs.includes(source.ref)).map(source => source.title),
      targetCited: sources.some(source => response.citationRefs.includes(source.ref) && source.title.startsWith(row.syllabus + ' ·')) });
  } catch (error) { results.push({ ...row, error: String(error), targetCited: false }); }
  await writeFile(output, JSON.stringify({ dataset: 'SyllabusQA official test', results }, null, 2));
  if (results.length % 10 === 0) console.log(`Answered ${results.length}/${cases.length}`);
}
console.log(JSON.stringify({ queries: results.length, targetCited: results.filter(row => row.targetCited).length,
  errors: results.filter(row => row.error).length }));
