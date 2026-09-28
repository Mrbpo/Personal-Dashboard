import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.env.BENCHMARK_DATA_DIR || 'data/benchmark');
process.env.DATABASE_URL ||= `file:${resolve(root, 'syllabusqa.sqlite')}`;
process.env.SERVICE_VAULT_DIR ||= resolve(root, 'private');
const { aiResponse } = await import('../lib/ai-response.ts');
const { serviceValue } = await import('../lib/service-vault.ts');
const forum = process.env.BENCHMARK_DATASET === 'courseassist';
let answers = JSON.parse(await readFile(resolve(root, forum ? 'courseassist-results.json'
  : process.env.BENCHMARK_ANSWERS_FILE || 'syllabusqa-answers-target.json'), 'utf8')).results;
const onlyIds = new Set((process.env.BENCHMARK_ONLY_IDS || '').split(',').filter(Boolean).map(Number));
if (forum && onlyIds.size) answers = answers.filter(row => onlyIds.has(row.id));
const gold = new Map((forum ? answers.map(row => ({ ...row, answer: row.reference }))
  : JSON.parse(await readFile(resolve(root, 'syllabusqa-retrieval.json'), 'utf8')).results).map(row => [row.id, row]));
const output = resolve(root, process.env.BENCHMARK_JUDGMENTS_FILE || (forum ? 'courseassist-judgments.json' : 'syllabusqa-judgments.json'));
let results = [];
try { results = JSON.parse(await readFile(output, 'utf8')).results || []; } catch { /* first run */ }
const done = new Set(results.filter(row => !row.error && !onlyIds.has(row.id)).map(row => row.id));
for (const item of answers) {
  if (done.has(item.id)) continue;
  const reference = gold.get(item.id);
  const schema = { type: 'object', additionalProperties: false, properties: {
    correct: { type: 'boolean' }, reason: { type: 'string' },
  }, required: ['correct', 'reason'] };
  try {
    const response = await aiResponse('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { Authorization: `Bearer ${serviceValue('OPENAI_API_KEY')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: serviceValue('OPENAI_MODEL') || 'gpt-5-mini', store: false,
        input: [{ role: 'user', content: [{ type: 'input_text', text: `Strictly assess whether the candidate answers the question with the essential facts in the human reference answer. Allow clear paraphrases and shorter complete answers. Reject contradictions, invented specifics, and evasive answers when the reference gives a fact. Do not give credit merely for a citation. Return a short reason.\nQuestion: ${reference.question}\nHuman reference: ${reference.answer}\nCandidate: ${item.answer}` }] }],
        text: { format: { type: 'json_schema', name: 'answer_judgment', strict: true, schema } }, max_output_tokens: 1200 }) });
    if (!response.ok) throw new Error(`JUDGE_${response.status}`);
    const payload = await response.json();
    const outputText = payload.output_text || payload.output?.flatMap(value => value.content || []).find(value => value.type === 'output_text')?.text;
    const verdict = JSON.parse(outputText);
    results = results.filter(row => row.id !== item.id);
    results.push({ id: item.id, question: reference.question, correct: Boolean(verdict.correct), reason: String(verdict.reason), targetCited: item.targetCited });
  } catch (error) { results = results.filter(row => row.id !== item.id);
    results.push({ id: item.id, question: reference.question, correct: false, error: String(error), targetCited: item.targetCited }); }
  await writeFile(output, JSON.stringify({ dataset: forum ? 'CourseAssist real Piazza QA' : 'SyllabusQA official test', results }, null, 2));
  if (results.length % 10 === 0) console.log(`Judged ${results.length}/${answers.length}`);
}
console.log(JSON.stringify({ judged: results.length, correct: results.filter(row => row.correct).length,
  targetCited: results.filter(row => row.targetCited).length, errors: results.filter(row => row.error).length }));
