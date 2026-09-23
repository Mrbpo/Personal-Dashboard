import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawn} from 'node:child_process';
import {createClient} from '@libsql/client';

test('two starters backfill old content once and later starters reuse the index',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'study-fts-bootstrap-'));
  const databasePath=join(directory,'legacy.db');
  try{
    const run=()=>new Promise<{code:number|null;output:string}>((done)=>{
      const child=spawn(process.execPath,['--experimental-strip-types','-e',"const m=await import('./lib/database.ts'); console.log(await m.searchIndexAvailable())"],{
        cwd:process.cwd(),env:{...process.env,DATABASE_URL:`file:${databasePath.replaceAll('\\','/')}`},windowsHide:true,
      });
      let output='';child.stdout.on('data',(chunk)=>{output+=String(chunk);});child.stderr.on('data',(chunk)=>{output+=String(chunk);});
      child.on('close',(code)=>done({code,output}));
    });
    assert.equal((await run()).code,0);
    const client=createClient({url:`file:${databasePath.replaceAll('\\','/')}`});
    for(const table of ['source_items','piazza_posts','library_chunks']){
      for(const suffix of ['ai','ad','au'])await client.execute(`DROP TRIGGER IF EXISTS ${table}_fts_${suffix}`);
      await client.execute(`DROP TABLE IF EXISTS ${table}_fts`);
    }
    await client.execute("DELETE FROM search_index_state WHERE name='fts5'");
    await client.execute("INSERT INTO source_items(id,course_id,source_type,source_id,title,body,content_hash,first_seen_at,last_seen_at) VALUES('old-source','chem','page','old-source','Legacy spectroscopy','old Canvas lab text','hash','2025','2025')");
    await client.execute("INSERT INTO piazza_posts(id,course_id,network_id,post_number,title,body,answer,kind,content_hash,synced_at) VALUES('old-post','chem','chem','old','Legacy lab question','student question','Teacher says bring goggles','question','hash','2025')");
    await client.execute("INSERT INTO library_chunks VALUES('old-chunk','doc',0,'正文','Legacy notebook PDF','hash')");
    await client.close();
    const initial=await Promise.all([run(),run()]);
    assert.ok(initial.every((result)=>result.code===0),JSON.stringify(initial));
    assert.ok(initial.some((result)=>result.output.includes('true')));
    const again=await run();
    assert.equal(again.code,0,again.output);
    assert.match(again.output,/true/);

    const check=createClient({url:`file:${databasePath.replaceAll('\\','/')}`});
    assert.equal(Number((await check.execute("SELECT version FROM search_index_state WHERE name='fts5'")).rows[0]?.version),1);
    for(const [table,word] of [['source_items_fts','spectroscopy'],['piazza_posts_fts','goggles'],['library_chunks_fts','notebook']]){
      assert.equal((await check.execute({sql:`SELECT COUNT(*) count FROM ${table} WHERE ${table} MATCH ?`,args:[word]})).rows[0]?.count,1);
    }
    await check.close();
  }finally{
    const target=resolve(directory),root=resolve(tmpdir());
    if(target.startsWith(root+sep))try{rmSync(target,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
    catch(error){if(!['EPERM','EBUSY'].includes((error as NodeJS.ErrnoException).code||''))throw error;}
  }
});
