import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Real, anonymized Piazza questions and instructor answers from CourseAssist.
// Cross-course noise uses public SyllabusQA outlines and HotpotQA documents.
// The dataset's Context field is separate course material, not a Canvas export.
if (!process.env.KERNEL_DATABASE_URL) throw new Error('Use an isolated PostgreSQL database');
const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
await mkdir(root, { recursive: true });
process.env.DATABASE_URL ||= `file:${resolve(root, 'courseassist.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
process.env.CHATGPT_AUTO = 'false';
const { database } = await import('../lib/database.ts');
const { kernel } = await import('../lib/kernel/service.ts');
const { searchArchiveForAnswer } = await import('../lib/archive-search.ts');
const { askKernel } = await import('../lib/kernel/ask.ts');
const { splitText } = await import('../lib/library.ts');
const hash = value => createHash('sha256').update(value).digest('hex');
const owner = 'courseassist-owner', courseId = 'courseassist-pl';
let rows;
try { rows = JSON.parse(await readFile(resolve(root, 'courseassist-qa.json'), 'utf8')); }
catch { throw new Error('Prepare data/benchmark/courseassist-qa.json from https://github.com/ytyfeng/CourseAssist-Data/blob/main/qa_data.csv'); }
rows = rows.filter(row => row.Question?.trim() && row.Answer?.trim()).slice(0, 50);
if (rows.length !== 50) throw new Error(`Expected 50 complete Piazza QA rows, got ${rows.length}`);
if (!(await kernel.getCourse(courseId))) await kernel.upsertCourse({ id: courseId, course_code: 'PL-REAL', name: 'Public Programming Languages Piazza', enabled: true }, 'legacy_import');
const now = '2026-01-01T00:00:00Z';
let inserts = [];
function library(id, name, body, origin) {
  inserts.push(database.prepare(`INSERT OR IGNORE INTO library_documents
    (id,owner_id,course_id,origin,origin_key,folder_path,name,mime,hash,size,status,created_at,deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).bind(id, owner, courseId, origin, JSON.stringify([courseId,name]),
    'benchmark', name, 'text/plain', hash(body), body.length, 'ready', now));
  for (const [position, chunk] of splitText(body).entries()) inserts.push(database.prepare(
    'INSERT OR IGNORE INTO library_chunks (id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
    .bind(`${id}:${position}`, id, position, `part ${position + 1}`, chunk, hash(chunk)));
}
for (const [index, row] of rows.entries()) {
  const id = `courseassist:piazza:${index}`;
  inserts.push(database.prepare(`INSERT OR IGNORE INTO piazza_posts
    (id,course_id,network_id,post_number,title,body,answer,kind,created_at,source_url,folders_json,content_hash,remote_updated_at,synced_at,is_active)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).bind(id, courseId, 'courseassist-public', String(index + 1),
    row.Question, row.Question, row.Answer, 'question', now,
    `https://github.com/ytyfeng/CourseAssist-Data/blob/main/qa_data.csv`, '[]', hash(row.Answer), now, now));
  if (row.Context?.trim()) library(`courseassist:context:${index}`, `Course material for Piazza post ${index + 1}`,
    row.Context, 'published-course-context');
}
await database.batch(inserts);
// A large same-course index forces ranking between the real forum threads,
// their course context, and unrelated study documents.
const syllabusTree = await (await fetch('https://api.github.com/repos/umass-ml4ed/SyllabusQA/git/trees/main?recursive=1')).json();
const outlines = syllabusTree.tree.filter(item => /^syllabi\/syllabi_redacted\/text\/[^/]+\.txt$/.test(item.path));
inserts = [];
for (const item of outlines) {
  const name = item.path.split('/').at(-1).replace(/\.txt$/, '');
  const body = await readFile(resolve(root, `syllabus-${hash(name)}.txt`), 'utf8');
  library(`courseassist:syllabus:${hash(name)}`, `${name}.txt`, body, 'public-syllabus');
  if (inserts.length > 300) { await database.batch(inserts); inserts = []; }
}
if (inserts.length) await database.batch(inserts);
const hotpot = (await Promise.all(Array.from({ length: 10 }, (_, i) => readFile(resolve(root, `hotpot_rows_${i * 100}.json`), 'utf8'))))
  .flatMap(text => JSON.parse(text).rows.map(item => item.row));
const background = new Map();
for (const row of hotpot) for (let j = 0; j < row.context.title.length && background.size < 2000; j++)
  if (!background.has(row.context.title[j])) background.set(row.context.title[j], row.context.sentences[j].join(' '));
inserts = [];
for (const [title, body] of background) {
  library(`courseassist:bg:${hash(title)}`, title, body, 'public-background');
  if (inserts.length > 300) { await database.batch(inserts); inserts = []; }
}
if (inserts.length) await database.batch(inserts);
const onlyIds = new Set((process.argv.find(arg => arg.startsWith('--only-ids='))?.split('=')[1] || '')
  .split(',').filter(Boolean).map(Number));
let results = onlyIds.size ? JSON.parse(await readFile(resolve(root, 'courseassist-results.json'), 'utf8')).results : [];
const withAnswers = process.argv.includes('--answers');
const answerSample = Number(process.argv.find(arg => arg.startsWith('--answer-sample='))?.split('=')[1] || 50);
for (const [index, row] of rows.entries()) {
  if (onlyIds.size && !onlyIds.has(index)) continue;
  const search = await searchArchiveForAnswer(owner, row.Question, courseId, 18);
  const retrieved = search.sources.map(source => source.sourceId);
  const item = { id: index, category: row.Category, question: row.Question, reference: row.Answer,
    contextAvailable: Boolean(row.Context?.trim()), targetFound: retrieved.includes(`courseassist:piazza:${index}`),
    rank: retrieved.indexOf(`courseassist:piazza:${index}`) + 1, retrieved };
  if (withAnswers && (onlyIds.size || index % Math.max(1, Math.floor(rows.length / answerSample)) === 0
    && results.filter(item => item.answer).length < answerSample)) {
    try { const response = await askKernel(owner, row.Question, courseId);
      Object.assign(item, { answer: response.answer, cited: response.citations.map(c => c.sourceId),
        targetCited: response.citations.some(c => c.sourceId === `courseassist:piazza:${index}`) }); }
    catch (error) { item.error = String(error); }
  }
  results = [...results.filter(previous => previous.id !== index), item].sort((a, b) => a.id - b.id);
  if (withAnswers || results.length % 10 === 0) await writeFile(resolve(root, 'courseassist-results.json'),
    JSON.stringify({ dataset: 'CourseAssist public real Piazza QA', results }, null, 2));
}
await writeFile(resolve(root, 'courseassist-results.json'), JSON.stringify({ dataset: 'CourseAssist public real Piazza QA', results }, null, 2));
console.log(JSON.stringify({ piazzaPosts: rows.length, courseContext: rows.filter(row => row.Context?.trim()).length,
  publicOutlines: outlines.length, backgroundDocuments: background.size, targetFoundAt18: results.filter(row => row.targetFound).length,
  ...(withAnswers ? { answered: results.filter(row => row.answer).length, targetCited: results.filter(row => row.targetCited).length } : {}) }));
