// Synthetic benchmark only: node --experimental-strip-types scripts/benchmark-vector-options.ts
// No network, production data, or paid embedding calls.
export {};
process.env.DATABASE_URL=':memory:';
const {database:db}=await import('../lib/database.ts');
const {EMBED_MODEL,cosine}=await import('../lib/library.ts');
const {MAIL_EMBED_VERSION}=await import('../lib/mail-embedding.ts');
await db.prepare('SELECT 1').first();

const count=500,dimensions=768,account='benchmark@example.invalid';
const vector=JSON.stringify(Array.from({length:dimensions},(_,i)=>Math.sin(i+1)/Math.sqrt(dimensions)));
for(let start=0;start<count;start+=100){
  const statements=[];
  for(let i=start;i<Math.min(count,start+100);i++){
    const id=`mail-${String(i).padStart(4,'0')}`,hash=`hash-${i}`;
    statements.push(db.prepare('INSERT INTO mail_messages(id,account,thread_id,subject,sender,body,received_at,category,attachments_json,hash) VALUES(?,?,?,?,?,?,?,?,?,?)').bind(id,account,id,`Benchmark ${i}`,'sender@example.invalid','Synthetic material',new Date(Date.UTC(2026,0,1,i)).toISOString(),'学习','[]',hash));
    statements.push(db.prepare('INSERT INTO mail_embeddings VALUES(?,?,?,?,?)').bind(id,EMBED_MODEL,MAIL_EMBED_VERSION+hash,vector,'now'));
  }
  await db.batch(statements);
}

const recentIds=Array.from({length:300},(_,i)=>`mail-${String(count-1-i).padStart(4,'0')}`);
const lexicalIds=Array.from({length:400},(_,i)=>`mail-${String(i+50).padStart(4,'0')}`);
const recentSet=new Set(recentIds),missingIds=lexicalIds.filter(id=>!recentSet.has(id));
async function fetchVectors(ids:string[]){
  if(!ids.length)return [] as {email_id:string;vector:string}[];
  return (await db.prepare(`SELECT email_id,vector FROM mail_embeddings WHERE email_id IN (${ids.map(()=>'?').join(',')})`).bind(...ids).all<{email_id:string;vector:string}>()).results;
}
async function measure(optimized:boolean){
  const started=performance.now();
  const recent=await fetchVectors(recentIds);
  const lexical=await fetchVectors(optimized?missingIds:lexicalIds);
  const mapped=new Map([...recent,...lexical].map(row=>[row.email_id,row.vector]));
  for(const id of lexicalIds){const stored=mapped.get(id);if(stored)cosine(JSON.parse(vector),JSON.parse(stored));}
  return {ms:performance.now()-started,bytes:[...recent,...lexical].reduce((sum,row)=>sum+Buffer.byteLength(row.vector),0),rows:recent.length+lexical.length,entries:[...mapped.entries()].sort(([a],[b])=>a.localeCompare(b))};
}
await measure(false);await measure(true);
const before=[],after=[];
for(let i=0;i<9;i++){before.push(await measure(false));after.push(await measure(true));}
if(JSON.stringify(before[0].entries)!==JSON.stringify(after[0].entries))throw Error('Candidate/vector parity failed');
function median(values:number[]){return Number([...values].sort((a,b)=>a-b)[Math.floor(values.length/2)].toFixed(2));}
const encodedBytes=Buffer.byteLength(vector),floatBytes=dimensions*Float32Array.BYTES_PER_ELEMENT;
// Tiny, hand-labeled retrieval fixture. It illustrates lexical misses, not model quality.
const fixture=[
  {id:'lab-a',title:'Lab requirements',body:'Lab instructions: bring goggles.',relevant:['lab']},
  {id:'lab-b',title:'Laboratory safety',body:'Bring safety glasses to experiment two.',relevant:['lab']},
  {id:'mail-a',title:'Homework due Friday',body:'Homework is due Friday. Please submit your work.',relevant:['homework']},
  {id:'mail-b',title:'Assignment deadline',body:'Submit work on Friday.',relevant:['homework']},
  {id:'other',title:'Campus parking',body:'Parking lot map.',relevant:[]},
];
for(const row of fixture){
  await db.prepare("INSERT INTO library_documents(id,owner_id,course_id,origin,origin_key,name,mime,hash,size,status,created_at) VALUES(?,?,?,'upload',?,?,'text/plain',?,1,'ready','now')").bind(row.id,'bench','chem',row.id,row.title,row.id).run();
  await db.prepare('INSERT INTO library_chunks VALUES(?,?,?,?,?,?)').bind(`${row.id}:0`,row.id,0,'body',row.body,row.id).run();
}
await db.prepare("INSERT INTO library_chunks_fts(library_chunks_fts) VALUES('rebuild')").run();
const labels=[{query:'lab',term:'lab',label:'lab'},{query:'homework',term:'homework',label:'homework'}];
const recall=[];
for(const item of labels){
  const candidates=(await db.prepare('SELECT c.document_id FROM library_chunks_fts f JOIN library_chunks c ON c.rowid=f.rowid JOIN library_documents d ON d.id=c.document_id WHERE library_chunks_fts MATCH ? AND d.owner_id=?').bind(`"${item.term}"`,'bench').all<{document_id:string}>()).results;
  const relevant=fixture.filter(row=>row.relevant.includes(item.label));
  recall.push({query:item.query,relevant:relevant.length,ftsFound:candidates.filter(row=>relevant.some(hit=>hit.id===row.document_id)).length,fullScanFound:relevant.length});
}
console.log(JSON.stringify({synthetic:true,mails:count,recent:recentIds.length,lexical:lexicalIds.length,overlap:lexicalIds.length-missingIds.length,baseline:{medianMs:median(before.map(row=>row.ms)),rows:before[0].rows,bytes:before[0].bytes},deduplicated:{medianMs:median(after.map(row=>row.ms)),rows:after[0].rows,bytes:after[0].bytes},candidateAndVectorParity:true,vectorEncoding:{jsonBytesPerVector:encodedBytes,float32BytesPerVector:floatBytes},illustrativeRecall:recall},null,2));
