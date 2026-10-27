import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRecordingCatalog,assertRecordingOwner} from '../lib/recording-catalog.ts';
const target={bucket:'dashboard',endpointHost:'a'.repeat(32)+'.r2.cloudflarestorage.com'};
const hash='b'.repeat(64);
function entry(id='0_parent',parentEntryId:string|null=null){return {courseId:'123',entryId:id,parentEntryId,title:'Lecture 1',state:'archived',track:'unknown',
 durationSeconds:120,publishedAt:1700000000,files:[{kind:'video',path:`123/${id}/version-1/original.mp4`,sha256:hash,bytes:100,
 remote:{state:'verified',method:'full_get_sha256',...target,key:`course-recordings/123/${id}/version-1/${hash}.mp4`,etag:'"etag"',sha256:hash,bytes:100}}]};}
test('groups parent/child views without guessing visuals or leaking object keys',()=>{
 const result=buildRecordingCatalog({entries:{a:entry(),b:entry('0_child','0_parent')}},target,new Map([['123','Math']]));
 assert.equal(result.catalog.recordings.length,1);assert.equal(result.objects.size,2);
 assert.deepEqual(result.catalog.recordings[0].views.map(v=>v.label),['主视角','其他视角']);
 assert.equal(result.catalog.courses[0].name,'Math');assert.equal(JSON.stringify(result.catalog).includes('course-recordings/'),false);
});
test('rejects mismatched, foreign, traversal and unavailable objects without reviving history',()=>{
 const variants=[entry(),entry(),entry(),entry(),entry()];
 variants[0].files[0].remote.sha256='c'.repeat(64);variants[1].files[0].remote.bucket='other';
 variants[2].files[0].remote.key='study-backups/private';variants[3].files[0].path='../original.mp4';
 variants[4].state='retryable_failure';
 const result=buildRecordingCatalog({entries:Object.fromEntries(variants.map((v,i)=>[i,{...v,history:[entry()]}]))},target);
 assert.equal(result.objects.size,0);assert.equal(result.catalog.unavailableEntries,5);
});
test('object IDs bind to versions, orphan views stay visible and access is owner-scoped',()=>{
 const e=entry('0_child','0_parent'),before=buildRecordingCatalog({entries:{e}},target);
 e.files[0].path=e.files[0].path.replace('version-1','version-2');e.files[0].remote.key=e.files[0].remote.key.replace('version-1','version-2');
 const after=buildRecordingCatalog({entries:{e}},target);
 assert.equal(before.catalog.recordings[0].id,after.catalog.recordings[0].id);
 assert.notEqual([...before.objects.keys()][0],[...after.objects.keys()][0]);
 assert.doesNotThrow(()=>assertRecordingOwner('local-owner'));assert.throws(()=>assertRecordingOwner('another-owner'),/FORBIDDEN/);
});
