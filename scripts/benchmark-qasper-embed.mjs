import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
process.env.DATABASE_URL ||= `file:${resolve(root, 'qasper.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
const { database } = await import('../lib/database.ts');
const { EMBED_MODEL } = await import('../lib/mail-embedding.ts');
const { paidOpenAI } = await import('../lib/ai-budget.ts');
const selected = JSON.parse(await readFile(resolve(root, 'qasper-retrieval.json'), 'utf8')).results;
const ids = [...new Set(selected.map(row => row.paperId))];
let indexed = 0;
for (const id of ids) {
  const chunks = (await database.prepare(`SELECT c.id,c.body FROM library_chunks c LEFT JOIN library_vectors v ON v.chunk_id=c.id AND v.model=?
    WHERE c.document_id=? AND v.chunk_id IS NULL ORDER BY c.position`).bind(EMBED_MODEL, id).all()).results;
  for (let offset = 0; offset < chunks.length; offset += 64) {
    const batch = chunks.slice(offset, offset + 64);
    const response = await paidOpenAI('embeddings', { model: EMBED_MODEL, input: batch.map(row => row.body), dimensions: 768 });
    if (!response.ok) throw new Error(`Embedding failed: ${response.status}`);
    const data = (await response.json()).data;
    if (data.length !== batch.length) throw new Error('Incomplete embedding batch');
    await database.batch(data.map(item => database.prepare('INSERT OR IGNORE INTO library_vectors VALUES (?,?,?)')
      .bind(batch[item.index].id, EMBED_MODEL, JSON.stringify(item.embedding))));
    indexed += batch.length;
  }
  if (indexed && indexed % 500 < 64) console.log(`Embedded ${indexed} chunks`);
}
console.log(JSON.stringify({ papers: ids.length, newlyEmbeddedChunks: indexed }));
