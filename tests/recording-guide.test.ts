import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {readGuideManifest,readGuideAsset} from '../lib/recording-guide.ts';
test('reviewed guides require current original, valid coverage and unmodified assets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'recording-guide-')),previous=process.env.RECORDINGS_GUIDE_DIR;
 process.env.RECORDINGS_GUIDE_DIR=root;
 const object={sha256:'a'.repeat(64),durationSeconds:1000} as Parameters<typeof readGuideManifest>[0];
 const bytes=Buffer.from('<html>synthetic guide</html>'),proof={bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
 const manifest={schemaVersion:1,videoSha256:object.sha256,clipStartMs:600000,clipEndMs:900000,reviewed:true,
  files:{html:proof,pdf:proof,outlinePdf:proof,outlineText:proof}};
 try{
  assert.equal(await readGuideManifest(object),null);
  const directory=join(root,object.sha256);await mkdir(directory);
  const save=async(value:unknown)=>writeFile(join(directory,'manifest.json'),JSON.stringify(value));
  await save(manifest);await writeFile(join(directory,'guide.html'),bytes);
  const read=await readGuideManifest(object);assert.ok(read);assert.deepEqual(await readGuideAsset(object,read,'html'),bytes);
  await writeFile(join(directory,'guide.html'),'x'.repeat(bytes.length));await assert.rejects(readGuideAsset(object,read,'html'),/核验/);
  await save({...manifest,videoSha256:'b'.repeat(64)});await assert.rejects(readGuideManifest(object),/核验/);
  await save({...manifest,clipEndMs:2000000});await assert.rejects(readGuideManifest(object),/核验/);
  await save({...manifest,reviewed:false});await assert.rejects(readGuideManifest(object),/核验/);
 }finally{if(previous===undefined)delete process.env.RECORDINGS_GUIDE_DIR;else process.env.RECORDINGS_GUIDE_DIR=previous;await rm(root,{recursive:true,force:true});}
});
