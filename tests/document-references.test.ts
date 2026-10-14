import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {documentTitleAliases,mergeReferencedEvidence} from '../lib/kernel/document-references.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import type {DocumentTextHit} from '../lib/kernel/document-search.ts';

after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});
test('title variants retain disambiguation and ignore unsafe short hints',()=>{
 assert.deepEqual(documentTitleAliases('Ed Wood (film).txt'),['ed wood film','ed wood']);
 assert.deepEqual(documentTitleAliases('A41 road.txt'),['a41 road','a41']);
 assert.deepEqual(documentTitleAliases('AI.txt'),[]);
});
test('reference merge stays bounded and preserves distinct evidence identities',()=>{
 const hit=(id:string)=>({document_id:id,page_number:1,source_version_id:`v-${id}`,evidence_id:`e-${id}`} as DocumentTextHit);
 const a=hit('person'),b=hit('film');
 const result=mergeReferencedEvidence([a],[b],[a,b],2);
 assert.equal(result.length,2);assert.deepEqual(result.map(hit=>hit.evidence_id),['e-film','e-person']);
});
test('linked names find current same-course evidence without merging names or leaking another owner',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const pool=kernelPool(),tag=randomUUID(),owner=`reference-${tag}`,course=`course-${tag}`;
 await kernel.upsertCourse({id:course,course_code:'REFT',name:'Reference course',enabled:true},'canvas');
 const ingest=async(id:string,name:string,body:string,who=owner,originKey=id)=>kernel.ingestParsedDocument({id,ownerId:who,courseId:course,name,
  hash:createHash('sha256').update(body).digest('hex'),mime:'text/plain',origin:'test',originKey},[{locator:'正文',text:body}],{parserVersion:'test'});
 const primary=`primary-${tag}`,target=`target-${tag}`,foreign=`foreign-${tag}`,hidden=`hidden-${tag}`;
 await ingest(primary,'Study Guide.txt','Course assignment guidance: see Revised Requirements for the required archive format.');
 await ingest(target,'Revised Requirements.txt','Use CSV for the course assignment; the prior handout format was superseded.');
 await ingest(foreign,'Revised Requirements.txt','Use a wrong format for the course assignment.','other-owner');
 await ingest(hidden,'Revised Requirements.txt','This obsolete hidden course assignment requires TXT.');
 await pool.query('UPDATE document_texts SET hidden=true WHERE id=$1',[hidden]);
 const hits=await kernel.searchDocumentText(owner,'What format does the course assignment require?',
  {courseId:course,relatedDocuments:true,limit:5,hybrid:false,semantic:false,aiRerank:false});
 assert.ok(hits.some(hit=>hit.document_id===target));assert.ok(hits.some(hit=>hit.document_id===primary));
 assert.ok(hits.every(hit=>![foreign,hidden].includes(hit.document_id)&&hit.evidence_id&&hit.source_version_id));
 assert.equal((await pool.query('SELECT count(*) n FROM facts WHERE attribute!=\'course_payload\'')).rows[0].n,'0');
 assert.equal((await kernel.searchDocumentText(owner,'Revised Requirements',{courseId:'wrong-course',relatedDocuments:true,limit:5})).length,0);
 const newer=`newer-${tag}`;
 await ingest(newer,'Revised Requirements.txt','The course assignment now requires JSON.',owner,target);
 const refreshed=await kernel.searchDocumentText(owner,'Revised Requirements',{courseId:course,relatedDocuments:true,limit:5});
 assert.ok(refreshed.some(hit=>hit.document_id===newer));assert.ok(refreshed.every(hit=>hit.document_id!==target));
 const short=`short-${tag}`,ordinary=`ordinary-${tag}`;
 await ingest(short,'Beryl.txt','Use sapphire glass for the experiment.');
 await ingest(ordinary,'History (band).txt','The music group released an album.');
 const explicit=await kernel.searchDocumentText(owner,'Which material does Beryl require?',{courseId:course,relatedDocuments:true,limit:5});
 assert.ok(explicit.some(hit=>hit.document_id===short));
 const general=await kernel.searchDocumentText(owner,'What is the history of the experiment?',{courseId:course,relatedDocuments:true,limit:5});
 assert.ok(general.every(hit=>hit.document_id!==ordinary));
});
