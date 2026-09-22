import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL = ':memory:';
process.env.AI_BUDGET_TEST_BYPASS = 'true';
process.env.OPENAI_API_KEY = 'test-key';

const vocabulary = await import('../lib/vocabulary.ts');

test('manual vocabulary deduplicates a term, keeps contexts and stays owner-scoped', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ output_text: JSON.stringify({ meaning: '惯性：物体保持原有运动状态的性质。', language: '英语', partOfSpeech: '名词' }) });
  try {
    const first = await vocabulary.saveVocabularyEntry('alice', { term: 'Inertia', background: 'Inertia keeps the object moving.' });
    const second = await vocabulary.saveVocabularyEntry('alice', { term: '  inertia ', background: 'Mass is a measure of inertia.' });
    assert.equal(first.id, second.id);
    assert.deepEqual(second.contexts, ['Inertia keeps the object moving.', 'Mass is a measure of inertia.']);
    assert.equal(second.definitionStatus, 'complete');
    assert.equal((await vocabulary.listVocabularyEntries('alice')).length, 1);
    assert.equal((await vocabulary.listVocabularyEntries('bob')).length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test('vocabulary examples are stored as three structured bilingual examples', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const format = body.text?.format?.name;
    if (format === 'vocabulary_definition') return Response.json({ output_text: JSON.stringify({ meaning: '动量。', language: '英语', partOfSpeech: '名词' }) });
    return Response.json({ output_text: JSON.stringify({ examples: [
      { sentence: 'Momentum is conserved.', translation: '动量守恒。', note: '被动语态' },
      { sentence: 'The cart gained momentum.', translation: '小车获得了动量。', note: 'gain momentum' },
      { sentence: 'They built political momentum.', translation: '他们积累了政治势头。', note: '引申义' },
    ] }) });
  };
  try {
    const entry = await vocabulary.saveVocabularyEntry('alice', { term: 'momentum', background: 'The collision conserves momentum.' });
    const completed = await vocabulary.generateVocabularyExamples('alice', entry.id);
    assert.equal(completed.exampleStatus, 'complete');
    assert.equal(completed.examples.length, 3);
    assert.equal(completed.examples[0].translation, '动量守恒。');
  } finally {
    globalThis.fetch = original;
  }
});
