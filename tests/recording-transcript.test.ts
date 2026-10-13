import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {parseSubtitles,prepareRecordingTranscript} from '../lib/kernel/recording-transcript.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';

test('subtitle timing is preserved across SRT, WebVTT and TTML; malformed timing fails',()=>{
  assert.deepEqual(parseSubtitles('1\n00:02:03,125 --> 00:02:07,250\n<b>Eigenvectors</b> &amp; matrices\n','srt'),
    [{startMs:123125,endMs:127250,text:'Eigenvectors & matrices'}]);
  assert.deepEqual(parseSubtitles('WEBVTT\n\nNOTE ignore\ntext\n\na\n02:03.125 --> 02:07.250 align:start\nEigenvectors\n','vtt'),
    [{startMs:123125,endMs:127250,text:'Eigenvectors'}]);
  assert.deepEqual(parseSubtitles('<tt><body><p begin="1.25s" dur="2s">A<br/>B</p></body></tt>','ttml'),
    [{startMs:1250,endMs:3250,text:'A\nB'}]);
  assert.throws(()=>parseSubtitles('1\n00:00:05,000 --> 00:00:04,000\nInvalid','srt'),/Invalid/);
  assert.throws(()=>parseSubtitles('WEBVTT\n\n00:61.000 --> 00:62.000\nInvalid','vtt'),/Invalid/);
});

test('recording identity is deterministic and refuses credential-bearing source URLs',()=>{
  const input={ownerId:'owner',partnerId:'123',entryId:'0_example',captionId:'1_caption',language:'en',title:'Lecture',
    sourceUrl:'https://q.utoronto.ca/courses/1/external_tools/2',subtitleHash:'a'.repeat(64),acquiredAt:'2026-10-13T00:00:00Z',
    method:'platform-caption' as const,cues:[{startMs:1250,endMs:3250,text:'spectral estimator'}]};
  assert.equal(prepareRecordingTranscript(input).document.id,prepareRecordingTranscript(input).document.id);
  assert.match(prepareRecordingTranscript(input).pages[0].locator,/00:00:01.250–00:00:03.250/);
  assert.throws(()=>prepareRecordingTranscript({...input,sourceUrl:input.sourceUrl+'?ks=secret'}),/credentials/);
  assert.throws(()=>prepareRecordingTranscript({...input,ownerId:''}),/identity/);
});

test('recording evidence is atomically indexed, repeatable, owner-scoped and uses actual time offsets',async()=>{
  await migrateKernel();
  const owner=`recording-${randomUUID()}`;
  const input={ownerId:owner,partnerId:'123',entryId:'0_example',captionId:'1_caption',language:'en',title:'Lecture',
    sourceUrl:'https://q.utoronto.ca/courses/1/external_tools/2',subtitleHash:createHash('sha256').update(owner).digest('hex'),
    acquiredAt:'2026-10-13T00:00:00Z',method:'platform-caption' as const,
    cues:[{startMs:1250,endMs:3250,text:'The spectral zephyr estimator is unbiased.'}]};
  const first=await kernel.ingestRecordingTranscript(input);
  await kernel.ingestRecordingTranscript(input);
  const hits=await kernel.searchDocumentText(owner,'spectral zephyr');
  assert.equal(hits[0].document_id,first.documentId);
  assert.equal(hits[0].content_kind,'time_segment');
  assert.equal(hits[0].start_ms,1250);
  assert.equal(hits[0].end_ms,3250);
  assert.ok(hits[0].evidence_id);
  assert.equal((await kernel.searchDocumentText('other','spectral zephyr')).length,0);
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM document_text_versions WHERE document_id=$1',[first.documentId])).rows[0].count),1);
  await assert.rejects(kernel.ingestRecordingTranscript({...input,cues:[{startMs:-1,endMs:1000,text:'bad'}]}),/Invalid/);
  assert.equal((await kernel.searchDocumentText(owner,'spectral zephyr'))[0].start_ms,1250);
});
