import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {spawnSync} from 'node:child_process';
import {publishedStudySourcePreflight,readPublishedStudyArtifact,requireFinalStudySources} from '../scripts/study-source-preflight.mjs';

const blob=(bytes:Buffer)=>createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function fixture(){
 const pdf=Buffer.from('%PDF-1.7\nsource fixture, not a parsing fixture\n'),
  annotations=Buffer.from(JSON.stringify([{doc_id:'paper.pdf',question:'PRIVATE-QUESTION',answer:'PRIVATE-ANSWER'},
   {doc_id:'paper.pdf',question:'another question'},{doc_id:'outside-scope.pdf'}]));
 const bundle={protocol:'publisher-git-pdf-bundle-v1',repository:'https://github.com/publisher/release',commit:'a'.repeat(40),
  annotations:{path:'data/questions.json',gitBlobSha1:blob(annotations)},
  documents:[{documentId:'paper.pdf',path:'data/documents/paper.pdf',gitBlobSha1:blob(pdf),bytes:pdf.length}]};
 const files=new Map([['data/questions.json',annotations],['data/documents/paper.pdf',pdf]]);
 const read=async(path:string)=>{const value=files.get(path);if(!value)throw Error('Missing test artifact');return value;};
 return {bundle,files,read};
}

test('published doc_id binds exact PDF bytes and never emits question/answer content or global coverage',async()=>{
 const f=fixture(),report=await publishedStudySourcePreflight(f.bundle,f.read);
 assert.doesNotThrow(()=>requireFinalStudySources(report));
 assert.deepEqual(report.validatedDocumentIds,['paper.pdf']);assert.equal(report.counts.sources,1);
 assert.equal(report.fullPublisherDatasetValidated,false);assert.equal(report.scope,'listed-document-ids-only');
 assert.equal(report.records[0].rawPdfSha256,createHash('sha256').update(f.files.get('data/documents/paper.pdf')!).digest('hex'));
 assert.equal(report.records[0].contentFidelity,'unassessed');assert.equal(report.records[0].answerCorrectness,'unassessed');
 assert.doesNotMatch(JSON.stringify(report),/PRIVATE-QUESTION|PRIVATE-ANSWER|another question/);
});

test('changed PDF bytes and LFS/HTML replacements cannot pass a pinned artifact binding',async()=>{
 for(const raw of [Buffer.from('%PDF-1.7\nchanged\n'),Buffer.from('version https://git-lfs.github.com/spec/v1')]){
  const f=fixture();f.files.set('data/documents/paper.pdf',raw);
  const report=await publishedStudySourcePreflight(f.bundle,f.read);
  assert.equal(report.counts.mismatched,1);assert.equal(report.finalSourceReady,false);
  assert.throws(()=>requireFinalStudySources(report),/aligned sources/);
 }
});

test('changed annotations do not establish an author association even when the PDF matches',async()=>{
 const f=fixture();f.files.set('data/questions.json',Buffer.from('[{"doc_id":"paper.pdf","answer":"MODIFIED-GOLD"}]'));
 const report=await publishedStudySourcePreflight(f.bundle,f.read);
 assert.equal(report.counts.mismatched,1);assert.deepEqual(report.validatedDocumentIds,[]);
 assert.ok(report.records[0].issues.includes('publisher-annotation-blob-mismatch'));
 assert.doesNotMatch(JSON.stringify(report),/MODIFIED-GOLD/);
});

test('missing or differently spelled doc_id stays unknown without guessing a title or version',async()=>{
 const f=fixture(),raw=Buffer.from('[{"doc_id":"Paper.pdf"}]');
 f.files.set('data/questions.json',raw);f.bundle.annotations.gitBlobSha1=blob(raw);
 const report=await publishedStudySourcePreflight(f.bundle,f.read);
 assert.equal(report.counts.unknown,1);assert.equal(report.finalSourceReady,false);
 assert.ok(report.records[0].issues.includes('publisher-document-id-not-referenced'));
});

