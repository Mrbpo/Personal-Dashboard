import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSubtitleBundle,subtitleMetadata,renderSubtitleVtt,SUBTITLE_TRANSLATION_DAILY_LIMIT,type SubtitleBundle} from '../lib/recording-subtitles.ts';
test('subtitle translation daily request allowance is 20000, not a monetary limit',()=>{
 assert.equal(SUBTITLE_TRANSLATION_DAILY_LIMIT,20000);
});
const hash='a'.repeat(64);
function bundle():SubtitleBundle{return {schemaVersion:1,videoSha256:hash,source:{subtitleSha256:'b'.repeat(64),method:'platform-caption',model:null,
 clipStartMs:600000,clipEndMs:900000,timestampBasis:'source-absolute'},translation:{model:'gpt-5.4-mini',promptVersion:'subtitle-zh-v1'},
 cues:[{startMs:600430,endMs:602430,en:'DNA does not change <script> & 2.',zh:'DNA 不会改变 <script> & 2。'}]};}
test('bilingual rendering keeps exact original-video timing and escapes subtitle markup',()=>{
 const value=validateSubtitleBundle(bundle(),hash,3055),vtt=renderSubtitleVtt(value,'bilingual');
 assert.match(vtt,/00:10:00\.430 --> 00:10:02\.430/);assert.match(vtt,/DNA does not change &lt;script&gt; &amp; 2\./);
 assert.match(vtt,/DNA 不会改变 &lt;script&gt; &amp; 2。/);assert.equal(vtt.includes('<script>'),false);
 assert.equal(subtitleMetadata(value,3055).partial,true);assert.deepEqual(subtitleMetadata(value,3055).modes,['en','zh','bilingual']);
});
test('missing Chinese remains English-only; no partial translation masquerades as complete',()=>{
 const value=bundle();value.cues[0].zh=null;value.translation=null;
 const metadata=subtitleMetadata(value,3055);
 assert.deepEqual(metadata.modes,['en','bilingual']);assert.equal(metadata.translated,false);assert.equal(metadata.translatedCues,0);
 assert.equal(renderSubtitleVtt(value,'bilingual'),renderSubtitleVtt(value,'en'));
 assert.doesNotMatch(renderSubtitleVtt(value,'zh'),/-->/);
 assert.deepEqual(subtitleMetadata(null,3055).modes,[]);
});
test('partial Chinese stays on each translated original cue; bilingual keeps the English gaps',()=>{
 const value=bundle();
 value.cues=[
  {startMs:600000,endMs:602000,en:'English before',zh:null},
  {startMs:603000,endMs:604250,en:'English middle',zh:'中间的真实译文'},
  {startMs:605000,endMs:606000,en:'English after',zh:null},
 ];
 const metadata=subtitleMetadata(validateSubtitleBundle(value,hash,3055),3055);
 assert.deepEqual(metadata.modes,['en','zh','bilingual']);
 assert.deepEqual([metadata.translatedCues,metadata.totalCues,metadata.translated],[1,3,false]);
 const bilingual=renderSubtitleVtt(value,'bilingual'),zh=renderSubtitleVtt(value,'zh');
 assert.match(bilingual,/English before\n\n2\n/);assert.match(bilingual,/English middle\n中间的真实译文/);
 assert.match(bilingual,/English after\n$/);assert.doesNotMatch(bilingual,/null|undefined/);
 assert.equal(zh,'WEBVTT\n\n1\n00:10:03.000 --> 00:10:04.250\n中间的真实译文\n');
});
test('rejects wrong video versions, out-of-window cues and unproven ASR sources',()=>{
 assert.throws(()=>validateSubtitleBundle(bundle(),'c'.repeat(64),3055),/不匹配/);
 const value=bundle();value.cues[0].startMs=0;assert.throws(()=>validateSubtitleBundle(value,hash,3055),/时间轴/);
 const asr=bundle();asr.source.method='local-asr';assert.throws(()=>validateSubtitleBundle(asr,hash,3055),/ASR provenance/);
});

test('word-pause-v2 requires isolated translation identity and renders preserved cue times',()=>{
 const value=bundle();value.source.method='local-asr';value.source.model='small.en';
 value.source.asr={schemaVersion:1,method:'local-asr',model:'small.en',modelRevision:'a'.repeat(40),modelSha256:'b'.repeat(64),
  sourceVideoSha256:hash,sourceAudioSha256:'c'.repeat(64),subtitleSha256:value.source.subtitleSha256,
  clipStartMs:600000,clipEndMs:900000,timestampBasis:'source-absolute',computeType:'int8',language:'en',
  timingProfile:'word-pause-v2',wordEvidenceSha256:'d'.repeat(64),
  timingConfig:{maxCueSeconds:7,maxCueWords:14,pauseSeconds:0.65,minDisplaySeconds:1}};
 assert.throws(()=>validateSubtitleBundle(value,hash,3055),/翻译版本/);
 value.translation!.promptVersion='subtitle-zh-v2';
 assert.match(renderSubtitleVtt(validateSubtitleBundle(value,hash,3055),'bilingual'),/00:10:00\.430 --> 00:10:02\.430/);
});
