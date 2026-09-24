import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.OPENAI_API_KEY='test-key';
const sketch=await import('../lib/sketchbooks.ts');
const {database:db}=await import('../lib/database.ts');
const red='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==';
const blue='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxAAGAAsfAQMU4wsAAAAAAElFTkSuQmCC';

test('sketch pages persist separately, AI only receives the selected image, and owner cannot cross read',async()=>{
  type Call={input:Array<{content:Array<{type:string;image_url?:string}>}>};
  const original=globalThis.fetch;const calls:Call[]=[];
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Call;calls.push(body);return Response.json({output_text:`回答 ${calls.length}`});};
  try{
    const first=await sketch.sketchState('sketch-alice');const id=first.book.id;
    await sketch.saveSketchDraft('sketch-alice',id,'共享问题：解释图形');
    await sketch.saveSketchPage('sketch-alice',id,1,red,0);
    const second=await sketch.addSketchPage('sketch-alice',id);
    await sketch.saveSketchPage('sketch-alice',id,second,blue,0);
    await assert.rejects(sketch.sketchState('sketch-bob',id));
    await assert.rejects(sketch.sketchImage('sketch-bob',id,1));
    await assert.rejects(sketch.saveSketchPage('sketch-bob',id,1,red,1));
    await assert.rejects(sketch.saveSketchPage('sketch-alice',id,1,red,0));
    await sketch.askSketch('sketch-alice',id,1,crypto.randomUUID());
    await sketch.askSketch('sketch-alice',id,2,crypto.randomUUID());
    assert.equal(calls.length,2);
    const firstImages=calls[0].input.flatMap(m=>m.content).filter(p=>p.type==='input_image');
    const secondImages=calls[1].input.flatMap(m=>m.content).filter(p=>p.type==='input_image');
    assert.equal(firstImages.length,1);assert.equal(secondImages.length,1);
    assert.equal(firstImages[0].image_url,red);assert.equal(secondImages[0].image_url,blue);
    assert.equal(JSON.stringify(calls[1]).includes(red),false);
    assert.equal(JSON.stringify(calls[1]).includes('回答 1'),false);
    assert.equal(calls[1].input.length,2);
    const saved=await sketch.sketchState('sketch-alice',id);
    assert.equal(saved.book.draft_text,'共享问题：解释图形');
    assert.equal(saved.entries.filter(e=>e.kind==='question').length,2);
    assert.equal(saved.entries.filter(e=>e.kind==='answer').length,2);
  }finally{globalThis.fetch=original;}
});

test('PDF versions survive edits; idle archive creates a blank book only after valid PDF',async()=>{
  const current=await sketch.sketchState('archive-owner'),id=current.book.id;
  await sketch.saveSketchPage('archive-owner',id,1,red,0);
  await sketch.addSketchText('archive-owner',id,1,'原文：面积是多少？');
  const first=await sketch.generateSketchPdf('archive-owner',id);
  assert.equal((await sketch.sketchPdf('archive-owner',id,first)).subarray(0,4).toString(),'%PDF');
  const entry=(await sketch.sketchState('archive-owner',id)).entries[0];
  await sketch.editSketchEntry('archive-owner',id,entry.id,'改后的原文');
  const second=await sketch.generateSketchPdf('archive-owner',id);
  assert.notEqual(first,second);
  await assert.rejects(sketch.sketchPdf('other-owner',id,first));
  await db.prepare('UPDATE sketchbooks SET last_activity_at=? WHERE id=?').bind(new Date(Date.now()-3*60*60*1000).toISOString(),id).run();
  await sketch.archiveIdleSketchbooks();
  const archived=await sketch.sketchState('archive-owner',id);
  assert.equal(archived.book.status,'archived');
  assert.ok(archived.versions.length>=3);
  const next=await sketch.sketchState('archive-owner');
  assert.notEqual(next.book.id,id);assert.equal(next.pages.length,1);assert.equal(next.entries.length,0);
  await db.prepare('UPDATE sketchbooks SET last_activity_at=? WHERE id=?').bind(new Date(Date.now()-3*60*60*1000).toISOString(),next.book.id).run();
  await sketch.archiveIdleSketchbooks();
  assert.equal((await sketch.sketchState('archive-owner')).book.id,next.book.id);
  assert.equal((await sketch.sketchState('archive-owner')).versions.length,0);
  await sketch.addSketchText('archive-owner',id,1,'归档后补充');
  const revised=await sketch.generateSketchPdf('archive-owner',id);
  assert.equal((await sketch.sketchPdf('archive-owner',id,revised)).subarray(0,4).toString(),'%PDF');
});

