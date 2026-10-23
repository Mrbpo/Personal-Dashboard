import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {prepareDocumentAnswer} from '../lib/kernel/document-answer.ts';
import {DocumentNodeSelectionError,DocumentCitationUnavailableError,readDocumentNodes} from '../lib/kernel/document-nodes.ts';
import {DocumentEvidenceChangedError} from '../lib/kernel/document-evidence.ts';
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw new Error('Node reader prohibits external/model calls');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});

test('citation snapshots retain exact history without weakening current readers or current access',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const tag=randomUUID(),owner='snapshot-owner-'+tag,id='snapshot-doc-'+tag;
 const original='Original source paragraph. '.repeat(240)+'Original distant conclusion.',title='Original registered title '+tag;
 const document={id,ownerId:owner,courseId:'',name:title,hash:hash(original),mime:'text/plain',origin:'snapshot-fixture',originKey:id};
 await kernel.ingestParsedDocument(document,[{pageNumber:1,locator:'Original page one',text:original},
  {pageNumber:2,locator:'Original page two',text:'Second original paragraph.'}],{parserVersion:'snapshot-v1',warnings:['Unverified formula structure.']});
 const resolved=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});assert.equal(resolved.status,'resolved');
 if(resolved.status!=='resolved')throw Error('Unresolved fixture');const old=resolved.document;
 const nodes=(await kernel.readDocumentSourcePages(owner,old)).nodes,ids=[nodes[1].evidenceId,nodes[0].evidenceId];
 const source={documentId:id,documentVersionId:old.currentVersionId,sourceVersionId:old.sourceVersionId,sourceHash:old.sourceHash};
 const initial=await kernel.readDocumentCitationSnapshot(owner,source,ids);assert.equal(initial.status,'current');
 assert.equal(initial.usableForCurrentGeneration,false);assert.deepEqual(initial.nodes.map(n=>n.evidenceId),ids);
 await kernel.ingestParsedDocument({...document,name:'Renamed current title '+tag},
  [{pageNumber:1,locator:'New page one',text:'A different parser representation.'}],{parserVersion:'snapshot-v2'});
 const historical=await kernel.readDocumentCitationSnapshot(owner,source,ids);
 assert.equal(historical.status,'historical');assert.notEqual(historical.currentDocumentVersionId,source.documentVersionId);
 assert.equal(historical.sourceName,title);assert.equal(historical.parserVersion,'snapshot-v1');assert.equal(historical.pageCount,2);
 assert.deepEqual(historical.parserWarnings,['Unverified formula structure.']);
 assert.equal(historical.nodes[1].body,original);assert.equal(historical.nodes[1].bodySha256,hash(original));
 assert.ok(historical.nodes[1].body.length>4000,'historical full body cannot be replaced with the excerpt');
 await assert.rejects(kernel.readDocumentNodes(owner,old,ids),DocumentEvidenceChangedError);
 await assert.rejects(kernel.readDocumentCitationSnapshot('foreign-'+owner,source,ids),DocumentCitationUnavailableError);
 for(const bad of [{...source,sourceHash:hash('wrong')},{...source,sourceVersionId:'other-source'},
  {...source,documentVersionId:historical.currentDocumentVersionId!},{...source,documentId:'other-document'}])
  await assert.rejects(kernel.readDocumentCitationSnapshot(owner,bad,ids),DocumentCitationUnavailableError);
 await assert.rejects(kernel.readDocumentCitationSnapshot(owner,source,[]),/Invalid citation snapshot/);
 await assert.rejects(kernel.readDocumentCitationSnapshot(owner,source,[ids[0],ids[0]]),/Invalid citation snapshot/);
 await assert.rejects(kernel.readDocumentCitationSnapshot(owner,source,[...ids,'nonexistent-evidence']),DocumentCitationUnavailableError);
 const currentVersion=historical.currentDocumentVersionId!;
 const currentEvidence=(await kernelPool().query<{evidence_id:string}>('SELECT evidence_id FROM document_text_pages WHERE version_id=$1',[currentVersion])).rows[0].evidence_id;
 const currentSource={...source,documentVersionId:currentVersion,sourceVersionId:(await kernelPool().query<{source_version_id:string}>(
  'SELECT source_version_id FROM document_text_versions WHERE id=$1',[currentVersion])).rows[0].source_version_id};
 await kernel.ingestParsedDocument({...document,id:id+'-replacement',name:'Replacement source '+tag},
  [{pageNumber:1,locator:'Replacement page',text:'Replacement observations.'}],{parserVersion:'snapshot-replacement'});
 const superseded=await kernel.readDocumentCitationSnapshot(owner,currentSource,[currentEvidence]);
 assert.equal(superseded.status,'historical');assert.equal(superseded.originSuperseded,true);
 assert.equal(superseded.currentDocumentVersionId,currentVersion,'an unchanged document head can still have a superseded origin');
 await kernel.hideParsedDocument(owner,id);
 await assert.rejects(kernel.readDocumentCitationSnapshot(owner,source,ids),DocumentCitationUnavailableError);
});

