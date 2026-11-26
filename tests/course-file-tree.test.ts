import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFolders} from '../lib/course-file-tree.ts';

test('nested and identically named assets remain addressable without exposing disk paths',()=>{
  const tree=documentFolders([
    {id:'1',name:'same.pdf',folder_path:'第1周',size:3},
    {id:'2',name:'same.pdf',original_name:'原名.pdf',folder_path:'第1周/练习',size:7},
    {id:'3',name:'same.pdf',folder_path:'第1周',size:9}
  ]);
  const files=tree[0].children!;
  assert.equal(files[0].children![0].name,'原名.pdf');
  assert.equal(files[0].children![0].downloadUrl,'/api/v1/files?document=2');
  assert.deepEqual(files.slice(1).map(f=>f.id),['doc:1','doc:3']);
});