test('duplicate identities, invented filename mappings and unsafe paths fail before reading files',async()=>{
 const duplicate=fixture();duplicate.bundle.documents.push({...duplicate.bundle.documents[0]});
 const alias=fixture();alias.bundle.documents[0].documentId='a different title.pdf';
 for(const f of [duplicate,alias])await assert.rejects(()=>publishedStudySourcePreflight(f.bundle,async()=>{throw Error('unexpected read');}),/document identity/);
 for(const path of ['../questions.json','/questions.json','data/../questions.json','C:/questions.json','data\\questions.json']){
  const f=fixture();f.bundle.annotations.path=path;
  await assert.rejects(()=>publishedStudySourcePreflight(f.bundle,async()=>{throw Error('unexpected read');}),/Invalid publisher PDF bundle/);
 }
});

test('malformed published annotations fail without reflecting potentially private contents',async()=>{
 for(const value of ['{"doc_id":"paper.pdf"}','[{"answer":"PRIVATE-ANSWER"}]','PRIVATE-ANSWER invalid json']){
  const f=fixture(),raw=Buffer.from(value);f.files.set('data/questions.json',raw);f.bundle.annotations.gitBlobSha1=blob(raw);
  await assert.rejects(()=>publishedStudySourcePreflight(f.bundle,f.read),error=>{
   assert.ok(error instanceof Error);assert.doesNotMatch(error.message,/PRIVATE-ANSWER/);
   return /annotation/.test(error.message);
  });
 }
});

test('offline CLI gates published files, preserves arXiv unknown and rejects local path escapes',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'study-publisher-')),root=join(directory,'bundle');
 try{
  const f=fixture();await mkdir(join(root,'data/documents'),{recursive:true});
  for(const [path,bytes]of f.files)await writeFile(join(root,path),bytes);
  const manifest=join(directory,'manifest.json');await writeFile(manifest,JSON.stringify(f.bundle));
  const command=['scripts/study-source-preflight.mjs','--publisher-bundle',manifest,'--bundle-root',root,'--final','--output'];
  const output=join(directory,'valid.json'),valid=spawnSync(process.execPath,[...command,output],{encoding:'utf8'});
  assert.equal(valid.status,0,valid.stderr);assert.equal(JSON.parse(await readFile(output,'utf8')).counts.aligned,1);
  await writeFile(join(root,'data/documents/paper.pdf'),'%PDF-1.7 changed');
  const wrong=spawnSync(process.execPath,[...command,join(directory,'changed.json')],{encoding:'utf8'});
  assert.equal(wrong.status,2);assert.match(wrong.stderr,/aligned sources/);
  const before=await readFile(output),overwrite=spawnSync(process.execPath,[...command,output],{encoding:'utf8'});
  assert.equal(overwrite.status,1);assert.deepEqual(await readFile(output),before);
  const oldManifest=join(directory,'old.json'),metadata=join(directory,'metadata.json');
  await writeFile(oldManifest,JSON.stringify({documents:[{paperId:'1910.11235',sourceHash:'b'.repeat(64)}]}));
  await writeFile(metadata,JSON.stringify([{paperId:'1910.11235',sha256:'b'.repeat(64),nativeArxivIdentifiers:['1910.11235v1']}]));
  const old=spawnSync(process.execPath,['scripts/study-source-preflight.mjs','--manifest',oldManifest,'--metadata',metadata,'--final','--output',join(directory,'old-report.json')],{encoding:'utf8'});
  assert.equal(old.status,2);assert.equal(JSON.parse(await readFile(join(directory,'old-report.json'),'utf8')).counts.unknown,1);
  await assert.rejects(()=>readPublishedStudyArtifact(root,'../manifest.json'),/artifact path/);
  await symlink(directory,join(root,'escape'),'junction');
  await assert.rejects(()=>readPublishedStudyArtifact(root,'escape/manifest.json'),/outside its local bundle root/);
 }finally{
  assert.equal(dirname(resolve(directory)),resolve(tmpdir()));assert.ok(basename(directory).startsWith('study-publisher-'));
  await rm(directory,{recursive:true,force:true});
 }
});