test('current evidence-node selections preserve full bodies/order and refuse foreign, historical or changed sources',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const tag=randomUUID(),owner='node-owner-'+tag,id='node-doc-'+tag,title='Node source '+tag;
 const bodies=['Original phase observations. '+('Complete original prose. '.repeat(100))+'Distant original conclusion.',
  'A second original paragraph.','Figure 1: Phase comparison.'];
 const document={id,ownerId:owner,courseId:'',name:title,hash:hash(JSON.stringify(bodies)),mime:'text/plain',origin:'node-fixture',originKey:id};
 const pages=bodies.map((text,index)=>({pageNumber:index+1,locator:'original-node:'+index,text}));
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'node-fixture-v1',warnings:['Formula fidelity unverified.']});
 const resolveCurrent=async()=>{
  const result=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});assert.equal(result.status,'resolved');
  if(result.status!=='resolved')throw new Error('Fixture source unresolved');return {...result.document,courseId:''};
 };
 const source=await resolveCurrent(),nodes=(await kernel.readDocumentSourcePages(owner,source)).nodes;
 await kernel.registerDocumentStructure(owner,source,{rawSourceHash:source.sourceHash,parserVersion:'original-structure-v1',
  parents:[{id:'section',heading:'Original section'}],nodes:nodes.map((node,index)=>({evidenceId:node.evidenceId,locator:node.locator,
   ordinal:index,kind:index===2?'caption':'paragraph',parentId:index===2?null:'section',bodySha256:node.bodySha256}))});
 const ids=[nodes[2].evidenceId,nodes[0].evidenceId],selected=await kernel.readDocumentNodes(owner,source,ids);
 assert.deepEqual(selected.map(hit=>hit.evidence_id),ids);assert.deepEqual(selected.map(hit=>hit.body),[bodies[2],bodies[0]]);
 assert.ok(selected[1].body.length>1600);assert.ok(selected[1].body.includes('Distant original conclusion.'));
 for(const hit of selected){assert.equal(hit.reader_selection,'evidence-node-ids');assert.equal(hit.retrieval_mode,'reader-selection');
  assert.equal(hit.evidence_body,'full-page');assert.equal(hit.id,`pg:${source.currentVersionId}:${hit.page_number}`);
  assert.equal(hit.source_version_id,source.sourceVersionId);assert.equal(hit.source_hash,source.sourceHash);
  assert.deepEqual(hit.parser_warnings,['Formula fidelity unverified.']);assert.equal('score' in hit,false);assert.equal('rerank_model' in hit,false);}
 const context=await kernel.readDocumentParents(owner,selected);
 assert.deepEqual(context.anchors,selected);assert.equal(context.accounting.anchorCount,2);assert.equal(context.accounting.contextNodeCount,3);
 assert.equal(prepareDocumentAnswer('Explain the phase comparison.',context).supports.length,3);
 await assert.rejects(kernel.readDocumentNodes(owner,source,[]),DocumentNodeSelectionError);
 await assert.rejects(kernel.readDocumentNodes(owner,source,[ids[0],ids[0]]),DocumentNodeSelectionError);
 await assert.rejects(kernel.readDocumentNodes(owner,source,Array(15).fill(ids[0])),DocumentNodeSelectionError);
 await assert.rejects(kernel.readDocumentNodes('foreign-owner',source,ids),DocumentEvidenceChangedError);
 await assert.rejects(kernel.readDocumentNodes(owner,{...source,sourceHash:hash('wrong source')},ids),DocumentEvidenceChangedError);
 await assert.rejects(kernel.readDocumentNodes(owner,{...source,courseId:'foreign-course'},ids),DocumentEvidenceChangedError);
 const otherId='other-'+randomUUID();await kernel.ingestParsedDocument({...document,id:otherId,name:'Other source '+tag,originKey:otherId},pages,{parserVersion:'node-fixture-v1'});
 const other=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:'Other source '+tag});
 if(other.status!=='resolved')throw new Error('Other fixture source unresolved');
 const otherNode=(await kernel.readDocumentSourcePages(owner,{...other.document,courseId:''})).nodes[0].evidenceId;
 await assert.rejects(kernel.readDocumentNodes(owner,source,[ids[0],otherNode]),DocumentEvidenceChangedError);
 const segmentId='segment-'+randomUUID(),segmentTitle='Recorded segment '+tag;
 await kernel.ingestParsedDocument({...document,id:segmentId,name:segmentTitle,originKey:segmentId},[
  {pageNumber:1,locator:'00:00.000–00:02.500',text:'Original recording transcript.',contentKind:'time_segment',startMs:0,endMs:2500}
 ],{parserVersion:'node-transcript-v1'});
 const segment=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:segmentTitle});
 if(segment.status!=='resolved')throw new Error('Transcript source unresolved');
 const segmentSource={...segment.document,courseId:''},segmentNode=(await kernel.readDocumentSourcePages(owner,segmentSource)).nodes[0];
 const [segmentHit]=await kernel.readDocumentNodes(owner,segmentSource,[segmentNode.evidenceId]);
 assert.equal(segmentHit.content_kind,'time_segment');assert.equal(typeof segmentHit.start_ms,'number');assert.equal(segmentHit.start_ms,0);
 assert.equal(typeof segmentHit.end_ms,'number');assert.equal(segmentHit.end_ms,2500);
 await kernel.ingestParsedDocument(document,[{...pages[0],text:'Reparsed original observations.'},...pages.slice(1)],{parserVersion:'node-fixture-v2'});
 await assert.rejects(kernel.readDocumentNodes(owner,source,ids),DocumentEvidenceChangedError);
 const current=await resolveCurrent(),currentNodes=(await kernel.readDocumentSourcePages(owner,current)).nodes;
 await assert.rejects(kernel.readDocumentNodes(owner,current,ids),DocumentEvidenceChangedError);
 const pool=kernelPool();let hidden=false;
 const racing=new Proxy(pool,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(...args:Parameters<Pool['query']>)=>{
  const result=await (target.query as (...values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>).apply(target,args);
  if(!hidden&&typeof args[0]==='string'&&args[0].includes("SELECT 'pg:'||v.id")){hidden=true;await kernel.hideParsedDocument(owner,id);}return result;
 };}}) as Pool;
 await assert.rejects(readDocumentNodes(racing,owner,current,[currentNodes[0].evidenceId]),DocumentEvidenceChangedError);assert.equal(hidden,true);
 await assert.rejects(kernel.readDocumentNodes(owner,current,[currentNodes[0].evidenceId]),DocumentEvidenceChangedError);
});
