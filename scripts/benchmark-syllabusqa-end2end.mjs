import { createHash } from 'node:crypto';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Exercise the actual /kernel/ask service: each public syllabus is one selected
// course, while all 63 documents remain in the same SQLite archive index.
if (!process.env.KERNEL_DATABASE_URL) throw new Error('Use an isolated PostgreSQL database');
const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
const targetDb = resolve(root, 'syllabusqa-end2end.sqlite');
try { await stat(targetDb); } catch { await copyFile(resolve(root, 'syllabusqa.sqlite'), targetDb); }
process.env.DATABASE_URL = `file:${targetDb}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
process.env.CHATGPT_AUTO = 'false';
const { database } = await import('../lib/database.ts');
const { kernel } = await import('../lib/kernel/service.ts');
const { askKernel } = await import('../lib/kernel/ask.ts');
const data = JSON.parse(await readFile(resolve(root, 'syllabusqa-retrieval.json'), 'utf8')).results;
const documents = (await database.prepare('SELECT id,name FROM library_documents WHERE owner_id=?').bind('syllabusqa-owner').all()).results;
for (const [index, doc] of documents.entries()) {
  const courseId = `sqa:${createHash('sha256').update(doc.name).digest('hex').slice(0,16)}`;
  if (!(await kernel.getCourse(courseId))) await kernel.upsertCourse({ id: courseId, course_code: `SQA${String(index + 1).padStart(3, '0')}`,
    name: `SyllabusQA ${doc.name}`, enabled: true }, 'legacy_import');
  await database.prepare('UPDATE library_documents SET course_id=? WHERE id=?').bind(courseId, doc.id).run();
}
const byName = new Map(documents.map(doc => [doc.name, `sqa:${createHash('sha256').update(doc.name).digest('hex').slice(0,16)}`]));
const sample = Math.max(1, Math.min(50, Number(process.argv.find(arg => arg.startsWith('--sample='))?.split('=')[1] || 50)));
const cases = Array.from({ length: sample }, (_, i) => data[Math.floor((i + 0.5) * data.length / sample)]);
const output = resolve(root, process.env.BENCHMARK_OUTPUT_FILE || `syllabusqa-end2end-${sample}.json`);
let results = [];
try { results = JSON.parse(await readFile(output, 'utf8')).results || []; } catch { /* first run */ }
const done = new Set(results.map(row => row.id));
for (const row of cases) {
  if (done.has(row.id)) continue;
  const courseId = byName.get(row.syllabus);
  if (!courseId) throw new Error(`Missing syllabus course: ${row.syllabus}`);
  try { const response = await askKernel('syllabusqa-owner', row.question, courseId);
    results.push({ id: row.id, question: row.question, reference: row.answer, syllabus: row.syllabus,
      answer: response.answer, citations: response.citations.map(citation => citation.title),
      targetCited: response.citations.some(citation => citation.title.startsWith(row.syllabus + ' ·')) }); }
  catch (error) { results.push({ id: row.id, question: row.question, reference: row.answer, syllabus: row.syllabus,
    error: String(error), targetCited: false }); }
  await writeFile(output, JSON.stringify({ dataset: 'SyllabusQA end-to-end selected course', results }, null, 2));
  if (results.length % 5 === 0) console.log(`End-to-end answered ${results.length}/${cases.length}`);
}
console.log(JSON.stringify({ queries: results.length, targetCited: results.filter(row => row.targetCited).length,
  errors: results.filter(row => row.error).length }));