test('failed idle PDF keeps the source book active and retries after repair',async()=>{
  const current=await sketch.sketchState('retry-owner'),id=current.book.id;
  await db.prepare('UPDATE sketch_pages SET image_hash=? WHERE book_id=?').bind('f'.repeat(64),id).run();
  await db.prepare('UPDATE sketchbooks SET last_activity_at=? WHERE id=?').bind(new Date(Date.now()-3*60*60*1000).toISOString(),id).run();
  await sketch.archiveIdleSketchbooks();
  const failed=await sketch.sketchState('retry-owner');
  assert.equal(failed.book.id,id);assert.equal(failed.book.status,'active');assert.equal(failed.versions.length,0);
  await db.prepare('UPDATE sketch_pages SET image_hash=NULL WHERE book_id=?').bind(id).run();
  await sketch.saveSketchPage('retry-owner',id,1,red,0);
  await db.prepare('UPDATE sketchbooks SET last_activity_at=? WHERE id=?').bind(new Date(Date.now()-3*60*60*1000).toISOString(),id).run();
  await sketch.archiveIdleSketchbooks();
  assert.equal((await sketch.sketchState('retry-owner',id)).book.status,'archived');
  assert.notEqual((await sketch.sketchState('retry-owner')).book.id,id);
});

test('page navigation activity resets the server idle window',async()=>{
  const current=await sketch.sketchState('touch-owner'),id=current.book.id;
  await db.prepare('UPDATE sketchbooks SET last_activity_at=? WHERE id=?').bind(new Date(Date.now()-3*60*60*1000).toISOString(),id).run();
  await sketch.touchSketch('touch-owner',id);
  await assert.rejects(sketch.touchSketch('other-owner',id));
  await sketch.archiveIdleSketchbooks();
  assert.equal((await sketch.sketchState('touch-owner',id)).book.status,'active');
});

test('a used but cleared book stays active without generating an empty PDF',async()=>{
  const current=await sketch.sketchState('cleared-owner'),id=current.book.id;
  await sketch.saveSketchDraft('cleared-owner',id,'临时问题');
  await sketch.saveSketchDraft('cleared-owner',id,'');
  await sketch.saveSketchPage('cleared-owner',id,1,red,0);
  const cleared=await sketch.saveSketchPage('cleared-owner',id,1,'',1);
  assert.equal(cleared.hasImage,false);
  await db.prepare('UPDATE sketchbooks SET last_activity_at=? WHERE id=?').bind(new Date(Date.now()-3*60*60*1000).toISOString(),id).run();
  await sketch.archiveIdleSketchbooks();
  const after=await sketch.sketchState('cleared-owner');
  assert.equal(after.book.id,id);assert.equal(after.book.status,'active');assert.equal(after.versions.length,0);
});

test('recent archive claim is not stolen before its recovery window',async()=>{
  const current=await sketch.sketchState('claim-owner'),id=current.book.id;
  await sketch.saveSketchDraft('claim-owner',id,'待归档文字');
  await db.prepare("UPDATE sketchbooks SET status='archiving',last_activity_at=?,archive_claimed_at=?,archive_token=? WHERE id=?").bind(new Date(Date.now()-3*60*60*1000).toISOString(),new Date().toISOString(),'running-worker',id).run();
  await sketch.archiveIdleSketchbooks();
  assert.equal((await sketch.sketchState('claim-owner',id)).book.status,'archiving');
  await db.prepare('UPDATE sketchbooks SET archive_claimed_at=? WHERE id=?').bind(new Date(Date.now()-10*60*1000).toISOString(),id).run();
  await sketch.archiveIdleSketchbooks();
  assert.equal((await sketch.sketchState('claim-owner',id)).book.status,'archived');
});
