import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('a replacement worker cancels a persisted archive claim and keeps the same book',()=>{
  const directory=mkdtempSync(join(tmpdir(),'sketch-restart-'));
  const env={...process.env,DATABASE_URL:`file:${join(directory,'study.db').replaceAll('\\','/')}`,LIBRARY_DIR:join(directory,'blobs')};
  const run=(source:string)=>{
    const result=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',source],{cwd:process.cwd(),env,encoding:'utf8',timeout:60000});
    assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout.trim().split('\n').at(-1)||'';
  };
  try{
    const id=run(`
      const {createClient}=await import('@libsql/client');
      const legacy=createClient({url:process.env.DATABASE_URL});
      await legacy.execute("CREATE TABLE sketchbooks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', draft_text TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0, last_activity_at TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT)");
      legacy.close();
      const sketch=await import('./lib/sketchbooks.ts');
      const {database:db}=await import('./lib/database.ts');
      const state=await sketch.sketchState('restart-owner');
      await sketch.saveSketchDraft('restart-owner',state.book.id,'必须保留的原文','');
      await db.prepare("UPDATE sketchbooks SET status='archiving',last_activity_at=?,archive_claimed_at=?,archive_token=? WHERE id=?").bind(new Date(Date.now()-3*60*60*1000).toISOString(),new Date(Date.now()-10*60*1000).toISOString(),'dead-worker',state.book.id).run();
      console.log(state.book.id);
    `);
    const result=JSON.parse(run(`
      const sketch=await import('./lib/sketchbooks.ts');
      await sketch.recoverSketchArchiveClaims();
      const archived=await sketch.sketchState('restart-owner','${id}');
      const active=await sketch.sketchState('restart-owner');
      console.log(JSON.stringify({status:archived.book.status,draft:archived.book.draft_text,versions:archived.versions.length,newId:active.book.id}));
    `)) as {status:string;draft:string;versions:number;newId:string};
    assert.equal(result.status,'active');assert.equal(result.draft,'必须保留的原文');assert.equal(result.versions,0);assert.equal(result.newId,id);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
