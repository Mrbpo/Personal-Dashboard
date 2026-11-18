import test from 'node:test';
import assert from 'node:assert/strict';
import {recover} from './recover-settled-subtitle-cues.mjs';
import {isolatedSubtitleRequest} from '../../lib/subtitle-translation.ts';

function fixture() {
  const cues = [{en:'One',zh:'已有',startMs:0,endMs:800}, {en:'Two',zh:null,startMs:900,endMs:1200}];
  const target = {course:'42',family:'lecture1',title:'Lecture',sha:'a'.repeat(64),bundle:{cues}};
  const donor = structuredClone(target);
  donor.sha = 'b'.repeat(64);
  donor.bundle.cues[1].zh = '二';
  donor.bundle.cues[1].startMs = 920;
  donor.ledger = {calls:[{state:'settled',applied:true,charged:5.25e-6,responseFile:'/output/'+donor.sha+'.response-1.json'}]};
  const request = isolatedSubtitleRequest(1, 'Two', 'Lecture');
  const receipt = {...request, status:'completed', usage:{input_tokens:1, output_tokens:1}, output_text:'{"translations":{"1":"二"}}'};
  return {target, donor, receipt, lookup:() => Buffer.from(JSON.stringify(receipt))};
}
test('same request reuses only the translated text while preserving existing cues and original time', async () => {
  const {target, donor, lookup} = fixture();
  const result = await recover(target, donor, lookup);
  assert.deepEqual(result.bundle.cues, [target.bundle.cues[0], {...target.bundle.cues[1], zh:'二'}]);
  assert.equal(target.bundle.cues[1].zh,null);
  assert.equal(result.evidence[0].index,1);
  assert.match(result.evidence[0].receiptSha256,/^[a-f0-9]{64}$/);
});
for (const [label, change] of Object.entries({
  title: f => f.donor.title = 'Elsewhere',
  lecture: f => f.donor.family = 'Other',
  English: f => f.donor.bundle.cues[1].en = 'Too',
  pending: f => f.donor.ledger.calls[0].state = 'pending',
  unapplied: f => f.donor.ledger.calls[0].applied = false,
  charge: f => f.donor.ledger.calls[0].charged = 0,
  filename: f => f.donor.ledger.calls[0].responseFile = 'other.json',
  incomplete: f => f.receipt.status = 'incomplete',
  prompt: f => f.receipt.instructions += 'changed',
  result: f => f.receipt.output_text = '{"translations":{"1":"另"}}',
  index: f => f.receipt.text.format.schema.properties.translations.required = ['0'],
})) test('reject mismatched ' + label, async () => {
  const f = fixture();
  change(f);
  await assert.rejects(recover(f.target, f.donor, f.lookup));
});
