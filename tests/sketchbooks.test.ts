import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL=':memory:';
process.env.OPENAI_API_KEY='test-key';
const sketch=await import('../lib/sketchbooks.ts');
const {database:db}=await import('../lib/database.ts');
const red='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP8zwACTGCSAQANHQEDgslx/wAAAABJRU5ErkJggg==';
const blue='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNkYPjPwMDAxAAGAAsfAQMU4wsAAAAAAElFTkSuQmCC';

test('pages, original text and AI answers persist as editable source data',async()=>{
  type Call={input:Array<{content:Array<{type:string;image_url?:string}>}>};
  const original=globalThis.fetch;const calls:Call[]=[];
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(String(init?.body)) as Call;calls.push(body);return Response.json({output_text:`回答 ${calls.length}`});};
  try{
    const first=await sketch.sketchState('sketch-alice');const id=first.book.id;
    await sketch.saveSketchDraft('sketch-alice',id,'共享问题：解释图形','');
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
    assert.equal(calls[0].input.flatMap(m=>m.content).find(p=>p.type==='input_image')?.image_url,red);
    assert.equal(calls[1].input.flatMap(m=>m.content).find(p=>p.type==='input_image')?.image_url,blue);
    const saved=await sketch.sketchState('sketch-alice',id);
    assert.equal(saved.book.draft_text,'共享问题：解释图形');
    assert.equal(saved.entries.filter(e=>e.kind==='question').length,2);
    assert.equal(saved.entries.filter(e=>e.kind==='answer').length,2);
  }finally{globalThis.fetch=original;}
});

test('two hours away keeps the same editable book and creates no PDF',async()=>{
  const owner='idle-owner',current=await sketch.sketchState(owner),id=current.book.id;
  await sketch.saveSketchPage(owner,id,1,red,0);
  await sketch.saveSketchDraft(owner,id,'继续写','');
  await db.prepare('UPDATE sketchbooks SET last_activity_at=? WHERE id=?').bind(new Date(Date.now()-3*60*60*1000).toISOString(),id).run();
  await sketch.recoverSketchArchiveClaims();
  const resumed=await sketch.sketchState(owner);
  assert.equal(resumed.book.id,id);assert.equal(resumed.book.status,'active');assert.equal(resumed.versions.length,0);
  assert.equal(resumed.book.draft_text,'继续写');assert.equal(resumed.pages[0].revision,1);
  await sketch.saveSketchPage(owner,id,1,blue,1);
  assert.equal((await sketch.sketchState(owner)).pages[0].revision,2);
});

test('manual PDF versions survive later source edits',async()=>{
  const owner='pdf-owner',current=await sketch.sketchState(owner),id=current.book.id;
  await sketch.saveSketchPage(owner,id,1,red,0);
  const entryId=await sketch.addSketchText(owner,id,1,'原文：面积是多少？');
  const first=await sketch.generateSketchPdf(owner,id);
  assert.equal((await sketch.sketchPdf(owner,id,first)).subarray(0,4).toString(),'%PDF');
  await sketch.editSketchEntry(owner,id,entryId,'改后的原文',0);
  const second=await sketch.generateSketchPdf(owner,id);
  assert.notEqual(first,second);assert.equal((await sketch.sketchState(owner)).versions.length,2);
  await assert.rejects(sketch.sketchPdf('other-owner',id,first));
});

test('previously archived books and their PDF versions remain accessible',async()=>{
  const owner='history-owner',current=await sketch.sketchState(owner),id=current.book.id;
  await sketch.saveSketchPage(owner,id,1,red,0);
  const version=await sketch.generateSketchPdf(owner,id);
  await db.prepare("UPDATE sketchbooks SET status='archived',archived_at=? WHERE id=?").bind(new Date().toISOString(),id).run();
  const active=await sketch.sketchState(owner);
  assert.notEqual(active.book.id,id);assert.ok(active.archive.some(book=>book.id===id));
  assert.equal((await sketch.sketchState(owner,id)).pages[0].revision,1);
  assert.equal((await sketch.sketchPdf(owner,id,version)).subarray(0,4).toString(),'%PDF');
});

