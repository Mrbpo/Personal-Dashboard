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
test('automatic guides pin their version across publication and keep the reviewed sample separately accessible', async () => {
  const root = await mkdtemp(join(tmpdir(),'published-guide-'));
  const previous = process.env.RECORDINGS_GUIDE_DIR;
  process.env.RECORDINGS_GUIDE_DIR=root;
  const object = {sha256:'d'.repeat(64),durationSeconds:20,key:'course-recordings/123/fixture'} as Parameters<typeof readGuideManifest>[0];
  const dir = join(root,object.sha256);
  const digest = (value:string)=>createHash('sha256').update(value).digest('hex');
  async function version(text:string,extra:Record<string,unknown>={}) {
    const proof={bytes:Buffer.byteLength(text),sha256:digest(text)};
    const data={schemaVersion:2,videoSha256:object.sha256,courseId:'123',courseName:'BIOA01 · Biology',title:'Lecture 1',
      publishedAt:null,clipStartMs:0,clipEndMs:20000,frameCount:2,totalCues:3,translatedCues:2,files:{html:proof,pdf:proof},...extra};
    const json=JSON.stringify(data), id=digest(json);
    const folder=join(dir,id);
    await mkdir(folder,{recursive:true});
    await writeFile(join(folder,'manifest.json'),json);
    await writeFile(join(folder,'guide.html'),text);
    await writeFile(join(folder,'guide.pdf'),text);
    await writeFile(join(dir,'current.json'),JSON.stringify({version:id}));
    return id;
  }
  try {
    const first=await version('first version'), snapshot=await readGuideManifest(object);
    assert.ok(snapshot&&snapshot.schemaVersion===2);
    assert.equal(snapshot.courseName,'BIOA01 · Biology');
    assert.equal(snapshot.publishedAt,null);
    assert.equal(snapshot.version,first);
    assert.ok(!('reviewed' in snapshot));
    await assert.rejects(readGuideManifest({...object,key:'course-recordings/999/fixture'}),/核验/);
    await assert.rejects(readGuideAsset(object,snapshot,'outlinePdf'),/格式/);
    const second=await version('second version',{publishedAt:1700000000});
    const latest=await readGuideManifest(object);
    assert.ok(latest?.schemaVersion===2 && latest.version===second);
    assert.equal(latest.publishedAt,1700000000);
    assert.equal((await readGuideAsset(object,snapshot,'pdf')).toString(),'first version');
    assert.deepEqual(await readGuideManifest(object,first),snapshot);
    await writeFile(join(dir,first,'manifest.json'),'{}');
    await assert.rejects(readGuideManifest(object,first),/核验/);
    assert.equal(await readGuideManifest(object,'0'.repeat(64)),null);
    assert.equal(await readGuideManifest(object,'reviewed'),null);
    const proof={bytes:1,sha256:digest('x')};
    await writeFile(join(dir,'manifest.json'),JSON.stringify({schemaVersion:1,reviewed:true,videoSha256:object.sha256,
      clipStartMs:100,clipEndMs:1000,files:{html:proof,pdf:proof,outlineText:proof,outlinePdf:proof}}));
    assert.equal((await readGuideManifest(object,'reviewed'))?.schemaVersion,1);
    assert.equal((await readGuideManifest(object))?.schemaVersion,2);
    await version('invalid source',{videoSha256:'a'.repeat(64)});
    await assert.rejects(readGuideManifest(object),/核验/);
    await version('invalid translation coverage',{translatedCues:4});
    await assert.rejects(readGuideManifest(object),/核验/);
    await writeFile(join(dir,'current.json'),JSON.stringify({version:'../other'}));
    await assert.rejects(readGuideManifest(object),/核验/);
    await writeFile(join(dir,'current.json'),JSON.stringify({version:'0'.repeat(64)}));
    await assert.rejects(readGuideManifest(object),/核验/);
  } finally {
    if(previous===undefined) delete process.env.RECORDINGS_GUIDE_DIR; else process.env.RECORDINGS_GUIDE_DIR=previous;
    await rm(root,{recursive:true,force:true});
  }
});
