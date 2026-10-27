import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {subtitleGenerationStatus,requestSubtitleGeneration} from '../lib/recording-subtitle-request.ts';

test('per-video requests are exclusive/idempotent and never write the root queue',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'subtitle-request-')),previous=process.env.COURSE_VIDEO_CONTROL_DIR;
 process.env.COURSE_VIDEO_CONTROL_DIR=directory;
 try{
  await mkdir(join(directory,'requests'));
  const outcomes=await Promise.all([requestSubtitleGeneration('a'.repeat(64)),requestSubtitleGeneration('b'.repeat(64))]);
  assert.equal(outcomes.filter(Boolean).length,1);
  const request=JSON.parse(await readFile(join(directory,'requests','subtitle-request.json'),'utf8'));
  assert.deepEqual(Object.keys(request).sort(),['action','id','requestedAt','videoSha256']);
  assert.equal(request.action,'subtitle');
  assert.equal((await requestSubtitleGeneration(request.videoSha256))?.requestId,request.id);
  await assert.rejects(readFile(join(directory,'subtitle-queue.json')),{code:'ENOENT'});
  assert.equal((await subtitleGenerationStatus(request.videoSha256)).state,'queued');
 }finally{if(previous===undefined)delete process.env.COURSE_VIDEO_CONTROL_DIR;else process.env.COURSE_VIDEO_CONTROL_DIR=previous;await rm(directory,{recursive:true,force:true});}
});

test('automatic backlog may be prioritized, while active, manually queued, failed and deferred jobs cannot restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'subtitle-status-')),previous=process.env.COURSE_VIDEO_CONTROL_DIR;
 process.env.COURSE_VIDEO_CONTROL_DIR=directory;
 const sha='a'.repeat(64),now=Date.now();
 try{
  await mkdir(join(directory,'requests'));
  const state=async(row:Record<string,unknown>)=>{await writeFile(join(directory,'subtitle-queue.json'),JSON.stringify({jobs:[{videoSha256:sha,...row}]}));return subtitleGenerationStatus(sha,false,now);};
  assert.equal((await state({state:'pending'})).canRequest,true);
  assert.equal((await state({state:'pending',requestedAt:new Date(now).toISOString()})).canRequest,false);
  assert.equal((await state({state:'running',leaseExpiresAt:new Date(now+100000).toISOString()})).state,'running');
  assert.equal((await state({state:'failed',reasonCode:'TRANSLATION_STOPPED_REVIEW_LEDGER'})).canRequest,false);
  assert.equal((await state({state:'pending',notBefore:new Date(now+100000).toISOString()})).state,'deferred');
  assert.equal((await state({state:'pending',requestedAt:new Date(now-200000).toISOString(),notBefore:new Date(now-1000).toISOString()})).canRequest,true);
  await mkdir(join(directory,'subtitle-results'));
  await writeFile(join(directory,'subtitle-results',sha+'.json'),JSON.stringify({state:'failed',reasonCode:'SUBTITLE_SOURCE_UNAVAILABLE'}));
  assert.equal((await state({state:'pending'})).canRequest,true,'preflight source rejection must not permanently block a restored original');
  assert.equal((await state({state:'failed',reasonCode:'TRANSLATION_STOPPED_REVIEW_LEDGER'})).canRequest,false,'actual failure still needs ledger review');
  assert.equal((await subtitleGenerationStatus(sha,true)).state,'completed');
 }finally{if(previous===undefined)delete process.env.COURSE_VIDEO_CONTROL_DIR;else process.env.COURSE_VIDEO_CONTROL_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
