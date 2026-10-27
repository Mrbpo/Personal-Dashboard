import test from 'node:test';
import assert from 'node:assert/strict';
import {S3Client} from '@aws-sdk/client-s3';
import {recordingPlaybackUrl,recordingTargetConfig} from '../lib/recording-storage.ts';

test('private playback HEAD-checks identity, signs GET only, and preserves session/expiry limits',async t=>{
 const names=['RECORDINGS_S3_ENDPOINT','RECORDINGS_S3_BUCKET','RECORDINGS_S3_ACCESS_KEY_ID','RECORDINGS_S3_SECRET_ACCESS_KEY','RECORDINGS_S3_SESSION_TOKEN'];
 const previous=names.map(name=>process.env[name]);
 t.after(()=>names.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];}));
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
