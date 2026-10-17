import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {sourcePageRegionsFixture,fixtureSha} from './fixtures/source-page-regions.ts';
import {prepareDoclingOrigSearchHints,assertPreparedDoclingOrigSearchHints,doclingOrigSearchHash,DOCLING_ORIG_SEARCH_LIMITS,
 type OrigSearchInput} from '../lib/kernel/docling-source-regions.ts';
import {projectDocumentOrigSearch,documentSearchText,documentOrigSearchMetadata} from '../lib/kernel/document-search.ts';

const root=resolve('data');await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,'orig-search-test-'));
const oldRoot=process.env.LIBRARY_DIR;process.env.LIBRARY_DIR=directory;
after(async()=>{if(oldRoot===undefined)delete process.env.LIBRARY_DIR;else process.env.LIBRARY_DIR=oldRoot;
 assert.ok(relative(root,directory).startsWith('orig-search-test-'));await rm(directory,{recursive:true,force:true});});
async function inputWithOrig(orig='Previously absent retrieval needle'){
 const f=sourcePageRegionsFixture(),result=structuredClone(f.result);result.document.json_content.texts[1].orig=orig;
 const raw=Buffer.from(JSON.stringify({identity:f.identity,result})),hash=fixtureSha(raw);
 await writeFile(join(directory,hash),raw);
 const progress={...f.progress,batches:[{...f.progress.batches[0],resultHash:hash}]};
 const input:OrigSearchInput={owner:f.owner,documentId:f.source.documentId,sourceHash:f.source.sourceHash,pageCount:1,physicalPage:1,
  body:f.body,parserVersion:'synthetic-orig-search-v1',progress};
 return {f,input,raw,hash};
}

test('orig hints bind registered CAS and body without becoming evidence; projection and rebuild are independently idempotent',async()=>{
 const {f,input}=await inputWithOrig(),before=f.body,hints=await prepareDoclingOrigSearchHints(input);assert.ok(hints);
 assertPreparedDoclingOrigSearchHints(hints,input);
 assert.deepEqual(hints.entries.find(e=>e.reference==='#/texts/1'),{reference:'#/texts/1',orig:'Previously absent retrieval needle'});
 assert.equal(hints.visibilityVerified,false);assert.equal(hints.semanticRelationsVerified,false);assert.equal(hints.textFaithfulnessVerified,false);
 const binding={...hints.source,currentVersionId:f.source.currentVersionId,sourceVersionId:f.source.sourceVersionId,
  evidenceId:f.evidenceId,parserVersion:input.parserVersion},base=documentSearchText(input.body);
 const first=projectDocumentOrigSearch(input.body,base,null,hints,binding);assert.ok(first.provenance);
 assert.match(first.searchText,/previously absent retrieval needle/);assert.equal(f.body,before);
 assert.deepEqual(projectDocumentOrigSearch(input.body,first.searchText,first.provenance,hints,binding),first);
 // A reconstruction uses body + freshly staged raw, never a base snapshot.
 const fresh=await prepareDoclingOrigSearchHints(input);assert.ok(fresh);
 assert.deepEqual(projectDocumentOrigSearch(input.body,base,null,fresh,binding),first);
 const metadata=documentOrigSearchMetadata(first.provenance,binding,fixtureSha(input.body),fixtureSha(first.searchText));
 assert.equal(metadata.authority,'unverified-retrieval-hint');assert.equal(JSON.stringify(metadata).includes('Previously absent'),false);
 assert.throws(()=>projectDocumentOrigSearch(input.body,first.searchText+' extra',first.provenance,hints,binding),/previous index/);
 assert.throws(()=>projectDocumentOrigSearch(input.body,base+' unknown-native-addition',null,hints,binding),/Unknown existing/);
 assert.throws(()=>projectDocumentOrigSearch(input.body,first.searchText,first.provenance,null,binding),/unavailable/);
 assert.throws(()=>documentOrigSearchMetadata(first.provenance,{...binding,currentVersionId:'stale'},fixtureSha(input.body),fixtureSha(first.searchText)),/binding/);
 assert.throws(()=>documentOrigSearchMetadata(first.provenance,binding,fixtureSha('wrong body'),fixtureSha(first.searchText)),/provenance/);
 assert.throws(()=>documentOrigSearchMetadata(first.provenance,binding,fixtureSha(input.body),fixtureSha('wrong index')),/index checksum/);
});

