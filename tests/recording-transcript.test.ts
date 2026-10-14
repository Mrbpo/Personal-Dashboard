import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {parseSubtitles,prepareRecordingTranscript} from '../lib/kernel/recording-transcript.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {recordingCaptionInput} from '../lib/kernel/recording-caption-import.ts';
import type {ASRProvenance} from '../lib/kernel/recording-asr-provenance.ts';

const asrProof=(subtitleSha256:string,model='cpu-small'):ASRProvenance=>({schemaVersion:1,method:'local-asr',model,
  modelRevision:'d1d751a5f8271d482d14ca55d9e2deeebbae577f',modelSha256:'b'.repeat(64),sourceVideoSha256:'a'.repeat(64),
  sourceAudioSha256:'c'.repeat(64),subtitleSha256,clipStartMs:0,clipEndMs:5000,
  timestampBasis:'source-absolute',computeType:'int8',language:'en'});

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
  assert.throws(()=>prepareRecordingTranscript({...input,method:'local-asr',model:'cpu-small'}),/ASR provenance/);
  const proof=asrProof(input.subtitleHash);
  assert.throws(()=>prepareRecordingTranscript({...input,asr:proof}),/explicit local-asr/);
  assert.throws(()=>prepareRecordingTranscript({...input,method:'local-asr',model:'different',asr:proof}),/ASR provenance/);
  assert.throws(()=>prepareRecordingTranscript({...input,method:'local-asr',model:proof.model,
    asr:{...proof,clipStartMs:600000,clipEndMs:900000,timestampBasis:'clip-relative'}}),/outside declared source window/);
  const prepared=prepareRecordingTranscript({...input,method:'local-asr',model:proof.model,asr:proof});
  assert.equal(prepared.pages[0].startMs,1250,'kernel accepts only absolute times and never applies an offset');
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
  const head=async()=>(await kernelPool().query(`SELECT v.id,v.source_version_id,p.evidence_id,e.confidence
    FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
    JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=1
    JOIN evidence e ON e.id=p.evidence_id WHERE d.id=$1`,[first.documentId])).rows[0];
  const platform=await head();
  await assert.rejects(kernel.ingestRecordingTranscript({...input,method:'local-asr',model:'cpu-small'}),/ASR provenance/);
  const asr={...input,method:'local-asr' as const,model:'cpu-small',asr:asrProof(input.subtitleHash)};
  const medium={...asr,model:'cpu-medium',asr:{...asr.asr,model:'cpu-medium'}};
  await kernel.ingestRecordingTranscript(asr);
  const oldModel=await head();
  await kernel.ingestRecordingTranscript(medium);
  const current=await head();
  assert.notEqual(current.id,oldModel.id,'same subtitle bytes and method with a different model creates a new version');
  assert.notEqual(current.source_version_id,oldModel.source_version_id);
  assert.notEqual(current.evidence_id,oldModel.evidence_id);
  const history=(await kernelPool().query(`SELECT v.id,s.raw_value AS raw,e.confidence FROM document_text_versions v
    JOIN source_item_versions s ON s.id=v.source_version_id
    JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=1 JOIN evidence e ON e.id=p.evidence_id
    WHERE v.document_id=$1`,[first.documentId])).rows;
  assert.equal(history.length,3);
  assert.equal(history.find(row=>row.id===oldModel.id).raw.recording.model,'cpu-small');
  assert.equal(history.find(row=>row.id===current.id).raw.recording.model,'cpu-medium');
  assert.equal(Number(history.find(row=>row.id===platform.id).confidence),0.8);
  assert.equal(Number(current.confidence),0.6);
  await kernel.ingestRecordingTranscript({...medium,acquiredAt:'2026-10-14T00:00:00Z'});
  assert.equal((await head()).id,current.id,'a replay with a new acquisition time is idempotent');
  assert.equal(Number((await kernelPool().query('SELECT count(*) FROM document_text_versions WHERE document_id=$1',[first.documentId])).rows[0].count),3);
  assert.equal((await kernel.searchDocumentText(owner,'spectral zephyr'))[0].evidence_id,current.evidence_id);
  const {searchLibrary}=await import('../lib/library.ts');
  const {database}=await import('../lib/database.ts');
  const search=()=>searchLibrary(owner,'spectral zephyr','',false,{kernelSemantic:false,aiRerank:false,hybrid:false});
  const libraryHit=(await search())[0];
  assert.equal(libraryHit.document_id,first.documentId);
  assert.equal(libraryHit.evidence_id,current.evidence_id);
  assert.equal(libraryHit.content_kind,'time_segment');
  assert.equal(libraryHit.start_ms,1250);assert.equal(libraryHit.end_ms,3250);
  assert.match(libraryHit.locator,/00:00:01.250–00:00:03.250/);
  assert.equal((await searchLibrary('other','spectral zephyr','',false,{kernelSemantic:false,aiRerank:false,hybrid:false})).length,0);
  assert.equal((await searchLibrary(owner,'spectral zephyr','other-course',false,{kernelSemantic:false,aiRerank:false,hybrid:false})).length,0);
  assert.equal((await searchLibrary(owner,'spectral zephyr','',false,{strict:true,path:'legacy-folder'})).length,0);
  const document=prepareRecordingTranscript(input).document;
  await database.prepare(`INSERT INTO library_documents(id,owner_id,course_id,origin,origin_key,folder_path,name,mime,hash,size,status,created_at,deleted)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(first.documentId,owner,'',document.origin,document.originKey,'legacy-folder',
      document.name,document.mime,document.hash,1,'ready',input.acquiredAt,0).run();
  assert.equal((await search())[0].evidence_id,current.evidence_id,'matching compatibility row retains canonical evidence');
  for(const [field,value] of [['deleted',1],['owner_id','other'],['hash','stale'],['status','pending']] as const){
    await database.prepare(`UPDATE library_documents SET ${field}=? WHERE id=?`).bind(value,first.documentId).run();
    assert.equal((await search()).length,0,`existing compatibility ${field} cannot be bypassed as PG-only`);
    await database.prepare('UPDATE library_documents SET deleted=0,owner_id=?,hash=?,status=? WHERE id=?')
      .bind(owner,document.hash,'ready',first.documentId).run();
  }
  assert.equal((await searchLibrary(owner,'spectral zephyr','',false,{strict:true,path:'different-folder'})).length,0);
  await database.prepare('DELETE FROM library_documents WHERE id=?').bind(first.documentId).run();
  await assert.rejects(kernel.ingestRecordingTranscript({...input,cues:[{startMs:-1,endMs:1000,text:'bad'}]}),/Invalid/);
  assert.equal((await kernel.searchDocumentText(owner,'spectral zephyr'))[0].start_ms,1250);
  const sampleBytes=Buffer.from('WEBVTT\n\n00:01.250 --> 00:03.250\nThe offset zephyr transcript cites a guide RNA.\n');
  const sampleHash=createHash('sha256').update(sampleBytes).digest('hex');
  const sampleFile={kind:'caption',path:'sample.vtt',captionId:'asr_sample',language:'en',format:'vtt' as const,
    method:'local-asr' as const,sha256:sampleHash};
  const sampleRecord={courseId:'1',partnerId:'123',entryId:'0_example',title:'Lecture',sourceUrl:input.sourceUrl,
    durationSeconds:1200,seenAt:Date.parse(input.acquiredAt)/1000,files:[{kind:'video',sha256:'a'.repeat(64)}]};
  const sampleProof={schemaVersion:1,method:'local-asr',model:'Systran/faster-whisper-small.en',
    modelRevision:'d1d751a5f8271d482d14ca55d9e2deeebbae577f',modelSha256:'b'.repeat(64),sourceVideoSha256:'a'.repeat(64),
    sourceAudioSha256:'c'.repeat(64),subtitleSha256:sampleHash,clipStartMs:600000,clipEndMs:900000,
    timestampBasis:'clip-relative',computeType:'int8',language:'en'};
  const sample=recordingCaptionInput(sampleRecord,sampleFile,sampleBytes,owner+'-sample',undefined,sampleProof);
  const sampleResult=await kernel.ingestRecordingTranscript(sample);
  const sampleHit=(await searchLibrary(sample.ownerId,'offset zephyr','',false,
    {kernelSemantic:false,aiRerank:false,hybrid:false}))[0];
  assert.equal(sampleHit.document_id,sampleResult.documentId);assert.ok(sampleHit.evidence_id);
  assert.equal(sampleHit.start_ms,601250);assert.equal(sampleHit.end_ms,603250);
  assert.match(sampleHit.locator,/00:10:01.250–00:10:03.250/);
  await kernel.ingestRecordingTranscript(recordingCaptionInput(sampleRecord,sampleFile,sampleBytes,sample.ownerId,undefined,
    {...sampleProof,modelRevision:'e'.repeat(40),modelSha256:'f'.repeat(64)}));
  const sampleHistory=(await kernelPool().query(`SELECT s.raw_value AS raw FROM document_text_versions v
    JOIN source_item_versions s ON s.id=v.source_version_id WHERE v.document_id=$1`,[sampleResult.documentId])).rows;
  assert.equal(sampleHistory.length,2,'changing a pinned ASR model revision retains source history even when the VTT body is unchanged');
  assert.deepEqual(new Set(sampleHistory.map(row=>row.raw.recording.asr.modelRevision)),new Set([sampleProof.modelRevision,'e'.repeat(40)]));
});
