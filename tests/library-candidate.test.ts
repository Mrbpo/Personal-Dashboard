import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL=':memory:';
process.env.OPENAI_API_KEY='test-key';
const {database:db,searchIndexAvailable}=await import('../lib/database.ts');
const {searchLibrary,EMBED_MODEL}=await import('../lib/library.ts');

test('semantic search reads vectors only for owner- and course-scoped candidates',async()=>{
  assert.equal(await searchIndexAvailable(),true);
  const vector=JSON.stringify(Array(768).fill(0.1));
  const statements=[];
  for(let index=0;index<201;index++){
    const id=`doc-${index}`,owner=index<100?'other':'alice',course=index<200?'stats':'chem';
    statements.push(db.prepare(`INSERT INTO library_documents (id,owner_id,course_id,origin,origin_key,name,mime,hash,size,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'ready','now')`).bind(id,owner,course,'upload',id,'Lab 1 Instructions.txt','text/plain',`hash-${index}`,100));
    statements.push(db.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(`${id}:0`,id,0,'正文','Lab 1 requirements and notebook',`chunk-hash-${index}`));
    statements.push(db.prepare('INSERT INTO library_vectors VALUES (?,?,?)').bind(`${id}:0`,EMBED_MODEL,vector));
  }
  for(let index=0;index<statements.length;index+=150)await db.batch(statements.slice(index,index+150));
  const original=globalThis.fetch;
  let detail:{candidateCount:number;vectorRows:number;vectorBytes:number}|undefined;
  globalThis.fetch=(async()=>Response.json({data:[{index:0,embedding:Array(768).fill(0.1)}]})) as typeof fetch;
  try{
    const hits=await searchLibrary('alice','我的实验要求','chem',true,{onTiming:(value)=>{detail=value;}});
    assert.deepEqual(hits.map(hit=>hit.document_id),['doc-200']);
    assert.equal(detail?.vectorRows,1);
    assert.ok((detail?.candidateCount||0)<=2);
    assert.ok((detail?.vectorBytes||0)<vector.length*2);
    await db.prepare("UPDATE library_documents SET deleted=1 WHERE id='doc-200'").run();
    assert.equal((await searchLibrary('alice','我的实验要求','chem',false)).length,0);
  }finally{globalThis.fetch=original;}
});
