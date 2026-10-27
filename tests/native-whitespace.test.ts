import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeWhitespaceMode,nativeWhitespaceFingerprint,projectNativeWhitespace} from '../lib/kernel/native-whitespace.ts';
import type {NativePdfReadingObservation} from '../lib/local-ocr.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),source=sha('immutable PDF bytes');
const block='This independently observed paragraph states that model A uses the same training material as model B. Its source is not an alias dictionary.';
const fused=block.replace('that model','thatmodel').replace('Its source','Itssource');
const page=(text:string,pageNumber=1)=>({text,pageNumber,locator:`page ${pageNumber}`});
const observation=(rawOutput:string):NativePdfReadingObservation=>({sourceHash:source,engine:'poppler-pdftotext',engineVersion:'pdftotext version 22.12.0',options:['-enc','UTF-8'],rawOutput,rawOutputSha256:sha(rawOutput)});

test('whitespace projection defaults off and rejects unknown policy',()=>{
 const old=process.env.DOCLING_NATIVE_WHITESPACE;
 try{delete process.env.DOCLING_NATIVE_WHITESPACE;assert.equal(nativeWhitespaceMode(),'off');
  process.env.DOCLING_NATIVE_WHITESPACE='source-v1';assert.equal(nativeWhitespaceMode(),'source-v1');
  process.env.DOCLING_NATIVE_WHITESPACE='repair';assert.throws(nativeWhitespaceMode,/Invalid/);
 }finally{if(old===undefined)delete process.env.DOCLING_NATIVE_WHITESPACE;else process.env.DOCLING_NATIVE_WHITESPACE=old;}
});
test('unique exact characters use observed whitespace with replayable UTF16 ranges and immutable inputs',()=>{
 const original='😀 Short heading\n\n'+fused,observed='😀 Short heading\n\n'+block.replace('material as','material\nas');
 const input=[page(original)],raw=observation(observed+'\n\f'),before=structuredClone({input,raw});
 const result=projectNativeWhitespace(source,input,raw);
 assert.equal(result.status,'projected');assert.equal(result.changedBlocks,1);assert.equal(result.pages[0].text,observed);
 assert.deepEqual({input,raw},before);assert.deepEqual(projectNativeWhitespace(source,input,raw),result);
 const receipt=result.receipt!,record=receipt.pages[0],edit=record.edits[0];
 const from=original.slice(...edit.originalRangeUtf16),to=result.pages[0].text.slice(...edit.projectedRangeUtf16);
 assert.equal(from,fused);assert.equal(to,observed.slice(observed.indexOf(block.slice(0,20))));
 assert.equal(observed.slice(...edit.nativeRangeUtf16),to);
 assert.equal(sha(from),edit.originalSha256);assert.equal(sha(to),edit.projectedSha256);
 assert.equal(sha(to.replace(/\s/gu,'')),edit.nonWhitespaceSha256);
 assert.equal(record.regionMapping,'whole-page-only-block-geometry-unknown');
 assert.equal(receipt.fidelityVerified,false);assert.equal(receipt.structureRelationsVerified,false);
 assert.equal(receipt.semanticAliasesVerified,false);assert.equal(receipt.originalPdfUnmodified,true);
});
test('character, case, punctuation, number and Unicode disagreements are never repaired',()=>{
 for(const native of [block.replace('model A','Model A'),block.replace('material','materials'),block.replace('B.','B!'),block.replace('model B','model B17'),block.replace('paragraph','parágraph')]){
  const result=projectNativeWhitespace(source,[page(fused)],observation(native+'\f'));
  assert.equal(result.status,'unchanged');assert.equal(result.pages[0].text,fused);
  assert.equal(result.receipt!.pages[0].omitted['non-whitespace-disagreement'],1);
 }
 const unicode=block+' café';
 assert.equal(projectNativeWhitespace(source,[page(unicode)],observation(unicode.normalize('NFD')+'\f')).status,'unchanged');
});
test('duplicate native or decoded matches and short blocks stay unchanged',()=>{
 for(const [decoded,native,reason] of [[fused,block+'\n\n'+block,'ambiguous-native-block'],
  [fused+'\n\n'+fused,block,'ambiguous-decoded-block'],['tinyfused','tiny fused','short-block']]){
  const result=projectNativeWhitespace(source,[page(decoded)],observation(native+'\f'));
  assert.equal(result.pages[0].text,decoded);assert.equal(result.changedBlocks,0);
  assert.ok(result.receipt!.pages[0].omitted[reason]);
 }
});
test('original hash, native hash and page manifest are required; missing and oversized observations do not mutate',()=>{
 const input=[page(fused)],valid=observation(block+'\f');
 assert.throws(()=>projectNativeWhitespace('0'.repeat(64),input,valid),/source or observation/);
 assert.throws(()=>projectNativeWhitespace(source,input,{...valid,rawOutput:block+'wrong'}),/source or observation/);
 assert.throws(()=>projectNativeWhitespace(source,[page(fused,2)],valid),/manifest/);
 assert.throws(()=>projectNativeWhitespace(source,input,observation(block+'\fextra\f')),/manifest/);
 for(const [pages,raw,reason] of [[input,null,'native-observation-unavailable'],
  [[page('x'.repeat(8*1024*1024+1))],valid,'observation-capacity'],
  [[page(Array(10002).fill(fused).join('\n\n'))],valid,'block-capacity']] as const){
  const result=projectNativeWhitespace(source,[...pages],raw);
  assert.equal(result.status,'unavailable');assert.equal(result.reason,reason);assert.deepEqual(result.pages,pages);
 }
});
test('blank pages retain their physical positions and whitespace is never moved across pages',()=>{
 const result=projectNativeWhitespace(source,[page(fused),page('',2),page(fused,3)],observation(block+'\f\f'+block+'\f'));
 assert.deepEqual(result.pages.map(p=>p.text),[block,'',block]);assert.equal(result.changedBlocks,2);
 assert.deepEqual(result.receipt!.pages.map(p=>p.pageNumber),[1,2,3]);
 const cross=projectNativeWhitespace(source,[page(fused),page(block,2)],observation('different\f'+block+'\f'));
 assert.equal(cross.pages[0].text,fused);assert.equal(cross.receipt!.pages[0].edits.length,0);
});
test('stable native provenance distinguishes observations without hashing transient batch metadata',()=>{
 const metadata={policy:'source-observed-whitespace-v1',status:'projected',changedBlocks:1,receiptHash:'a'.repeat(64)};
 assert.equal(nativeWhitespaceFingerprint(undefined),undefined);
 assert.deepEqual(nativeWhitespaceFingerprint({nativeWhitespace:metadata,task_id:'transient'}),metadata);
 assert.deepEqual(nativeWhitespaceFingerprint({nativeWhitespace:{...metadata},other:'different'}),metadata);
 assert.notDeepEqual(nativeWhitespaceFingerprint({nativeWhitespace:{...metadata,receiptHash:'b'.repeat(64)}}),metadata);
 assert.throws(()=>nativeWhitespaceFingerprint({nativeWhitespace:{...metadata,status:'unchanged'}}),/receipt/);
 assert.throws(()=>nativeWhitespaceFingerprint({nativeWhitespace:{...metadata,receiptHash:'invalid'}}),/receipt/);
});
