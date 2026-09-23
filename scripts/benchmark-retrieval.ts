// Reproducible local comparison: node --experimental-strip-types scripts/benchmark-retrieval.ts
// Synthetic data only; no network request or private course content is used.
export {};
process.env.DATABASE_URL=':memory:';
process.env.OPENAI_API_KEY='benchmark-key';
process.env.AI_BUDGET_TEST_BYPASS='true';

const {database:db}=await import('../lib/database.ts');
const {searchLibrary,EMBED_MODEL,cosine}=await import('../lib/library.ts');
await db.prepare('SELECT 1').first();
const dimensions=Array(768).fill(0.1),vector=JSON.stringify(dimensions),count=3000;
for(let start=0;start<count;start+=150){
  const statements=[];
  for(let index=start;index<Math.min(start+150,count);index++){
    const id=`bench-${index}`,target=index===count-1;
    statements.push(db.prepare(`INSERT INTO library_documents (id,owner_id,course_id,origin,origin_key,name,mime,hash,size,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,'ready',?)`).bind(id,'bench','chem','upload',id,target?'Lab 1 Instructions.txt':`Lecture notes ${index}.txt`,'text/plain',`hash-${index}`,100,'now'));
    statements.push(db.prepare('INSERT INTO library_chunks VALUES (?,?,?,?,?,?)').bind(`${id}:0`,id,0,'正文',target?'Lab 1 requirement: prepare the notebook.':'Unrelated lecture material.',`chunk-${index}`));
    statements.push(db.prepare('INSERT INTO library_vectors VALUES (?,?,?)').bind(`${id}:0`,EMBED_MODEL,vector));
  }
  await db.batch(statements);
}
const rebuildStarted=performance.now();
await db.prepare("INSERT INTO library_chunks_fts(library_chunks_fts) VALUES('rebuild')").run();
const syntheticRebuildMs=performance.now()-rebuildStarted;

const originalFetch=globalThis.fetch;
globalThis.fetch=(async()=>Response.json({data:[{index:0,embedding:dimensions}]})) as typeof fetch;
type Sample={ms:number;vectorRows:number;vectorBytes:number;candidateCount:number};
function stats(samples:Sample[]){
  const times=samples.map(item=>item.ms).sort((a,b)=>a-b);
  return {medianMs:Number(times[4].toFixed(2)),p90Ms:Number(times[8].toFixed(2)),vectorRows:samples[0].vectorRows,vectorBytes:samples[0].vectorBytes,candidateCount:samples[0].candidateCount};
}
async function legacy():Promise<Sample>{
  const started=performance.now();
  const rows=(await db.prepare(`SELECT c.id,c.body,d.name FROM library_documents d LEFT JOIN library_chunks c ON c.document_id=d.id
    WHERE d.owner_id='bench' AND d.course_id='chem' AND d.deleted=0 AND d.status='ready' LIMIT 20000`).all<{id:string;body:string;name:string}>()).results;
  const vectors=(await db.prepare('SELECT chunk_id,vector FROM library_vectors WHERE model=?').bind(EMBED_MODEL).all<{chunk_id:string;vector:string}>()).results;
  const map=new Map(vectors.map(item=>[item.chunk_id,item.vector]));
  for(const row of rows)if(map.has(row.id))cosine(dimensions,JSON.parse(map.get(row.id)!));
  return {ms:performance.now()-started,vectorRows:vectors.length,vectorBytes:vectors.reduce((sum,item)=>sum+item.vector.length,0),candidateCount:rows.length};
}
async function current():Promise<Sample>{
  let detail={candidateCount:0,vectorRows:0,vectorBytes:0};
  const started=performance.now();
  await searchLibrary('bench','lab requirement','chem',true,{onTiming:(value)=>{detail=value;}});
  return {ms:performance.now()-started,...detail};
}
try{
  await legacy();await current();
  const before:Sample[]=[],after:Sample[]=[];
  for(let index=0;index<10;index++){before.push(await legacy());after.push(await current());}
  console.log(JSON.stringify({syntheticChunks:count,syntheticRebuildMs:Number(syntheticRebuildMs.toFixed(2)),query:'lab requirement',legacy:stats(before),current:stats(after)},null,2));
}finally{globalThis.fetch=originalFetch;}
