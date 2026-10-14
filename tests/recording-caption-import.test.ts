import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {recordingCaptionInput,type ASRProvenance,type CaptionFile} from '../lib/kernel/recording-caption-import.ts';

const bytes=Buffer.from('WEBVTT\n\n00:01.250 --> 00:03.250\nDNA editing requires a guide RNA.\n');
const file:CaptionFile={kind:'caption',path:'sample.vtt',captionId:'asr_sample',language:'en',format:'vtt',
  sha256:createHash('sha256').update(bytes).digest('hex'),method:'local-asr'};
const record={courseId:'1',partnerId:123,entryId:'0_example',title:'Lecture',
  sourceUrl:'https://q.utoronto.ca/courses/1/external_tools/2',durationSeconds:1200,seenAt:1791946003,
  files:[{kind:'video',sha256:'a'.repeat(64)}]};
const provenance:ASRProvenance={schemaVersion:1,method:'local-asr',model:'Systran/faster-whisper-small.en',
  modelRevision:'d1d751a5f8271d482d14ca55d9e2deeebbae577f',modelSha256:'b'.repeat(64),
  sourceVideoSha256:'a'.repeat(64),sourceAudioSha256:'c'.repeat(64),subtitleSha256:file.sha256,
  clipStartMs:600000,clipEndMs:900000,timestampBasis:'clip-relative',computeType:'int8',language:'en'};

test('ASR import binds original/model hashes and shifts clip timing exactly once',()=>{
  const input=recordingCaptionInput(record,file,bytes,'owner','course',provenance);
  assert.equal(input.method,'local-asr');assert.equal(input.model,provenance.model);
  assert.deepEqual(input.cues,[{startMs:601250,endMs:603250,text:'DNA editing requires a guide RNA.'}]);
  assert.equal(input.asr?.sourceVideoSha256,record.files[0].sha256);
  const absolute=Buffer.from(bytes.toString().replace('00:01.250 --> 00:03.250','10:01.250 --> 10:03.250'));
  const hash=createHash('sha256').update(absolute).digest('hex');
  assert.deepEqual(recordingCaptionInput(record,{...file,sha256:hash},absolute,'owner','course',
    {...provenance,subtitleSha256:hash,timestampBasis:'source-absolute'}).cues,input.cues);
  assert.throws(()=>recordingCaptionInput(record,{...file,sha256:hash},absolute,'owner','course',
    {...provenance,subtitleSha256:hash}),/outside declared source window/);
});

test('ASR cannot masquerade as platform captions or omit original/model identity',()=>{
  assert.throws(()=>recordingCaptionInput(record,{...file,method:undefined},bytes,'owner','course',provenance),/explicit local-asr/);
  assert.throws(()=>recordingCaptionInput(record,file,bytes,'owner','course'),/ASR provenance/);
  assert.throws(()=>recordingCaptionInput(record,file,bytes,'owner','course',{...provenance,modelRevision:'main'}),/ASR provenance/);
  assert.throws(()=>recordingCaptionInput(record,file,bytes,'owner','course',{...provenance,sourceVideoSha256:'d'.repeat(64)}),/identity mismatch/);
  const legacy=recordingCaptionInput(record,{...file,method:undefined},bytes,'owner','course');
  assert.equal(legacy.method,'platform-caption');assert.equal(legacy.cues[0].startMs,1250);assert.equal(legacy.asr,undefined);
});
