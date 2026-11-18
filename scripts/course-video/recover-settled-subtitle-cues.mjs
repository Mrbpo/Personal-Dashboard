/** Offline staging only. The caller controls publication and never has to settle a pending charge. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ISOLATED_SUBTITLE_PROMPT, isolatedSubtitleRequest, parseSubtitleTranslations} from '../../lib/subtitle-translation.ts';

const model = 'gpt-5.4-mini';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const same = (left, right, label) => {
  // Avoid printing subtitle text or receipts in errors.
  try { assert.deepStrictEqual(left, right); } catch { throw new Error(label); }
};

export async function recover(target, donor, lookup) {
  assert(target.sha !== donor.sha && target.course && target.course === donor.course, 'Course or track mismatch');
  assert(target.family && target.family === donor.family && target.title === donor.title, 'Lecture or title mismatch');
  assert(donor.bundle.cues.length === target.bundle.cues.length, 'Different cue count');
  same(donor.bundle.cues.map(c => c.en), target.bundle.cues.map(c => c.en), 'Different English track');
  const bundle = structuredClone(target.bundle);
  const missing = new Set(bundle.cues.flatMap((cue, i) => cue.zh === null ? [i] : []));
  assert(missing.size, 'No missing translations');
  const evidence = [];
  for (const [ordinal, call] of donor.ledger.calls.entries()) {
    if (call.state !== 'settled' || call.applied !== true) continue;
    const filename = donor.sha + '.response-' + (ordinal + 1) + '.json';
    assert(basename(call.responseFile) === filename, 'Unbound receipt file');
    const bytes = await lookup(filename);
    const payload = JSON.parse(bytes);
    const usage = payload.usage;
    assert(['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17'].includes(payload.model) && payload.status === 'completed', 'Unconfirmed response');
    assert([usage?.input_tokens, usage?.output_tokens].every(n => Number.isSafeInteger(n) && n >= 0), 'Unconfirmed usage');
    assert(call.charged === (usage.input_tokens * 0.75 + usage.output_tokens * 4.5) / 1e6, 'Receipt and ledger disagree');
    const format = payload.text?.format;
    const keys = format?.schema?.properties?.translations?.required;
    assert(Array.isArray(keys) && keys.length === 1 && /^(0|[1-9]\d*)$/.test(keys[0]), 'Unbound response index');
    const index = Number(keys[0]);
    if (!missing.has(index)) continue;
    const cue = bundle.cues[index];
    const request = isolatedSubtitleRequest(index, cue.en, target.title);
    same(format.schema, request.text.format.schema, 'Unexpected translation schema');
    assert(format.name === request.text.format.name && format.type === request.text.format.type && format.strict === true &&
      payload.instructions === request.instructions && payload.reasoning?.effort === request.reasoning.effort &&
      payload.max_output_tokens === request.max_output_tokens && payload.store === false, 'Unexpected request settings');
    const responseText = payload.output_text ?? payload.output?.flatMap(item => item.content ?? []).find(c => c.type === 'output_text')?.text;
    const [row] = parseSubtitleTranslations(JSON.parse(responseText), [index]);
    assert(row.zh === donor.bundle.cues[index].zh, 'Receipt disagrees with published donor cue');
    cue.zh = row.zh;
    missing.delete(index);
    evidence.push({index, filename, receiptSha256: digest(bytes), requestSha256: digest(JSON.stringify(request))});
  }
  assert(!missing.size, 'Insufficient settled matching receipts');
  bundle.translation = {model, promptVersion: ISOLATED_SUBTITLE_PROMPT};
  return {bundle, evidence};
}

async function loadTrack(entries, state, published, sha) {
  assert(/^[a-f0-9]{64}$/.test(sha), 'Invalid track hash');
  const records = entries.filter(entry => entry.files?.some(f => f.kind === 'video' && f.sha256 === sha));
  assert(records.length === 1, 'Ambiguous archive identity');
  const entry = records[0];
  const base = join(state, sha);
  const bundleBytes = await readFile(join(published, sha + '.json'));
  const bundle = JSON.parse(bundleBytes);
  const source = bundle.source;
  const proof = source.asr;
  assert(bundle.videoSha256 === sha && proof?.sourceVideoSha256 === sha && proof.timingProfile === 'word-pause-v2', 'Wrong source binding');
  assert(proof.subtitleSha256 === source.subtitleSha256 && /^[a-f0-9]{40}$/.test(proof.modelRevision), 'Invalid source version');
  const work = join(base, proof.modelRevision, 'word-pause-v2');
  const output = join(work, 'translation-output');
  same(await json(join(output, sha + '.json')), bundle, 'Checkpoint and publication differ');
  assert(digest(await readFile(join(work, 'translation-input', 'source.vtt'))) === source.subtitleSha256, 'Wrong English asset');
  const ledgerBytes = await readFile(join(output, sha + '.translation-ledger.json'));
  const ledger = JSON.parse(ledgerBytes);
  assert(ledger.sourceHash === source.subtitleSha256 && ledger.model === model &&
    ledger.promptVersion === ISOLATED_SUBTITLE_PROMPT && Array.isArray(ledger.calls), 'Wrong translation ledger');
  if (bundle.translation) same(bundle.translation, {model, promptVersion: ISOLATED_SUBTITLE_PROMPT}, 'Wrong published translation version');
  assert(typeof entry.title === 'string' && entry.entryId && entry.courseId, 'Missing archive metadata');
  return {sha, course: entry.courseId, family: entry.parentEntryId || entry.entryId, title: entry.title,
    bundle, ledger, output, bundleHash: digest(bundleBytes), ledgerHash: digest(ledgerBytes)};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifest, state, published, targetSha, donorSha, output] = process.argv.slice(2);
  if (!output) throw new Error('Expected manifest, bilingual state root, published root, target SHA, donor SHA and new staging directory');
  const entries = Object.values((await json(manifest)).entries);
  const [target, donor] = await Promise.all([targetSha, donorSha].map(sha => loadTrack(entries, state, published, sha)));
  const {bundle, evidence} = await recover(target, donor, filename => readFile(join(donor.output, filename)));
  await mkdir(output, {mode: 0o700});
  await writeFile(join(output, targetSha + '.json'), JSON.stringify(bundle), {flag:'wx', mode:0o600});
  await writeFile(join(output, 'evidence.json'), JSON.stringify({targetSha, donorSha, targetBundleSha256:target.bundleHash,
    donorBundleSha256:donor.bundleHash, targetLedgerSha256:target.ledgerHash, donorLedgerSha256:donor.ledgerHash, evidence}), {flag:'wx', mode:0o600});
  console.log(JSON.stringify({reused:evidence.length, total:bundle.cues.length, modelRequests:0}));
}
