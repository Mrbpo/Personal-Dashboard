import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {DocumentContextError,readDocumentParents,type DocumentContextSource} from '../lib/kernel/document-context.ts';
import {prepareDocumentAnswer,synthesizeDocumentAnswer} from '../lib/kernel/document-answer.ts';

let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw new Error('Flat context fixture prohibits external calls');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const code=(expected:string)=>(error:unknown)=>error instanceof DocumentContextError&&error.code===expected;

test('actual PG mixed flat and registered text preserves exact nodes/provenance; strict readers and changed/complex sources stay guarded',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const owner='flat-context-'+randomUUID(),pool=kernelPool();
 const create=async(mime:string,parser:string,bodies:string[])=>{
  const id=randomUUID(),document={id,ownerId:owner,courseId:'',name:'Flat context '+id,hash:digest(JSON.stringify(bodies)),mime,origin:'flat-fixture',originKey:id};
  await kernel.ingestParsedDocument(document,bodies.map((text,index)=>({locator:'stored-node:'+index,text})),
   {parserVersion:parser,warnings:['Text fidelity is not independently verified.']});
  const resolved=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:document.name});assert.equal(resolved.status,'resolved');
  if(resolved.status!=='resolved')throw Error('Fixture unresolved');
  const source:DocumentContextSource={...resolved.document,courseId:''},nodes=(await kernel.readDocumentSourcePages(owner,source)).nodes;
  const hits=await kernel.readDocumentNodes(owner,source,nodes.map(node=>node.evidenceId));
  return {document,source,nodes,hits};
 };
 const flat=await create('text/plain','plain-text-native-v1',['First exact persisted text.',' \t\n']);
 const registered=await create('text/plain','native-json-v1',['Author section first original paragraph.','Author section second original paragraph.']);
 await kernel.registerDocumentStructure(owner,registered.source,{rawSourceHash:registered.source.sourceHash,parserVersion:'original-author-hierarchy-v1',
  parents:[{id:'author-section',heading:'Real supplied heading'}],nodes:registered.nodes.map((node,index)=>({evidenceId:node.evidenceId,locator:node.locator,
   ordinal:index,kind:'paragraph',parentId:'author-section',bodySha256:node.bodySha256}))});
 const saved=(await pool.query('SELECT manifest_sha256 FROM document_structures WHERE version_id=$1',[registered.source.currentVersionId])).rows[0].manifest_sha256;
 const before=(await pool.query('SELECT count(*) n FROM document_structures')).rows[0].n;
 const anchors=[flat.hits[0],registered.hits[1],flat.hits[1]],original=JSON.stringify(anchors);
 const context=await kernel.readDocumentParents(owner,anchors,{includeImages:true});
 assert.equal(JSON.stringify(anchors),original);assert.deepEqual(context.anchors,anchors);assert.deepEqual(context.images,[]);
 const derived=context.parents.filter(parent=>parent.structureProvenance),author=context.parents.find(parent=>parent.kind==='section')!;
 assert.equal(derived.length,2);assert.deepEqual(derived.map(parent=>parent.nodes[0].body),flat.nodes.map(node=>node.body));
 assert.ok(derived.every(parent=>parent.kind==='single-node'&&!parent.headingMetadata&&parent.nodes[0].kind==='paragraph'));
 for(const parent of derived)assert.deepEqual(parent.structureProvenance,{method:'flat-persisted-text-v1',manifestSha256:parent.manifestSha256,
  originalHierarchyVerified:false,originalFileCompletenessVerified:false});
 assert.deepEqual(author.nodes.map(node=>node.body),registered.nodes.map(node=>node.body));
 assert.equal(author.headingMetadata?.text,'Real supplied heading');assert.equal(author.structureProvenance,undefined);assert.equal(author.manifestSha256,saved);
 assert.equal((await pool.query('SELECT count(*) n FROM document_structures')).rows[0].n,before,'flat reads do not persist a structure');
 assert.equal((await pool.query('SELECT count(*) n FROM document_structures WHERE version_id=$1',[flat.source.currentVersionId])).rows[0].n,'0');
 const prepared=prepareDocumentAnswer('Read the stored text',context);
 assert.deepEqual(prepared.warnings,['Text fidelity is not independently verified.']);
 assert.equal(prepared.input.parentMetadata.filter(parent=>parent.structureProvenance).length,2);
 const without=structuredClone(context);for(const parent of without.parents)delete parent.structureProvenance;
 assert.notEqual(prepared.fingerprint,prepareDocumentAnswer('Read the stored text',without).fingerprint);
 assert.equal(prepared.fingerprint,prepareDocumentAnswer('Read the stored text',await kernel.readDocumentParents(owner,anchors,{includeImages:true})).fingerprint);
 // A genuine blank stored node reaches the ordinary no-selectable-text receipt
 // without a mock provider or any paid call, and retains the flat provenance.
 const receipt=await synthesizeDocumentAnswer('Read this blank node',()=>kernel.readDocumentParents(owner,[flat.hits[1]]));
 assert.equal(receipt.answer.status,'insufficient-evidence');assert.equal(receipt.model,null);
 assert.equal(receipt.flatTextContexts?.length,1);assert.equal(receipt.flatTextContexts?.[0].structureProvenance?.originalHierarchyVerified,false);
 assert.equal(receipt.flatTextContexts?.[0].structureProvenance?.originalFileCompletenessVerified,false);
 await assert.rejects(kernel.readDocumentOutline(owner,flat.source),code('DOCUMENT_STRUCTURE_UNAVAILABLE'));
 const complete=await kernel.readCompleteDocumentSource(owner,flat.source);assert.equal(complete.status,'unavailable');
 if(complete.status==='unavailable'){assert.equal(complete.reason,'structure-unavailable');assert.equal(complete.manifest.complete,false);}
 for(const [mime,parser]of [['application/pdf','plain-text-v1'],['text/plain','pdf-ocr-text-v1'],['text/html','native-text-v1'],['text/plain','unknown-v1']]){
  const unsupported=await create(mime,parser,['Stored conversion output does not prove an original hierarchy.']);
  await assert.rejects(kernel.readDocumentParents(owner,unsupported.hits),code('DOCUMENT_STRUCTURE_UNAVAILABLE'));
 }
 await assert.rejects(kernel.readDocumentParents('foreign-owner',flat.hits),code('DOCUMENT_CONTEXT_CHANGED'));
 // The read-derived fallback cannot prevent later explicit author registration.
 await kernel.registerDocumentStructure(owner,flat.source,{rawSourceHash:flat.source.sourceHash,parserVersion:'later-original-hierarchy-v1',parents:[],
  nodes:flat.nodes.map((node,index)=>({evidenceId:node.evidenceId,locator:node.locator,ordinal:index,kind:'paragraph',bodySha256:node.bodySha256}))});
 assert.ok((await kernel.readDocumentParents(owner,flat.hits)).parents.every(parent=>parent.structureProvenance===undefined));
 const race=await create('text/plain','plain-text-v1',['Current text must not survive a concurrent source hide.']);let hidden=false;
 const db={query:async(text:string,args?:unknown[])=>{const result=await pool.query(text,args);
  if(!hidden&&text.includes('FROM document_structures WHERE version_id')){hidden=true;await kernel.hideParsedDocument(owner,race.document.id);}return result;
 }} as Pick<Pool,'query'>;
 await assert.rejects(readDocumentParents(db,owner,race.hits),code('DOCUMENT_CONTEXT_CHANGED'));assert.equal(hidden,true);
 assert.equal(externalCalls,0);
});
