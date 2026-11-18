import assert from 'node:assert/strict';
import test from 'node:test';
import {prepareSubtitleReplacement,subtitleDigest,subtitleReplacementBatch} from '../../lib/subtitle-ledger-recovery.ts';
const video='a'.repeat(64),sourceHash='b'.repeat(64);
const pending={state:'pending',reservation:0.006,responseFile:'/output/'+video+'.response-1.json'};
const raw=(version='subtitle-zh-v2')=>JSON.stringify({model:'gpt-5.4-mini',sourceHash,promptVersion:version,calls:[pending]});
function make(version,receipt=null) {
  const bytes=raw(version);
  return prepareSubtitleReplacement(video,bytes,1,subtitleDigest(bytes),5,'operator',receipt&&Buffer.from(JSON.stringify(receipt)));
}
test('missing original receipt and residual reservation survive one opt-in replacement',()=>{
  const ledger=make();assert.equal(subtitleReplacementBatch(ledger,video,5),1);
  const {replacementReview,...original}=ledger.calls[0]; assert.deepEqual(original,pending);assert.equal(replacementReview.reportedUsage,null);
  assert.throws(()=>subtitleReplacementBatch(ledger,video,6)); assert.throws(()=>subtitleReplacementBatch(ledger,'c'.repeat(64),5));
  ledger.calls.push({...pending,responseFile:'/output/'+video+'.response-2.json'});
  assert.throws(()=>subtitleReplacementBatch(ledger,video,5)); // One ambiguous replacement halts.
  ledger.calls[1]={state:'settled',charged:0.002,applied:true,responseFile:'2',reservation:0.006};
  assert.equal(subtitleReplacementBatch(ledger,video,6),1); // Other untouched cues can follow.
});
test('known zero pre-request budget rejections leave first missing cue bound',()=>{
  const ledger=make(); ledger.calls.push({state:'rejected',charged:0,retryAt:'2099-01-01T00:00:00Z'});
  assert.equal(subtitleReplacementBatch(ledger,video,5),1);assert.throws(()=>subtitleReplacementBatch(ledger,video,6));
});
test('overload has no usage confirmation, truncated capture keeps observed usage and reduces future batch size',()=>{
  assert.equal(make(undefined,{error:{code:'server_is_overloaded'}}).calls[0].replacementReview.reason,'provider_overloaded');
  const ledger=make('subtitle-zh-v1',{status:'incomplete',model:'gpt-5.4-mini',incomplete_details:{reason:'max_output_tokens'},
    usage:{input_tokens:1740,output_tokens:8000}});
  assert.equal(ledger.promptVersion,'subtitle-zh-v1');assert.equal(subtitleReplacementBatch(ledger,video,5),12);
  assert.deepEqual(ledger.calls[0].replacementReview.reportedUsage,{input:1740,output:8000});
});
test('refuse altered calls, second signoff, response requiring reconciliation, and stale ledger version',()=>{
  const ledger=make();const bytes=JSON.stringify(ledger);
  assert.throws(()=>prepareSubtitleReplacement(video,bytes,1,subtitleDigest(bytes),5,'operator',null));
  ledger.calls[0].reservation=0.01;assert.throws(()=>subtitleReplacementBatch(ledger,video,5));
  assert.throws(()=>make(undefined,{status:'completed'}));
  assert.throws(()=>prepareSubtitleReplacement(video,raw(),1,'c'.repeat(64),5,'operator',null));
  assert.throws(()=>subtitleReplacementBatch(JSON.parse(raw()),video,5));
});
