import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL=':memory:';
const {saveDocument,removeDocument}=await import('../lib/library.ts');
const {getPageAnnotationScene,putPageAnnotationScene,validateAnnotationScene}=await import('../lib/pdf-annotation-scenes.ts');

const line={id:'line-1',type:'line',x:20,y:30,width:100,height:2,points:[[0,0],[100,2]],strokeColor:'#123456'};

test('Excalidraw scenes isolate owner and page, reject stale saves, and clean up on deletion',async()=>{
  const id=await saveDocument('scene-owner','','upload','scene.pdf','scene.pdf','application/pdf',Buffer.from('%PDF-1.4 test'));
  const scene={elements:[line],pageWidth:900,pageHeight:1200};
  assert.deepEqual(await getPageAnnotationScene('scene-owner',id,1),{revision:0,scene:{elements:[],pageWidth:0,pageHeight:0}});
  assert.deepEqual(await putPageAnnotationScene('scene-owner',id,1,0,scene),{revision:1});
  assert.deepEqual(await putPageAnnotationScene('scene-owner',id,1,0,scene),null);
  assert.deepEqual(await putPageAnnotationScene('scene-owner',id,1,1,{elements:[],pageWidth:900,pageHeight:1200}),{revision:2});
  assert.deepEqual(await getPageAnnotationScene('scene-owner',id,1),{revision:2,scene:{elements:[],pageWidth:900,pageHeight:1200}});
  assert.deepEqual(await getPageAnnotationScene('scene-owner',id,2),{revision:0,scene:{elements:[],pageWidth:0,pageHeight:0}});
  await assert.rejects(getPageAnnotationScene('other-owner',id,1));
  await assert.rejects(putPageAnnotationScene('other-owner',id,1,0,scene));
  await removeDocument('scene-owner',id);
  await assert.rejects(getPageAnnotationScene('scene-owner',id,1));
});

test('Excalidraw scenes reject backgrounds, images, links, duplicate IDs, and oversized data',()=>{
  const scene=(elements:unknown[])=>({elements,pageWidth:900,pageHeight:1200});
  assert.throws(()=>validateAnnotationScene(scene([{...line,type:'image'}])));
  assert.throws(()=>validateAnnotationScene(scene([{...line,id:'pdf-background-image'}])));
  assert.throws(()=>validateAnnotationScene(scene([{...line,link:'https://example.com'}])));
  assert.throws(()=>validateAnnotationScene(scene([line,line])));
  assert.throws(()=>validateAnnotationScene(scene([{...line,x:Infinity}])));
  assert.throws(()=>validateAnnotationScene(scene([{...line,x:850}])));
  assert.throws(()=>validateAnnotationScene(scene([{...line,x:0,y:0,angle:Math.PI/4}])));
  assert.throws(()=>validateAnnotationScene(scene([{...line,text:'x'.repeat(1024*1024)}])));
});