test('orig staging rejects fabricated/current drift, missing or changed CAS and whole-page limits; no registered ref leaves ordinary projection unchanged',async()=>{
 const {input,hash}=await inputWithOrig(),prepared=await prepareDoclingOrigSearchHints(input);assert.ok(prepared);
 assert.throws(()=>assertPreparedDoclingOrigSearchHints(structuredClone(prepared),input),/staging/);
 assert.throws(()=>assertPreparedDoclingOrigSearchHints(prepared,{...input,body:input.body+' drift'}),/staging/);
 assert.throws(()=>assertPreparedDoclingOrigSearchHints(prepared,{...input,progress:{...input.progress as object,extra:'changed'}}),/staging/);
 await assert.rejects(prepareDoclingOrigSearchHints({...input,owner:'foreign'}),/source differs/);
 await writeFile(join(directory,hash),'changed CAS');await assert.rejects(prepareDoclingOrigSearchHints(input),/checksum/);
 const absent=await inputWithOrig('absent');await rm(join(directory,absent.hash));
 await assert.rejects(prepareDoclingOrigSearchHints(absent.input),/unavailable/);
 const excessive=await inputWithOrig('x'.repeat(DOCLING_ORIG_SEARCH_LIMITS.textBytes+1));
 await assert.rejects(prepareDoclingOrigSearchHints(excessive.input),/complete page limit/);
 const none={...input,progress:null};assert.equal(await prepareDoclingOrigSearchHints(none),null);
 const binding={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,pageCount:1,physicalPage:1,
  currentVersionId:'v',sourceVersionId:'s',evidenceId:'e',parserVersion:input.parserVersion};
 const ordinary=projectDocumentOrigSearch(input.body,documentSearchText(input.body),null,null,binding);
 assert.deepEqual(ordinary,{searchText:documentSearchText(input.body),provenance:null});
 assert.equal(doclingOrigSearchHash({b:2,a:1}),doclingOrigSearchHash({a:1,b:2}));
});

test('an empty disposable index rebuilds only without old provenance; registered or unknown nonempty indexes stay strict',async()=>{
 const {f,input}=await inputWithOrig(),hints=await prepareDoclingOrigSearchHints(input);assert.ok(hints);
 const binding={...hints.source,currentVersionId:f.source.currentVersionId,sourceVersionId:f.source.sourceVersionId,
  evidenceId:f.evidenceId,parserVersion:input.parserVersion},base=documentSearchText(input.body),before=input.body;
 assert.deepEqual(projectDocumentOrigSearch(input.body,'',null,null,binding),{searchText:base,provenance:null});
 const expected=projectDocumentOrigSearch(input.body,base,null,hints,binding);
 assert.deepEqual(projectDocumentOrigSearch(input.body,'',null,hints,binding),expected);
 assert.ok(expected.provenance);assert.equal(input.body,before);
 assert.throws(()=>projectDocumentOrigSearch(input.body,'unregistered extra content',null,hints,binding),/Unknown existing/);
 assert.throws(()=>projectDocumentOrigSearch(input.body,'',expected.provenance,hints,binding),/previous index/);
});

test('orig progress binding ignores only batch taskId while keeping every other registered field strict',async()=>{
 const {input}=await inputWithOrig(),base=input.progress as ReturnType<typeof sourcePageRegionsFixture>['progress'];
 const progress={...base,taskId:'root-field-remains-bound',batches:[{...base.batches[0],taskId:'first-runtime-id',
  other:{taskId:'nested-field-remains-bound'}}]};
 const firstInput={...input,progress},before=JSON.stringify(firstInput),first=await prepareDoclingOrigSearchHints(firstInput);assert.ok(first);
 const changedTask={...progress,batches:[{...progress.batches[0],taskId:'second-runtime-id'}]};
 assert.doesNotThrow(()=>assertPreparedDoclingOrigSearchHints(first,{...input,progress:changedTask}));
 const second=await prepareDoclingOrigSearchHints({...input,progress:changedTask});assert.deepEqual(second,first);
 assert.equal(JSON.stringify(firstInput),before,'preparation must not mutate original registered progress');
 const variants=[{...progress,schema:2},{...progress,identity:{...progress.identity,optionsHash:fixtureSha('other options')}},
  {...progress,batchSize:2},{...progress,taskId:'root-field-changed'},{...progress,extra:'new-field'},
  ...[{start:2},{end:2},{inputHash:fixtureSha('other input')},{copyIndices:[1]},{resultHash:fixtureSha('other raw')},
   {other:{taskId:'nested-field-changed'}},{completedAt:'new-runtime-field-still-bound'}]
   .map(delta=>({...progress,batches:[{...progress.batches[0],...delta}]}))];
 for(const changed of variants)assert.throws(()=>assertPreparedDoclingOrigSearchHints(first,{...input,progress:changed}));
});
