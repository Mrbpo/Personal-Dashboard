import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
process.env.DATABASE_URL ||= `file:${resolve(root, 'qasper.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
const { database } = await import('../lib/database.ts');
const { evidenceLimitForQuestion, selectDocumentEvidence } = await import('../lib/kernel/evidence-selection.ts');
const cases = JSON.parse(await readFile(resolve(root, 'qasper-retrieval.json'), 'utf8')).results;
const limit = Math.max(1, Math.min(20, Number(process.env.BENCHMARK_SELECT_LIMIT || 10)));
const adaptive = process.env.BENCHMARK_ADAPTIVE === '1';
const diagnostic = process.argv.includes('--retry-failures');
const output = resolve(root, `qasper-selection-${adaptive ? 'adaptive' : limit}${diagnostic ? '-retry' : ''}.json`);
let results = [];
try { results = JSON.parse(await readFile(output, 'utf8')).results || []; } catch { /* first run */ }
const done = new Set(results.map(row => row.id));
const previous = diagnostic ? JSON.parse(await readFile(resolve(root, 'qasper-selection-10.json'), 'utf8')).results : [];
const selectedCases = (diagnostic ? cases.filter(row => previous.some(item => item.id === row.id && !item.evidenceSelected)) : cases)
  .filter(row => !process.env.BENCHMARK_ONLY_QUESTION || row.question.includes(process.env.BENCHMARK_ONLY_QUESTION));
for (const row of selectedCases) {
  if (done.has(row.id)) continue;
  const candidates = [];
  for (const id of row.retrieved.slice(0, Number(process.env.BENCHMARK_CANDIDATES || 50))) {
    const chunk = await database.prepare('SELECT c.body,c.locator,d.name,d.course_id FROM library_chunks c JOIN library_documents d ON d.id=c.document_id WHERE c.id=?').bind(id).first();
    if (chunk) candidates.push({ id, document_id: row.paperId, name: chunk.name, course_id: chunk.course_id,
      body: chunk.body, locator: chunk.locator, score: 0 });
  }
  const selected = await selectDocumentEvidence(row.question, candidates, adaptive ? evidenceLimitForQuestion(row.question, limit) : limit);
  results.push({ id: row.id, question: row.question, goldChunkIds: row.goldChunkIds, selected: selected.map(hit => hit.id),
    evidenceSelected: row.goldChunkIds.some(id => selected.some(hit => hit.id === id)),
    allGoldEvidenceSelected: row.goldChunkIds.every(id => selected.some(hit => hit.id === id)) });
  await writeFile(output, JSON.stringify({ dataset: 'QASPER official validation', results }, null, 2));
  if (results.length % 10 === 0) console.log(`Selected ${results.length}/${selectedCases.length}`);
}
console.log(JSON.stringify({ queries: results.length, evidenceSelected: results.filter(row => row.evidenceSelected).length }));
