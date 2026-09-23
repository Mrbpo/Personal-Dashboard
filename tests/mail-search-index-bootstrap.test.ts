import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {createClient} from '@libsql/client';

test('mail FTS backfills old messages once across concurrent starters and tracks updates',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'study-mail-fts-')),databasePath=join(directory,'legacy.db');
 const url=`file:${databasePath.replaceAll('\\','/')}`;
 const run=()=>new Promise<{code:number|null;output:string}>(done=>{
  const child=spawn(process.execPath,['--experimental-strip-types','-e',"const m=await import('./lib/database.ts'); console.log(await m.mailSearchIndexAvailable())"],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:url},windowsHide:true});
  let output='';child.stdout.on('data',chunk=>{output+=String(chunk);});child.stderr.on('data',chunk=>{output+=String(chunk);});child.on('close',code=>done({code,output}));
 });
 try{
  assert.equal((await run()).code,0);
  const client=createClient({url});
  for(const suffix of ['ai','ad','au'])await client.execute(`DROP TRIGGER IF EXISTS mail_messages_fts_${suffix}`);
  await client.execute('DROP TABLE IF EXISTS mail_messages_fts');
  await client.execute("DELETE FROM mail_search_index_state WHERE name='mail-fts5'");
  await client.execute("INSERT INTO mail_messages (id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES ('old-mail','alice@example.invalid','thread','Old archive','sender@example.invalid','quarterfactverified in the middle','2020','学习','[]','old-hash')");
  await client.close();
  const starters=await Promise.all([run(),run()]);assert.ok(starters.every(result=>result.code===0),JSON.stringify(starters));
  const check=createClient({url});
  assert.equal(Number((await check.execute("SELECT version FROM mail_search_index_state WHERE name='mail-fts5'")).rows[0]?.version),1);
  assert.equal(Number((await check.execute("SELECT COUNT(*) n FROM mail_messages_fts WHERE mail_messages_fts MATCH 'quarterfactverified'")).rows[0]?.n),1);
  await check.execute("UPDATE mail_messages SET body='updated middle fact' WHERE id='old-mail'");
  assert.equal(Number((await check.execute("SELECT COUNT(*) n FROM mail_messages_fts WHERE mail_messages_fts MATCH 'quarterfactverified'")).rows[0]?.n),0);
  await check.close();
 }finally{
  const target=resolve(directory),root=resolve(tmpdir());if(target.startsWith(root+sep))try{rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(!['EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code||''))throw error;}
 }
});
