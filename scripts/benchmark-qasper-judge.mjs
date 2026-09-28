import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
process.env.DATABASE_URL ||= `file:${resolve(root, 'qasper.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
const { aiResponse } = await import('../lib/ai-response.ts');
const { serviceValue } = await import('../lib/service-vault.ts');
const sourceGrounded = process.env.BENCHMARK_SOURCE_GROUNDED === '1';
let answers = JSON.parse(await readFile(resolve(root, process.env.BENCHMARK_ANSWERS_FILE || 'qasper-answers.json'), 'utf8')).results;
if (sourceGrounded && process.env.BENCHMARK_SOURCE_ALL !== '1') {
  const failed = new Set(JSON.parse(await readFile(resolve(root, 'qasper-judgments.json'), 'utf8')).results.filter(row => !row.correct).map(row => row.id));
  answers = answers.filter(row => failed.has(row.id));
}
const output = resolve(root, process.env.BENCHMARK_JUDGMENTS_FILE || (sourceGrounded ? 'qasper-grounding.json' : 'qasper-judgments.json'));
const database = sourceGrounded ? (await import('../lib/database.ts')).database : null;
const papers = sourceGrounded ? new Map(JSON.parse(await readFile(resolve(root, 'qasper-retrieval.json'), 'utf8')).results.map(row => [row.id, row.paperId])) : null;
let results = [];
try { results = JSON.parse(await readFile(output, 'utf8')).results || []; } catch { /* first run */ }
const done = new Set(results.filter(row => !row.error).map(row => row.id));
const schema = { type: 'object', additionalProperties: false,
  properties: { correct: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['correct', 'reason'] };
for (const item of answers) {
  if (done.has(item.id)) continue;
  try {
    const paperId = papers?.get(item.id);
    const paper = sourceGrounded && paperId ? (await database.prepare(
      'SELECT c.body FROM library_chunks c WHERE c.document_id=? ORDER BY c.position').bind(paperId).all()).results
      .map(row => row.body).join('\n\n').slice(0, 100000) : '';
    const response = await aiResponse('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { Authorization: `Bearer ${serviceValue('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: serviceValue('OPENAI_MODEL') || 'gpt-5-mini', store: false,
        input: [{ role: 'user', content: [{ type: 'input_text', text: sourceGrounded
          ? `Audit this answer against the full paper, without seeing the human reference. Is the answer direct and are all material claims supported? Reject contradictions, invented details, or a missing central answer. Accept supported extra detail. Briefly explain the decisive evidence.\nQuestion: ${item.question}\nCandidate: ${item.answer || '(no answer)'}\nPaper:\n${paper}`
          : `Evaluate the candidate answer against the human reference for the research-paper question. Accept paraphrases, logically equivalent short answers, and additional source-grounded detail. Reject a missing key fact, contradiction, invented claim, or failure to answer. Ignore citation markers. Return a brief reason.\nQuestion: ${item.question}\nReference: ${item.expected}\nCandidate: ${item.answer || '(no answer)'}` }] }],
        text: { format: { type: 'json_schema', name: 'qasper_judgment', strict: true, schema } }, max_output_tokens: 1200 }) });
    if (!response.ok) throw new Error(`JUDGE_${response.status}`);
    const payload = await response.json();
    const outputText = payload.output_text || payload.output?.flatMap(value => value.content || []).find(value => value.type === 'output_text')?.text;
    const verdict = JSON.parse(outputText);
    results = results.filter(row => row.id !== item.id);
    results.push({ id: item.id, question: item.question, correct: Boolean(verdict.correct), reason: String(verdict.reason),
      goldEvidenceSelected: item.goldEvidenceSelected });
  } catch (error) { results = results.filter(row => row.id !== item.id);
    results.push({ id: item.id, question: item.question, correct: false, error: String(error),
      goldEvidenceSelected: item.goldEvidenceSelected }); }
  await writeFile(output, JSON.stringify({ dataset: 'QASPER official validation', results }, null, 2));
  if (results.length % 10 === 0) console.log(`Judged ${results.length}/${answers.length}`);
}
console.log(JSON.stringify({ judged: results.length, correct: results.filter(row => row.correct).length,
  errors: results.filter(row => row.error).length }));
