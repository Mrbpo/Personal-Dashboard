import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Official ACL 2024 dataset: https://github.com/umass-ml4ed/SyllabusQA
const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
await mkdir(root, { recursive: true });
process.env.DATABASE_URL ||= `file:${resolve(root, 'syllabusqa.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
process.env.CHATGPT_AUTO = 'false';
const { database } = await import('../lib/database.ts');
const { searchLibrary, splitText } = await import('../lib/library.ts');
const base = 'https://raw.githubusercontent.com/umass-ml4ed/SyllabusQA/main/';
async function cached(path, url) {
  try { return await readFile(resolve(root, path), 'utf8'); } catch { /* download once */ }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${url}`);
  const body = await response.text();
  await writeFile(resolve(root, path), body);
  return body;
}
const tree = await (await fetch('https://api.github.com/repos/umass-ml4ed/SyllabusQA/git/trees/main?recursive=1')).json();
const files = tree.tree.filter(item => /^syllabi\/syllabi_redacted\/text\/[^/]+\.txt$/.test(item.path));
const test = JSON.parse(await cached('syllabusqa-test.json', `${base}data/dataset_split/test.json`));
const owner = 'syllabusqa-owner', course = 'syllabusqa-course';
let inserts = [], chunkCount = 0;
for (const item of files) {
  const name = item.path.split('/').at(-1).replace(/\.txt$/, '');
  const body = await cached(`syllabus-${createHash('sha256').update(name).digest('hex')}.txt`, `${base}${item.path.split('/').map(encodeURIComponent).join('/')}`);
  const id = createHash('sha256').update(`syllabusqa:${name}`).digest('hex');
  inserts.push(database.prepare('INSERT OR IGNORE INTO library_documents (id,owner_id,course_id,origin,origin_key,folder_path,name,mime,hash,size,status,created_at,deleted) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)')
    .bind(id, owner, course, 'benchmark', JSON.stringify(['syllabusqa', name]), 'SyllabusQA / course outlines', name, 'text/plain', id, body.length, 'ready', '2026-01-01T00:00:00Z'));
  for (const [position, chunk] of splitText(body).entries()) {
    inserts.push(database.prepare('INSERT OR IGNORE INTO library_chunks (id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
      .bind(`${id}:${position}`, id, position, `正文 ${position + 1}`, chunk, createHash('sha256').update(chunk).digest('hex')));
    chunkCount++;
  }
  if (inserts.length >= 300) { await database.batch(inserts); inserts = []; }
}
if (inserts.length) await database.batch(inserts);
const valid = test.filter(row => files.some(item => item.path.endsWith(`/${row.syllabus_name}.txt`)));
const selected = Array.from({ length: 50 }, (_, i) => valid[Math.floor((i + 0.5) * valid.length / 50)]);
const results = [];
for (const row of selected) {
  const query = `${row.syllabus_name}: ${row.question}`;
  const hits = await searchLibrary(owner, query, course, false, { limit: 18 });
  results.push({ id: row.id, syllabus: row.syllabus_name, question: row.question, answer: row.answer,
    found: hits.some(hit => hit.name === row.syllabus_name), retrieved: hits.map(hit => ({ title: hit.name, chunk: hit.locator })) });
}
await writeFile(resolve(root, 'syllabusqa-retrieval.json'), JSON.stringify({ dataset: 'SyllabusQA official test', documents: files.length, chunks: chunkCount, results }, null, 2));
console.log(JSON.stringify({ documents: files.length, chunks: chunkCount, queries: results.length, targetDocumentFoundAt18: results.filter(row => row.found).length }));
