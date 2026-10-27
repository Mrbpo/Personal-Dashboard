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
 const excludedArgs:unknown[]=[];
 assert.match(documentRoutingScopeSql({excludedCourseIds:["B'bad"]},excludedArgs),/d\.course_id IS NULL OR NOT\(d\.course_id=ANY\(\$1::text\[\]\)\)/);
 assert.deepEqual(excludedArgs,[["B'bad"]]);assert.notEqual(documentRoutingScopeSql({excludedCourseIds:[]},[]),'AND FALSE');
 assert.equal(documentRoutingScopeSql({courseIds:[],excludedCourseIds:[]},[]),'AND FALSE');
 for(const bad of [null,[],{topic:['algebra']},{origins:'canvas'},{courseIds:['']},{documentIds:['bad\0id']},{termIds:Array(257).fill('x')}])
  assert.throws(()=>normalizeDocumentRoutingScope(bad));
 await assertDocumentRoutingScope({query:()=>{throw Error('Legacy must not add a query');}} as unknown as Pool,'owner',['doc'],{});
});

test('course exclusions reduce candidate reads while retaining unassigned and unmapped supplemental sources',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const pool=kernelPool(),uid=randomUUID(),owner='course-unknown:'+uid,a='chosen:'+uid,b='other:'+uid,c='uncatalogued:'+uid;
 for(const id of[a,b,c])await kernel.upsertCourse({id,name:id,course_code:id});
 const docs=[{id:'chosen-doc:'+uid,courseId:a,origin:'canvas',name:'Selected Guide.txt',text:'Nebula laboratory. See Unknown Discussion for clarification.'},
  {id:'other-doc:'+uid,courseId:b,origin:'canvas',name:'Selected Guide.txt',text:'Nebula laboratory in another course.'},
  {id:'unknown-doc:'+uid,courseId:'',origin:'piazza',name:'Unknown Discussion.txt',text:'Unassigned clarification from the instructor.'},
  {id:'unmapped-doc:'+uid,courseId:c,origin:'gmail',name:'Uncatalogued Mail.txt',text:'Nebula laboratory in an uncatalogued source.'}];
 const add=async(d:typeof docs[number],who=owner)=>kernel.ingestParsedDocument({id:d.id,ownerId:who,courseId:d.courseId,origin:d.origin,name:d.name,
  originKey:d.id,hash:hash(d.text),mime:'text/plain'},[{locator:'body',text:d.text}],{parserVersion:'unknown-course-plain-text-v1',extractionMethod:'plain-text'});
 for(const d of docs)await add(d);
 await add({...docs[0],id:'foreign:'+uid},'foreign:'+uid);
 await add({...docs[0],id:'hidden:'+uid});await pool.query('UPDATE document_texts SET hidden=true WHERE id=$1',['hidden:'+uid]);
 const routingScope={excludedCourseIds:[b]},base={semantic:false,hybrid:false,aiRerank:false,refineAdjacent:false,limit:14};
 assert.deepEqual(await kernel.documentRoutingCounts(owner,{routingScope}),{eligibleDocuments:4,routedDocuments:3,eligiblePages:4,routedPages:3});
 const lexical=await kernel.searchDocumentText(owner,'nebula',{...base,routingScope});
 assert.deepEqual(new Set(lexical.map(h=>h.document_id)),new Set([docs[0].id,docs[3].id]));
 const linked=await kernel.searchDocumentText(owner,'nebula',{...base,relatedDocuments:true,routingScope,evidenceBody:'full-page'});
 assert.ok(linked.some(h=>h.document_id===docs[2].id),'unknown Piazza supplement stays available under the original scope');
 assert.ok(linked.every(h=>h.document_id!==docs[1].id&&h.evidence_body==='full-page'));
 const selected=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'Selected Guide.txt'},{routingScope});
 assert.equal(selected.status,'resolved');if(selected.status==='resolved')assert.equal(selected.document.documentId,docs[0].id);
 assert.equal((await findMentionedDocumentSources(pool,owner,'Explain Selected Guide.txt',{routingScope})).status,'resolved');
 assert.deepEqual(await kernel.searchDocumentText(owner,'nebula',{...base,routingScope:{...routingScope,courseIds:[b]}}),[]);
 assert.deepEqual((await kernel.searchDocumentText(owner,'nebula',{...base,routingScope:{...routingScope,origins:['canvas']}})).map(h=>h.document_id),[docs[0].id]);
 const vector=Array.from({length:DOCUMENT_EMBEDDING_DIMENSIONS},(_,i)=>i===0?1:0),pages=(await pool.query(
  'SELECT p.version_id,p.page_number,p.body FROM document_texts d JOIN document_text_pages p ON p.version_id=d.current_version_id WHERE d.owner_id=$1 AND NOT d.hidden',[owner])).rows;
 for(const p of pages)await pool.query(`INSERT INTO document_page_embeddings(owner_id,version_id,page_number,model,input_hash,embedding)
  VALUES($1,$2,$3,$4,$5,$6::double precision[])`,[owner,p.version_id,p.page_number,DOCUMENT_EMBEDDING_MODEL,documentVectorInput(p.body).inputHash,vector]);
 const dense=await searchDocumentVectorText(pool,owner,vector,{routingScope});
 assert.equal(dense.coverage.complete,true);assert.equal(dense.coverage.totalPages,3);
 assert.deepEqual(new Set(dense.hits.map(h=>h.document_id)),new Set([docs[0].id,docs[2].id,docs[3].id]));
 await assert.rejects(assertDocumentRoutingScope(pool,owner,[docs[1].id],{routingScope}),/left the explicit routing scope/);
 await pool.query('UPDATE document_texts SET course_id=$1 WHERE id=$2',[b,docs[2].id]);
 await assert.rejects(assertDocumentRoutingScope(pool,owner,[docs[2].id],{routingScope}),/left the explicit routing scope/);
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
 assert.equal(await kernel.hasUnmappedCourseDocuments(owner,[a,b]),false,'foreign and hidden sources do not broaden this owner');
 assert.equal(await kernel.hasUnmappedCourseDocuments(owner,[a]),true,'an unmapped/disabled catalog association keeps broad retrieval');
 await ingest({...docs[0],id:`unassigned:${uid}`,courseId:''});
 assert.equal(await kernel.hasUnmappedCourseDocuments(owner,[a,b]),true,'an unassigned upload must not be silently excluded');
 await pool.query('UPDATE document_texts SET hidden=true WHERE id=$1',[`unassigned:${uid}`]);
 assert.equal(await kernel.hasUnmappedCourseDocuments(owner,[a,b]),false);
 assert.equal(await kernel.hasUnmappedCourseDocuments(`empty:${uid}`,[a,b]),false);
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
