import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSubtitleBundle,subtitleMetadata,renderSubtitleVtt,type SubtitleBundle} from '../lib/recording-subtitles.ts';
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
 assert.deepEqual(subtitleMetadata(value,3055).modes,['en']);assert.throws(()=>renderSubtitleVtt(value,'bilingual'),/尚未完整/);
 assert.deepEqual(subtitleMetadata(null,3055).modes,[]);
});
test('rejects wrong video versions, out-of-window cues and unproven ASR sources',()=>{
 assert.throws(()=>validateSubtitleBundle(bundle(),'c'.repeat(64),3055),/不匹配/);
 const value=bundle();value.cues[0].startMs=0;assert.throws(()=>validateSubtitleBundle(value,hash,3055),/时间轴/);
 const asr=bundle();asr.source.method='local-asr';assert.throws(()=>validateSubtitleBundle(asr,hash,3055),/ASR provenance/);
});
