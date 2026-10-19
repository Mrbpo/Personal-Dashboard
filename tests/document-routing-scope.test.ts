import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {normalizeDocumentRoutingScope,documentRoutingScopeSql,assertDocumentRoutingScope} from '../lib/kernel/document-routing-scope.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {documentVectorInput,documentVectorCoverage,searchDocumentVectorText} from '../lib/kernel/document-vector.ts';
import {DOCUMENT_EMBEDDING_MODEL,DOCUMENT_EMBEDDING_DIMENSIONS} from '../lib/kernel/document-semantic.ts';
import type {Pool} from 'pg';
import {findMentionedDocumentSources} from '../lib/kernel/document-source.ts';

let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw Error('Routing scope tests forbid provider calls');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

test('explicit scope is bounded, immutable, parameterized and keeps empty sets closed',async()=>{
 const input={courseIds:['A','A'],origins:["x'); DROP TABLE courses; --"]},scope=normalizeDocumentRoutingScope(input)!;
 input.courseIds.push('B');assert.deepEqual(scope.courseIds,['A']);assert.ok(Object.isFrozen(scope.origins));
 const args:unknown[]=['owner'],sql=documentRoutingScopeSql(scope,args);
 assert.ok(!sql.includes('DROP'));assert.deepEqual(args,['owner',['A'],input.origins]);assert.match(sql,/d\.origin=ANY\(\$3::text\[\]\)/u);
 assert.equal(documentRoutingScopeSql({courseIds:[]},[]),'AND FALSE');
 assert.equal(documentRoutingScopeSql(undefined,[]),'');
 for(const bad of [null,[],{topic:['algebra']},{origins:'canvas'},{courseIds:['']},{documentIds:['bad\0id']},{termIds:Array(257).fill('x')}])
  assert.throws(()=>normalizeDocumentRoutingScope(bad));
 await assertDocumentRoutingScope({query:()=>{throw Error('Legacy must not add a query');}} as unknown as Pool,'owner',['doc'],{});
});

