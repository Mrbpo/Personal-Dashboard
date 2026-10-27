import test from 'node:test';
import assert from 'node:assert/strict';
import {S3Client} from '@aws-sdk/client-s3';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {recordingPlaybackUrl,recordingTargetConfig,recordingStorageConfig,recordingPlaybackTtl} from '../lib/recording-storage.ts';

test('private playback HEAD-checks identity, signs GET only, and preserves session/expiry limits',async t=>{
 const names=['RECORDINGS_S3_ENDPOINT','RECORDINGS_S3_BUCKET','RECORDINGS_S3_ACCESS_KEY_ID','RECORDINGS_S3_SECRET_ACCESS_KEY','RECORDINGS_S3_SESSION_TOKEN','RECORDINGS_S3_CREDENTIALS_FILE'];
 const previous=names.map(name=>process.env[name]);
 t.after(()=>names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];}));
 delete process.env.RECORDINGS_S3_CREDENTIALS_FILE;
 process.env.RECORDINGS_S3_ENDPOINT='https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com';
 process.env.RECORDINGS_S3_BUCKET='test-recordings';process.env.RECORDINGS_S3_ACCESS_KEY_ID='TESTONLY';
 process.env.RECORDINGS_S3_SECRET_ACCESS_KEY='test-only-not-a-real-credential';process.env.RECORDINGS_S3_SESSION_TOKEN='test-session';
 let calls=0;
 const head=t.mock.method(S3Client.prototype,'send',async()=>{calls++;return {ContentLength:100,ETag:'"matching"'};});
 const object={id:'b'.repeat(64),sha256:'b'.repeat(64),key:'course-recordings/123/0_test/version-1/'+ 'b'.repeat(64)+'.mp4',etag:'"matching"',bytes:100,mime:'video/mp4',durationSeconds:7200};
 const url=new URL(await recordingPlaybackUrl(object));
 assert.equal(calls,1);assert.equal(url.hostname,recordingTargetConfig().endpointHost);
 assert.equal(url.searchParams.get('X-Amz-Security-Token'),'test-session');assert.equal(url.searchParams.get('X-Amz-Expires'),'9000');
 assert.equal(url.searchParams.get('response-content-type'),'video/mp4');assert.equal(url.searchParams.get('X-Amz-SignedHeaders'),'host');
 head.mock.mockImplementation(async()=>({ContentLength:100,ETag:'"changed"'}));
 await assert.rejects(recordingPlaybackUrl(object),/录像对象已变化/);
 process.env.RECORDINGS_S3_ENDPOINT='http://localhost:8080';assert.throws(()=>recordingTargetConfig(),/配置无效/);
});

test('rotating credential file is re-read, fails closed and caps signed grants before credential expiry',async t=>{
 const names=['RECORDINGS_S3_ENDPOINT','RECORDINGS_S3_BUCKET','RECORDINGS_S3_CREDENTIALS_FILE','RECORDINGS_S3_ACCESS_KEY_ID','RECORDINGS_S3_SECRET_ACCESS_KEY'];
 const previous=names.map(name=>process.env[name]),root=await mkdtemp(join(tmpdir(),'recording-creds-')),file=join(root,'credentials.json');
 t.after(async()=>{names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];});await rm(root,{recursive:true,force:true});});
 process.env.RECORDINGS_S3_ENDPOINT='https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com';
 process.env.RECORDINGS_S3_BUCKET='test-recordings';process.env.RECORDINGS_S3_CREDENTIALS_FILE=file;
 process.env.RECORDINGS_S3_ACCESS_KEY_ID='not-a-fallback';process.env.RECORDINGS_S3_SECRET_ACCESS_KEY='not-a-fallback';
 const now=Date.now(),credentials={accessKeyId:'TESTONLY',secretAccessKey:'synthetic-secret',sessionToken:'synthetic-session',expiresAt:new Date(now+7200000).toISOString()};
 await writeFile(file,JSON.stringify(credentials));
 assert.equal(recordingStorageConfig().credentials.sessionToken,'synthetic-session');
 await writeFile(file,JSON.stringify({...credentials,sessionToken:'rotated-synthetic-session'}));
 assert.equal(recordingStorageConfig().credentials.sessionToken,'rotated-synthetic-session');
 const head=t.mock.method(S3Client.prototype,'send',async()=>({ContentLength:100,ETag:'"matching"'}));
 const object={id:'b'.repeat(64),sha256:'b'.repeat(64),key:'course-recordings/123/0_test/version-1/'+ 'b'.repeat(64)+'.mp4',etag:'"matching"',bytes:100,mime:'video/mp4',durationSeconds:7200};
 const url=new URL(await recordingPlaybackUrl(object));
 assert.equal(url.searchParams.get('X-Amz-Security-Token'),'rotated-synthetic-session');
 const ttl=Number(url.searchParams.get('X-Amz-Expires'));assert.ok(ttl>7000&&ttl<=7140);assert.equal(head.mock.callCount(),1);
 assert.equal(recordingPlaybackTtl(7200,new Date(now+7200000),now),7140);
 assert.equal(recordingPlaybackTtl(60,new Date(now+86400000),now),3600);
 assert.throws(()=>recordingPlaybackTtl(60,new Date(now+60000),now),/即将过期/);
 for(const value of [{...credentials,expiresAt:new Date(now-1000).toISOString()},
  {...credentials,expiresAt:new Date(now+30000).toISOString()}, {...credentials,expiresAt:'not-a-date'},
  {...credentials,expiresAt:'2027-01-01T00:00:00'}, {...credentials,sessionToken:''}]){
  await writeFile(file,JSON.stringify(value));assert.throws(()=>recordingStorageConfig(),/凭据不可用或即将过期/);
 }
 await assert.rejects(recordingPlaybackUrl(object),/凭据不可用或即将过期/);assert.equal(head.mock.callCount(),1);
});
