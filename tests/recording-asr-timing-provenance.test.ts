import test from 'node:test';
import assert from 'node:assert/strict';
import {validateASRProvenance,type ASRProvenance} from '../lib/kernel/recording-asr-provenance.ts';

const legacy:ASRProvenance={schemaVersion:1,method:'local-asr',model:'small.en',modelRevision:'a'.repeat(40),
  modelSha256:'b'.repeat(64),sourceVideoSha256:'c'.repeat(64),sourceAudioSha256:'d'.repeat(64),
  subtitleSha256:'e'.repeat(64),clipStartMs:1000000,clipEndMs:1120000,
  timestampBasis:'source-absolute',computeType:'int8',language:'en'};
const expected={language:'en',subtitleHash:legacy.subtitleSha256};
const timed={...legacy,timingProfile:'word-pause-v1',wordEvidenceSha256:'f'.repeat(64),
  timingConfig:{maxCueSeconds:7,maxCueWords:14,pauseSeconds:0.65}};

test('legacy proof remains compatible; word timing identity survives normalization',()=>{
  assert.deepEqual(validateASRProvenance(legacy,expected),legacy);
  assert.deepEqual(validateASRProvenance(timed,expected),timed);
});

test('partial or unsupported timing proof cannot masquerade as word-aligned provenance',()=>{
  for(const invalid of [
    {...timed,wordEvidenceSha256:undefined},
    {...timed,timingProfile:undefined},
    {...timed,timingConfig:undefined},
    {...timed,wordEvidenceSha256:'unverified'},
    {...timed,timingProfile:'character-proportional'},
    {...timed,timingConfig:{...timed.timingConfig,pauseSeconds:2}},
  ]) assert.throws(()=>validateASRProvenance(invalid,expected),/timing provenance/);
});