test('keyword/dense/title/linked fallback share explicit intersections and candidate counts',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const pool=kernelPool(),uid=randomUUID(),owner=`route:${uid}`,a=`course-a:${uid}`,b=`course-b:${uid}`,
  fall=`term:fall-${uid}`,spring=`term:spring-${uid}`;
 await kernel.upsertCourse({id:a,name:'First course',course_code:'COURSEA',term:{id:`fall-${uid}`,name:'Fall'}});
 await kernel.upsertCourse({id:b,name:'Second course',course_code:'COURSEB',term:{id:`spring-${uid}`,name:'Spring'}});
 const ids=[`primary:${uid}`,`notes:${uid}`,`second:${uid}`,`upload:${uid}`],
  docs=[{id:ids[0],courseId:a,origin:'canvas',name:'Primary Guide.txt',text:'Nebula protocol: see Revised Notes for corrections.'},
   {id:ids[1],courseId:a,origin:'piazza',name:'Revised Notes.txt',text:'Nebula protocol correction from discussion.'},
   {id:ids[2],courseId:b,origin:'canvas',name:'Primary Guide.txt',text:'Nebula protocol in the second course.'},
   {id:ids[3],courseId:b,origin:'upload',name:'Other Reading.txt',text:'Nebula protocol supplementary reading.'}];
 const ingest=async(d:typeof docs[number],who=owner)=>kernel.ingestParsedDocument({id:d.id,ownerId:who,courseId:d.courseId,origin:d.origin,
  name:d.name,originKey:d.id,hash:hash(d.text),mime:'text/plain'},[{locator:'body',text:d.text}],{parserVersion:'scope-fixture'});
 for(const d of docs)await ingest(d);
 await ingest({...docs[0],id:`foreign:${uid}`},`foreign:${uid}`);
 await ingest({...docs[0],id:`hidden:${uid}`});await pool.query('UPDATE document_texts SET hidden=true WHERE id=$1',[`hidden:${uid}`]);
 const routingScope={courseIds:[a],origins:['canvas'],termIds:[fall]},base={semantic:false,aiRerank:false,hybrid:false,limit:14};
 assert.deepEqual(await kernel.documentRoutingCounts(owner,{routingScope}),{eligibleDocuments:4,routedDocuments:1,eligiblePages:4,routedPages:1});
 const lexical=await kernel.searchDocumentText(owner,'nebula',{...base,routingScope});assert.deepEqual(lexical.map(h=>h.document_id),[ids[0]]);
 assert.deepEqual(new Set((await kernel.searchDocumentText(owner,'nebula',{...base,routingScope:{courseIds:[a,b],origins:['canvas']}})).map(h=>h.document_id)),new Set([ids[0],ids[2]]));
 for(const routingScope of [{courseIds:[]},{courseIds:[b],termIds:[fall]},{documentIds:[]}])
  assert.deepEqual(await kernel.searchDocumentText(owner,'nebula',{...base,routingScope}),[]);
 assert.deepEqual(await kernel.searchDocumentText(owner,'nebula',{...base,courseId:a,routingScope:{courseIds:[b]}}),[]);
 assert.equal((await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'Primary Guide.txt'})).status,'ambiguous');
 const resolved=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'Primary Guide.txt'},{routingScope});
 assert.equal(resolved.status,'resolved');if(resolved.status==='resolved')assert.equal(resolved.document.documentId,ids[0]);
 assert.equal((await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'Primary Guide.txt'},{routingScope:{origins:['upload']}})).status,'not-found');
 assert.equal((await findMentionedDocumentSources(pool,owner,'Explain Primary Guide.txt nebula',{routingScope})).status,'resolved');
 assert.deepEqual((await findMentionedDocumentSources(pool,owner,'Explain Primary Guide.txt nebula',{routingScope:{origins:['upload']}})).matches,[]);
 const linked=await kernel.searchDocumentText(owner,'Primary Guide nebula',{...base,relatedDocuments:true,routingScope});
 assert.deepEqual(linked.map(h=>h.document_id),[ids[0]],'linked Piazza evidence cannot bypass an explicit Canvas-only choice');
 assert.ok((await kernel.searchDocumentText(owner,'Primary Guide nebula',{...base,relatedDocuments:true,courseId:a})).some(h=>h.document_id===ids[1]),'ordinary multi-source recall is retained');
 // Seed synthetic unit vectors in this isolated test schema; no embedding API.
 const vector=Array.from({length:DOCUMENT_EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0),pages=(await pool.query(
  `SELECT p.version_id,p.page_number,p.body FROM document_texts d JOIN document_text_pages p ON p.version_id=d.current_version_id WHERE d.owner_id=$1 AND NOT d.hidden`,[owner])).rows;
 for(const p of pages)await pool.query(`INSERT INTO document_page_embeddings(owner_id,version_id,page_number,model,input_hash,embedding)
  VALUES($1,$2,$3,$4,$5,$6::double precision[])`,[owner,p.version_id,p.page_number,DOCUMENT_EMBEDDING_MODEL,documentVectorInput(p.body).inputHash,vector]);
 await pool.query(`INSERT INTO document_query_embeddings(owner_id,query_hash,model,embedding) VALUES($1,$2,$3,$4::double precision[])`,
  [owner,hash('nebula'),DOCUMENT_EMBEDDING_MODEL,vector]);
 assert.equal((await kernel.documentVectorCoverage(owner,{routingScope})).totalPages,1);
 const dense=await searchDocumentVectorText(pool,owner,vector,{routingScope});assert.equal(dense.coverage.complete,true);
 assert.deepEqual(dense.hits.map(h=>h.document_id),lexical.map(h=>h.document_id));
 assert.equal((await documentVectorCoverage(pool,owner,{routingScope:{documentIds:[]}})).totalPages,0);
 const hybrid=await kernel.searchDocumentText(owner,'nebula',{...base,hybrid:true,routingScope});assert.deepEqual(hybrid.map(h=>h.document_id),[ids[0]]);
 await pool.query('DELETE FROM document_page_embeddings WHERE owner_id=$1 AND version_id=$2',[owner,pages.find(p=>p.body===docs[0].text)!.version_id]);
 const fallback=await kernel.searchDocumentText(owner,'nebula',{...base,hybrid:true,routingScope});
 assert.deepEqual(fallback.map(h=>h.document_id),[ids[0]]);assert.ok(fallback.every(h=>h.retrieval_mode==='keyword-fallback'));
 await assert.rejects(assertDocumentRoutingScope(pool,owner,[ids[1]],{routingScope}),/left the explicit routing scope/);
 await pool.query('UPDATE courses SET term_id=$1 WHERE id=$2',[spring,a]);
 await assert.rejects(assertDocumentRoutingScope(pool,owner,[ids[0]],{routingScope}),/left the explicit routing scope/);
});