test('note draft and entry edits survive reload and reject stale windows',async()=>{
  const owner='text-owner',current=await sketch.sketchState(owner),id=current.book.id;
  await sketch.saveSketchNoteDraft(owner,id,1,'尚未添加的文字',0);
  assert.equal((await sketch.sketchState(owner)).pages[0].note_draft,'尚未添加的文字');
  await assert.rejects(sketch.saveSketchNoteDraft(owner,id,1,'旧窗口文字',0));
  const entryId=crypto.randomUUID();
  await sketch.commitSketchNote(owner,id,1,'尚未添加的文字',1,entryId);
  await sketch.commitSketchNote(owner,id,1,'尚未添加的文字',1,entryId);
  const added=await sketch.sketchState(owner);
  assert.equal(added.pages[0].note_draft,'');assert.equal(added.entries.filter(e=>e.id===entryId).length,1);
  await sketch.editSketchEntry(owner,id,entryId,'自动保存的编辑',0);
  await assert.rejects(sketch.editSketchEntry(owner,id,entryId,'旧窗口覆盖',0));
  assert.equal((await sketch.sketchState(owner)).entries.find(e=>e.id===entryId)?.body,'自动保存的编辑');
  await sketch.saveSketchDraft(owner,id,'共享修改','');
  await assert.rejects(sketch.saveSketchDraft(owner,id,'旧窗口覆盖',''));
});

test('legacy archive claims are restored without a blank book',async()=>{
  const owner='claim-owner',current=await sketch.sketchState(owner),id=current.book.id;
  await sketch.saveSketchDraft(owner,id,'必须保留的原文','');
  await db.prepare("UPDATE sketchbooks SET status='archiving',archive_claimed_at=?,archive_token=? WHERE id=?").bind(new Date().toISOString(),'old-worker',id).run();
  await sketch.recoverSketchArchiveClaims();
  const resumed=await sketch.sketchState(owner);
  assert.equal(resumed.book.id,id);assert.equal(resumed.book.status,'active');assert.equal(resumed.book.draft_text,'必须保留的原文');
  assert.equal(resumed.versions.length,0);
});

test('legacy PNG remains a base image when new strokes are saved and erased',async()=>{
  const owner='vector-migration-owner',first=await sketch.sketchState(owner),id=first.book.id;
  await sketch.saveSketchPage(owner,id,1,red,0);
  const legacy=await sketch.sketchState(owner,id);
  assert.equal(legacy.pages[0].strokes,null);
  const oldPdf=await sketch.generateSketchPdf(owner,id);
  const original=await sketch.sketchImage(owner,id,1);
  const strokes=[{id:'new-ink',color:'#123456',width:0.003,points:[{x:0.1,y:0.2},{x:0.5,y:0.6}]}];
  await sketch.saveSketchPage(owner,id,1,blue,1,strokes);
  const migrated=await sketch.sketchState(owner,id);
  assert.deepEqual(migrated.pages[0].strokes,strokes);
  await assert.rejects(sketch.saveSketchPage(owner,id,1,red,2),/新版画笔/);
  assert.equal((await sketch.sketchState(owner,id)).pages[0].revision,2);
  assert.equal((await sketch.sketchBaseImage(owner,id,1)).toString('base64'),original.toString('base64'));
  await sketch.saveSketchPage(owner,id,1,red,2,[]);
  assert.deepEqual((await sketch.sketchState(owner,id)).pages[0].strokes,[]);
  assert.equal((await sketch.sketchBaseImage(owner,id,1)).toString('base64'),original.toString('base64'));
  assert.equal((await sketch.sketchPdf(owner,id,oldPdf)).subarray(0,4).toString(),'%PDF');
  await assert.rejects(sketch.saveSketchPage(owner,id,1,red,2,strokes));
  await assert.rejects(sketch.saveSketchPage(owner,id,1,red,3,[{...strokes[0],color:'invalid'}]));
});

test('clear whole page stays blank after reload and can restore its PNG and strokes',async()=>{
  const owner='clear-page-owner',first=await sketch.sketchState(owner),id=first.book.id;
  await sketch.saveSketchPage(owner,id,1,red,0);
  const strokes=[{id:'old-stroke',color:'#123456',width:0.003,points:[{x:0.1,y:0.2}]}];
  await sketch.saveSketchPage(owner,id,1,blue,1,strokes);
  const pdf=await sketch.generateSketchPdf(owner,id);
  await sketch.clearSketchPage(owner,id,1,2);
  const blank=await sketch.sketchState(owner,id);
  assert.equal(blank.pages[0].image_hash,null);
  assert.deepEqual(blank.pages[0].strokes,[]);
  assert.ok(blank.pages[0].cleared_image_hash);
  assert.equal((await sketch.sketchPdf(owner,id,pdf)).subarray(0,4).toString(),'%PDF');
  await sketch.restoreClearedSketchPage(owner,id,1,3);
  const restored=await sketch.sketchState(owner,id);
  assert.deepEqual(restored.pages[0].strokes,strokes);
  assert.equal((await sketch.sketchImage(owner,id,1)).toString('base64'),Buffer.from(blue.split(',')[1],'base64').toString('base64'));
  assert.equal((await sketch.sketchBaseImage(owner,id,1)).toString('base64'),Buffer.from(red.split(',')[1],'base64').toString('base64'));
  await assert.rejects(sketch.restoreClearedSketchPage(owner,id,1,4));
});
