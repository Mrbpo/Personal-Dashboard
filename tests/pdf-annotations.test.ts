import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL=':memory:';
const {saveDocument,removeDocument}=await import('../lib/library.ts');
const {getPageAnnotations,putPageAnnotations,validateStrokes}=await import('../lib/pdf-annotations.ts');

test('PDF annotations save first and subsequent revisions without stale overwrites',async()=>{
  const id=await saveDocument('ink-owner','','upload','annotated.pdf','annotated.pdf','application/pdf',Buffer.from('%PDF-1.4 test'));
  const first=[{id:'stroke-1',color:'#e63946',width:0.004,points:[{x:0.1,y:0.2},{x:0.5,y:0.6}]}];
  const second=[...first,{id:'stroke-2',color:'#000000',width:0.008,points:[{x:0.9,y:0.1}]}];
  assert.deepEqual(await getPageAnnotations('ink-owner',id,1),{revision:0,strokes:[]});
  assert.deepEqual(await putPageAnnotations('ink-owner',id,1,0,first),{revision:1});
  assert.deepEqual(await putPageAnnotations('ink-owner',id,1,1,second),{revision:2});
  assert.equal(await putPageAnnotations('ink-owner',id,1,1,first),null);
  assert.equal(await putPageAnnotations('ink-owner',id,2,1,first),null);
  assert.deepEqual(await getPageAnnotations('ink-owner',id,1),{revision:2,strokes:second});
  assert.deepEqual(await getPageAnnotations('ink-owner',id,2),{revision:0,strokes:[]});
  await assert.rejects(getPageAnnotations('other-owner',id,1));
  await assert.rejects(putPageAnnotations('other-owner',id,1,0,first));
  await removeDocument('ink-owner',id);
  await assert.rejects(getPageAnnotations('ink-owner',id,1));
});

test('PDF annotations reject invalid and oversized stroke data',()=>{
  assert.throws(()=>validateStrokes([{id:'x',color:'red',width:0.004,points:[{x:0,y:0}]}]));
  assert.throws(()=>validateStrokes([{id:'x',color:'#ffffff',width:0.004,points:[{x:1.1,y:0}]}]));
  assert.throws(()=>validateStrokes(Array.from({length:1001},(_,i)=>({id:String(i),color:'#ffffff',width:0.004,points:[{x:0,y:0}]}))));
});
