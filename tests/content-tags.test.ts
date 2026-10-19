import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {classifyContentMetadata,contentTagIngestionEnabled,recordContentMetadataTags} from '../lib/kernel/content-tags.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,kernelTransaction,migrateKernel} from '../lib/kernel/db.ts';

let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw Error('Tag metadata tests forbid external requests');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

test('metadata identity and multiple soft categories do not turn a filename into course truth',()=>{
 const input={courseId:'CHEM-101',termId:'term:fall',origin:'gmail',originKey:'account/message/body',
  name:'MATH Lecture Notes and Syllabus.pdf',mime:'application/pdf'},before=structuredClone(input),r=classifyContentMetadata(input);
 assert.deepEqual(input,before);assert.equal(r.filterAuthorization,false);assert.equal(r.semanticVerified,false);
 assert.deepEqual(r.tags.filter(t=>t.facet==='course').map(t=>[t.key,t.method,t.routingUse]),[['CHEM-101','metadata-observation','identity-only']]);
 assert.deepEqual(r.tags.filter(t=>t.facet==='document_type').map(t=>t.key),['lecture-notes','syllabus']);
 assert.ok(r.tags.filter(t=>t.facet==='document_type').every(t=>t.routingUse==='soft-only'&&t.confidence<1));
 assert.deepEqual(r.unknownFacets,['topic','chapter','assignment']);
 assert.equal(r.tags.some(t=>t.key==='MATH'),false);assert.equal(r.coverage,'source-metadata-only');
 assert.equal(classifyContentMetadata({...input,mime:'text/plain'}).tags.find(t=>t.facet==='course')?.id,r.tags.find(t=>t.facet==='course')?.id);
});

test('unknowns and replay identities are explicit; off is retained and invalid configuration fails',()=>{
 const input={courseId:null,termId:null,origin:'publisher',originKey:'reference',name:'untitled',mime:'application/octet-stream'},
  r=classifyContentMetadata(input),reordered=classifyContentMetadata({mime:input.mime,name:input.name,originKey:input.originKey,
   origin:input.origin,termId:input.termId,courseId:input.courseId});
 assert.deepEqual(r,reordered);assert.deepEqual(r.tags.map(t=>[t.facet,t.key]),[['source','other']]);
 assert.deepEqual(r.unknownFacets,['course','term','format','document_type','topic','chapter','assignment']);
 assert.throws(()=>classifyContentMetadata({...input,origin:'bad\0source'}));
 const previous=process.env.KERNEL_CONTENT_TAGS;
 try{
  delete process.env.KERNEL_CONTENT_TAGS;assert.equal(contentTagIngestionEnabled(),false);
  process.env.KERNEL_CONTENT_TAGS='metadata-v1';assert.equal(contentTagIngestionEnabled(),true);
  process.env.KERNEL_CONTENT_TAGS='true';assert.throws(contentTagIngestionEnabled,/Invalid KERNEL_CONTENT_TAGS/);
 }finally{if(previous===undefined)delete process.env.KERNEL_CONTENT_TAGS;else process.env.KERNEL_CONTENT_TAGS=previous;}
});

test('Kernel ingestion tags are idempotent, source/version/owner bound, historical and transactional',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner=`tag-owner:${uid}`,course=`tag-course:${uid}`,id=`tag-document:${uid}`,
  previous=process.env.KERNEL_CONTENT_TAGS;
 try{
  process.env.KERNEL_CONTENT_TAGS='metadata-v1';
  await kernel.upsertCourse({id:course,name:'Test Chemistry',course_code:'CHEM',term:{id:uid,name:'Test Fall'}});
  const doc={id,ownerId:owner,courseId:course,name:'Syllabus.pdf',hash:hash(uid),mime:'application/pdf',origin:'canvas',originKey:'file:7'},
   pages=[{locator:'page 1',text:'Original supplied text. Course requirements.',pageNumber:1}];
  await kernel.ingestParsedDocument(doc,pages,{parserVersion:'tag-fixture'});
  const first=(await kernel.documentMetadataTags(owner,id))[0];assert.ok(first);
  assert.equal(first.taxonomy_version,'academic-content-tags-v1');assert.equal(first.filter_authorization,false);
  assert.ok(first.tags.some((t:{facet:string;key:string})=>t.facet==='course'&&t.key===course));
  // Replaying the same source version uses its original metadata, even if the
  // library display title changes. A display rename is not a new source fact.
  await kernel.ingestParsedDocument({...doc,name:'renamed.pdf'},pages,{parserVersion:'tag-fixture'});
  assert.deepEqual((await kernel.documentMetadataTags(owner,id)).map(t=>t.id),[first.id]);
  assert.equal((await kernel.documentMetadataTags('foreign-owner',id)).length,0);
  await assert.rejects(kernelTransaction(client=>recordContentMetadataTags(client,'foreign-owner',id,first.version_id)),/current owned document/);
  await kernel.ingestParsedDocument(doc,[{...pages[0],text:'Repaired source transcription, with history preserved.'}],{parserVersion:'tag-fixture'});
  const current=(await kernel.documentMetadataTags(owner,id))[0];assert.notEqual(current.version_id,first.version_id);
  assert.equal((await kernelPool().query('SELECT count(*)::int n FROM document_tag_sets WHERE document_id=$1',[id])).rows[0].n,2);
  await assert.rejects(kernelTransaction(client=>recordContentMetadataTags(client,owner,id,first.version_id)),/current owned document/);
  await assert.rejects(kernelTransaction(async client=>{
   await client.query('INSERT INTO academic_terms(id,name) VALUES($1,$2)',[`tag-rollback:${uid}`,'Temporary term']);
   await client.query('UPDATE courses SET term_id=$1 WHERE id=$2',[`tag-rollback:${uid}`,course]);
   const pending=await recordContentMetadataTags(client,owner,id,current.version_id);assert.notEqual(pending.id,current.id);
   throw Error('Deliberate test rollback');
  }),/Deliberate test rollback/);
  assert.equal((await kernelPool().query('SELECT count(*)::int n FROM document_tag_sets WHERE document_id=$1',[id])).rows[0].n,2);
  assert.deepEqual((await kernel.documentMetadataTags(owner,id)).map(t=>t.id),[current.id]);
  // Composite FK rejects a cross-owner snapshot even outside KernelService.
  await assert.rejects(kernelPool().query(`INSERT INTO document_tag_sets SELECT $1,$2,document_id,version_id,source_version_id,source_hash,
   taxonomy_version,producer,input_sha256,classification_sha256,metadata,tags,unknown_facets,coverage,semantic_verified,filter_authorization,created_at
   FROM document_tag_sets WHERE id=$3`,[hash('foreign:'+uid),'foreign-owner',current.id]),{code:'23503'});
  const replacement={...doc,id:`${id}:replacement`,hash:hash('replacement:'+uid),createdAt:'2099-01-01T00:00:00Z'};
  await kernel.ingestParsedDocument(replacement,pages,{parserVersion:'tag-fixture'});
  assert.equal((await kernel.documentMetadataTags(owner,id)).length,0,'superseded logical sources cannot supply current tags');
  assert.equal((await kernel.documentMetadataTags(owner,replacement.id)).length,1);
 }finally{if(previous===undefined)delete process.env.KERNEL_CONTENT_TAGS;else process.env.KERNEL_CONTENT_TAGS=previous;}
});
