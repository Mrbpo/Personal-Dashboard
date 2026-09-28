import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Official AllenAI QASPER validation: full research papers, reader questions,
// human evidence paragraphs. https://huggingface.co/datasets/allenai/qasper
const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
await mkdir(root, { recursive: true });
process.env.DATABASE_URL ||= `file:${resolve(root, 'qasper.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
process.env.CHATGPT_AUTO = 'false';
const { database } = await import('../lib/database.ts');
const { searchLibrary, splitText } = await import('../lib/library.ts');
const hash = value => createHash('sha256').update(value).digest('hex');
const owner = 'qasper-owner', course = 'research-reading';
const papers = [];
for (let offset = 0; offset < 100; offset += 20) {
  const file = resolve(root, `qasper-${offset}.json`);
  let data;
  try { data = JSON.parse(await readFile(file, 'utf8')); }
  catch {
    const url = `https://datasets-server.huggingface.co/rows?dataset=allenai/qasper&config=qasper&split=validation&offset=${offset}&length=20`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    data = await response.json();
    await writeFile(file, JSON.stringify(data));
  }
  papers.push(...data.rows.map(item => item.row));
}
let statements = [], chunkCount = 0;
const available = [];
for (const paper of papers) {
  const id = `qasper:${paper.id}`;
  const paragraphs = paper.full_text.paragraphs.flat().filter(Boolean);
  const chunks = [paper.abstract, ...paragraphs].flatMap((paragraph, index) => splitText(paragraph).map((body, part) =>
    ({ body, locator: index ? `paragraph ${index}${part ? ` part ${part + 1}` : ''}` : 'abstract' })));
  statements.push(database.prepare(`INSERT OR IGNORE INTO library_documents
    (id,owner_id,course_id,origin,origin_key,folder_path,name,mime,hash,size,status,created_at,deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0)`).bind(id, owner, course, 'qasper', JSON.stringify([paper.id]), 'QASPER research papers', paper.title,
      'text/plain', hash(paper.id), chunks.reduce((sum, chunk) => sum + chunk.body.length, 0), 'ready', '2026-01-01T00:00:00Z'));
  for (const [position, chunk] of chunks.entries()) {
    statements.push(database.prepare('INSERT OR IGNORE INTO library_chunks (id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
      .bind(`${id}:${position}`, id, position, chunk.locator, chunk.body, hash(chunk.body)));
    chunkCount++;
  }
  if (statements.length >= 300) { await database.batch(statements); statements = []; }
  for (let index = 0; index < paper.qas.question.length; index++) {
    const annotations = paper.qas.answers[index]?.answer || [];
    const annotation = annotations.find(item => !item.unanswerable && item.extractive_spans?.some(span => span.trim()) &&
      item.evidence?.some(evidence => chunks.some(chunk => chunk.body.includes(evidence) || evidence.includes(chunk.body.slice(0, 100))))) || null;
    if (!annotation) continue;
    const evidence = annotation.evidence.filter(value => value?.trim());
    const goldChunkIds = chunks.map((chunk, part) => evidence.some(value => chunk.body.includes(value) || value.includes(chunk.body.slice(0, 100))) ? `${id}:${part}` : null).filter(Boolean);
    if (!goldChunkIds.length) continue;
    available.push({ id: paper.qas.question_id[index], paperId: id, paperTitle: paper.title, question: paper.qas.question[index],
      answer: annotation.extractive_spans.join('; '), goldChunkIds });
  }
}
if (statements.length) await database.batch(statements);
const selected = Array.from({ length: 50 }, (_, i) => available[Math.floor((i + 0.5) * available.length / 50)]);
const results = [];
for (const row of selected) {
  // The student has selected this paper; search its entire full text while
  // retaining 99 other papers in the same physical index.
  const hits = await searchLibrary(owner, row.question, course, true, { documentId: row.paperId, limit: 80 });
  results.push({ ...row, retrieved: hits.map(hit => hit.id), evidenceFound: row.goldChunkIds.some(id => hits.some(hit => hit.id === id)),
    paperFound: hits.some(hit => hit.document_id === row.paperId) });
}
await writeFile(resolve(root, 'qasper-retrieval.json'), JSON.stringify({ dataset: 'QASPER official validation', papers: papers.length, chunks: chunkCount,
  eligibleQuestions: available.length, results }, null, 2));
console.log(JSON.stringify({ papers: papers.length, chunks: chunkCount, eligibleQuestions: available.length, queries: results.length,
  paperFound: results.filter(row => row.paperFound).length, evidenceFound: results.filter(row => row.evidenceFound).length }));
