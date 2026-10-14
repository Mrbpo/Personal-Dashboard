import test from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import type {DocumentTextHit} from '../lib/kernel/document-search.ts';
import {buildHybridDocumentCandidates,fuseIndependentDocumentRanks} from '../lib/kernel/document-vector.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {kernel} from '../lib/kernel/service.ts';
import {randomUUID} from 'node:crypto';

const hit=(document:string,page=1,version='source-'+document):DocumentTextHit=>({id:document+':'+page,document_id:document,
 course_id:'course',name:document+'.pdf',origin:'upload',origin_key:document,source_hash:'hash-'+document,
 body:'Original page '+page,locator:'第 '+page+' 页',page_number:page,evidence_id:'evidence-'+document+'-'+page,
 source_version_id:version,parser_version:'test',score:1});
class AdjacentPool {
 calls=0;
 pages:(DocumentTextHit&{owner:string})[];
 constructor(pages:(DocumentTextHit&{owner:string})[]=[]){this.pages=pages;}
 pool(){return this as unknown as Pool;}
 async query(sql:string,args:unknown[]){
  this.calls++;assert.ok(sql.includes('vector:adjacent-evidence'));
  assert.match(sql,/d\.owner_id=\$1/);assert.match(sql,/v\.id=d\.current_version_id/);
  assert.match(sql,/e\.source_version_id=v\.source_version_id/);
  const anchors=JSON.parse(String(args[1])) as {document_id:string;page_number:number;source_version_id:string;anchor_number:number}[];
  const rows=anchors.flatMap(anchor=>this.pages.filter(page=>page.owner===args[0]&&page.document_id===anchor.document_id&&
   page.source_version_id===anchor.source_version_id&&Math.abs(page.page_number-anchor.page_number)===1&&page.page_number>=1)
   .map(page=>({...page,anchor_number:anchor.anchor_number})));
  return {rows,rowCount:rows.length};
 }
}

test('hybrid candidates retain lexical-only and dense-only heads that plain RRF truncation drops',async()=>{
 const shared=Array.from({length:50},(_,index)=>hit('shared-'+index));
 const lexical=[hit('lexical-only'),...shared],dense=[hit('dense-only'),...shared];
 const fused=fuseIndependentDocumentRanks(lexical,dense,40);
 assert.ok(!fused.some(hit=>hit.document_id==='lexical-only'));
 assert.ok(!fused.some(hit=>hit.document_id==='dense-only'));
 const pool=new AdjacentPool(),candidates=await buildHybridDocumentCandidates(pool.pool(),'owner',lexical,dense);
 assert.equal(candidates.length,40);
 assert.ok(candidates.some(hit=>hit.document_id==='lexical-only'));
 assert.ok(candidates.some(hit=>hit.document_id==='dense-only'));
 for(const head of [...lexical.slice(0,20),...dense.slice(0,20)])
  assert.ok(candidates.some(hit=>hit.document_id===head.document_id&&hit.page_number===head.page_number));
});

test('hybrid page-boundary candidates use real adjacent evidence and reject foreign owners and old versions',async()=>{
 const anchor=hit('lesson',3),other=hit('different-file');
 const previous=hit('lesson',2),next=hit('lesson',4);
 const pool=new AdjacentPool([{...previous,owner:'owner'},{...next,owner:'owner'},
  {...hit('lesson',4,'old-source'),owner:'owner'}, {...hit('lesson',4),owner:'foreign-owner'}]);
 const candidates=await buildHybridDocumentCandidates(pool.pool(),'owner',[anchor,other],[anchor,other]);
 const boundary=candidates.find(hit=>hit.document_id==='lesson'&&hit.page_number===4)!;
 assert.equal(boundary.evidence_id,next.evidence_id);assert.equal(boundary.source_version_id,next.source_version_id);
 assert.equal(boundary.body,next.body,'context is not fabricated or copied into a different page');
 assert.equal(candidates.filter(hit=>hit.document_id==='lesson'&&hit.page_number===4).length,1);
 assert.ok(candidates.some(hit=>hit.page_number===2&&hit.document_id==='lesson'));
 assert.equal(pool.calls,1);
 await assert.rejects(buildHybridDocumentCandidates(pool.pool(),'owner',[anchor],[{...anchor,source_version_id:'different-source'}]),/versions conflict/);
});

test('fully disjoint modality heads fill the fixed 40-page pool without an additional neighborhood query',async()=>{
 const lexical=Array.from({length:20},(_,index)=>hit('words-'+index));
 const dense=Array.from({length:20},(_,index)=>hit('meaning-'+index));
 const pool=new AdjacentPool(),candidates=await buildHybridDocumentCandidates(pool.pool(),'owner',lexical,dense);
 assert.equal(candidates.length,40);assert.equal(pool.calls,0);
 assert.equal(new Set(candidates.map(hit=>hit.document_id)).size,40);
});

test('neighbor candidates load actual current PostgreSQL evidence across a page boundary',async()=>{
 await migrateKernel();
 const tag=randomUUID(),owner='neighbor-owner-'+tag,id='neighbor-document-'+tag;
 const document={id,ownerId:owner,courseId:'',name:'A learning handout.pdf',hash:tag,mime:'application/pdf',origin:'upload',originKey:id};
 await kernel.ingestParsedDocument(document,[{pageNumber:1,locator:'Page 1',text:'An introduction to interval tree optimization.'},
  {pageNumber:2,locator:'Page 2',text:'The recurrence increases every child depth by one, adding interval weight.'}],
  {parserVersion:'neighbor-before',expectedPages:2});
 const seed=(await kernel.searchDocumentText(owner,'interval tree optimization',{limit:1,strict:true}))[0];
 const candidates=await buildHybridDocumentCandidates(kernelPool(),owner,[seed],[seed]);
 const next=candidates.find(hit=>hit.page_number===2)!;
 const actual=(await kernelPool().query(`SELECT p.evidence_id,p.body FROM document_texts d
  JOIN document_text_pages p ON p.version_id=d.current_version_id
  WHERE d.owner_id=$1 AND d.id=$2 AND p.page_number=2`,[owner,id])).rows[0];
 assert.equal(next.evidence_id,actual.evidence_id);assert.equal(next.source_version_id,seed.source_version_id);
 assert.equal(next.body,actual.body);assert.equal(next.locator,'Page 2');
 assert.ok(!candidates.some(hit=>hit.page_number===0||hit.page_number===3));
 const foreign=await buildHybridDocumentCandidates(kernelPool(),'foreign-owner',[seed],[seed]);
 assert.equal(foreign.length,1,'an owner mismatch must not attach neighboring evidence');
 assert.equal(foreign[0].evidence_id,seed.evidence_id);
 await kernel.ingestParsedDocument(document,[{pageNumber:1,locator:'Page 1',text:'Current replacement introduction.'}],
  {parserVersion:'neighbor-after',expectedPages:1});
 const stale=await buildHybridDocumentCandidates(kernelPool(),owner,[seed],[seed]);
 assert.equal(stale.length,1,'stale seeds must not attach pages from the new version');
 assert.equal(stale[0].source_version_id,seed.source_version_id);
});
