import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Pool} from 'pg';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {DocumentContextError,readCompleteDocumentSource,COMPLETE_DOCUMENT_SOURCE_LIMITS} from '../lib/kernel/document-context.ts';
import {DocumentNodeSelectionError} from '../lib/kernel/document-nodes.ts';
import {DocumentEvidenceChangedError} from '../lib/kernel/document-evidence.ts';
import {prepareDocumentAnswer} from '../lib/kernel/document-answer.ts';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQWQAAAAASUVORK5CYII=','base64');
const pg={skip:!process.env.KERNEL_DATABASE_URL};
process.env.OPENAI_API_KEY='dummy-complete-source-local-test-never-sent';
let unexpectedCalls=0;const forbid=async()=>{unexpectedCalls++;throw new Error('Complete-source fixtures prohibit external/model calls');};
globalThis.fetch=forbid;
after(async()=>{try{assert.equal(unexpectedCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const changed=(error:unknown)=>error instanceof DocumentEvidenceChangedError||error instanceof DocumentContextError&&error.code==='DOCUMENT_CONTEXT_CHANGED';
async function fixture(options:{bodies?:string[];captions?:number;captionBody?:string;images?:boolean;separateParents?:boolean;nestedParents?:boolean}={}){
 await migrateKernel();const tag=randomUUID(),owner='complete-owner-'+tag,id='complete-doc-'+tag,title='Complete original source '+tag;
 const prose=options.bodies??Array.from({length:20},(_,index)=>`Complete baseline observation ${index}.`),captions=options.captions??2;
 const bodies=[...prose,...Array.from({length:captions},(_,index)=>options.captionBody??`Table ${index+1}: Original baseline measurements.`)];
 const document={id,ownerId:owner,courseId:'',name:title,hash:hash(JSON.stringify(bodies)),mime:'text/plain',origin:'complete-fixture',originKey:id};
 const pages=bodies.map((text,index)=>({pageNumber:index+1,locator:'original-node:'+index,text}));
 await kernel.ingestParsedDocument(document,pages,{parserVersion:'complete-fixture-v1',warnings:['Original formula fidelity unverified.']});
 const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});
 if(resolution.status!=='resolved')throw new Error('Complete fixture unresolved');const source={...resolution.document,courseId:''};
 const nodes=(await kernel.readDocumentSourcePages(owner,source)).nodes;
 await kernel.registerDocumentStructure(owner,source,{rawSourceHash:source.sourceHash,parserVersion:'original-structure-v1',
  parents:options.separateParents?prose.map((_,index)=>({id:'section:'+index,heading:'Original heading '+index})):
   options.nestedParents?[{id:'ancestor',heading:'Original ancestor with no direct prose'},{id:'section',parentId:'ancestor',heading:'Original baseline section'}]:
    [{id:'section',heading:'Original baseline section'}],
  nodes:nodes.map((node,index)=>({evidenceId:node.evidenceId,locator:node.locator,ordinal:index,bodySha256:node.bodySha256,
   kind:index<prose.length?'paragraph':'caption',parentId:index<prose.length?(options.separateParents?'section:'+index:'section'):null}))});
 if(options.images!==false)for(const node of nodes.slice(prose.length))await kernel.registerDocumentImage(owner,source,{captionEvidenceId:node.evidenceId,
  originalReference:node.locator+'.png',provenance:{sourceUrl:'https://example.edu/original-assets.tgz',revision:'original-v1'},bytes:png});
 return {owner,id,title,source,nodes,document,pages};
}

test('whole source covers every original node and real caption image beyond14; ranked readers keep their limits',pg,async()=>{
 const item=await fixture({nestedParents:true}),options={semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false};
 const before=await kernel.searchDocumentText(item.owner,'baseline',options);
 const result=await kernel.readCompleteDocumentSource(item.owner,item.source);assert.equal(result.status,'available');
 if(result.status!=='available')throw new Error('Expected complete source');
 assert.equal(result.context.anchors.length,22);assert.deepEqual(result.context.anchors.map(h=>h.body),item.pages.map(p=>p.text));
 assert.equal(result.context.parents.length,4);assert.equal(result.context.images.length,2);
 assert.ok(result.context.images.every(image=>hash(image.bytes)===hash(png)&&image.width===1&&image.height===1));
 assert.deepEqual(result.manifest.nodes.map(n=>n.evidenceId),item.nodes.map(n=>n.evidenceId));
 assert.equal(result.manifest.sourceNodeCount,22);assert.equal(result.manifest.returnedNodeCount,22);assert.equal(result.manifest.complete,true);
 assert.equal(result.manifest.nodeOrder,'original-source');assert.equal(result.manifest.method,'complete-current-source');
 assert.equal(result.manifest.hierarchy[0].heading,'Original ancestor with no direct prose');
 const prepared=prepareDocumentAnswer('Explain the baseline.',result.context);
 assert.ok(prepared.input.parentMetadata.some(parent=>parent.headingMetadata?.text==='Original ancestor with no direct prose'&&parent.sourceNodeCount===20));
 assert.equal(prepared.supports.filter(support=>support.kind==='text').length,22,'ancestor packets do not duplicate original model text');
 assert.deepEqual(result.manifest.parserWarnings,['Original formula fidelity unverified.']);
 assert.ok(result.context.anchors.every(h=>!('score' in h)&&h.retrieval_mode==='reader-selection'));
 assert.deepEqual(await kernel.searchDocumentText(item.owner,'baseline',options),before);
 await assert.rejects(kernel.readDocumentNodes(item.owner,item.source,item.nodes.slice(0,15).map(n=>n.evidenceId)),DocumentNodeSelectionError);
 assert.equal(COMPLETE_DOCUMENT_SOURCE_LIMITS.requestInputTokens,200000);
});

test('complete source refuses overflow, missing or ambiguous originals without returning clipped context',pg,async()=>{
 const tooMany=await fixture({bodies:Array(COMPLETE_DOCUMENT_SOURCE_LIMITS.nodes+1).fill('Original.'),captions:0});
 const over=await kernel.readCompleteDocumentSource(tooMany.owner,tooMany.source);
 assert.equal(over.status,'unavailable');if(over.status!=='unavailable')throw new Error('Expected node bound');
 assert.equal(over.reason,'source-size-limit');assert.equal(over.manifest.returnedNodeCount,0);assert.equal('context' in over,false);
 const manyImages=await fixture({bodies:['Original.'],captions:COMPLETE_DOCUMENT_SOURCE_LIMITS.images+1,images:false});
 const count=await kernel.readCompleteDocumentSource(manyImages.owner,manyImages.source);
 assert.equal(count.status,'unavailable');if(count.status==='unavailable')assert.equal(count.reason,'image-count-limit');
 const missing=await fixture({bodies:['Original.'],captions:1,images:false});
 const unavailable=await kernel.answerSelectedStudySource(missing.owner,'Explain the baseline.',missing.source,{beforeAttempt:async()=>{throw new Error('Must not reserve');}});
 assert.equal(unavailable.status,'unavailable');if(unavailable.status==='unavailable')assert.equal(unavailable.reason,'image-unavailable');
 const caption=missing.nodes.at(-1)!;
 for(const originalReference of ['a.png','b.png'])await kernel.registerDocumentImage(missing.owner,missing.source,{captionEvidenceId:caption.evidenceId,
  originalReference,provenance:{sourceUrl:'https://example.edu/original.tgz',revision:'v1'},bytes:png});
 const ambiguous=await kernel.readCompleteDocumentSource(missing.owner,missing.source);
 assert.equal(ambiguous.status,'unavailable');if(ambiguous.status==='unavailable')assert.equal(ambiguous.reason,'image-ambiguous');
});

test('generic complete-source capacity retains boundary text and every original PNG without clipping',pg,async()=>{
 const text=await fixture({bodies:Array(512).fill('é'.repeat(256)),captions:0});
 const complete=await kernel.readCompleteDocumentSource(text.owner,text.source);
 assert.equal(complete.status,'available');if(complete.status!=='available')throw new Error('Expected full boundary text');
 assert.equal(complete.manifest.sourceNodeCount,512);assert.equal(complete.manifest.returnedNodeCount,512);
 assert.equal(complete.manifest.sourceBodyCodepoints,131072);assert.equal(complete.manifest.sourceBodyUtf8Bytes,262144);
 assert.deepEqual(complete.context.anchors.map(n=>n.body),text.pages.map(p=>p.text));
 const pictures=await fixture({bodies:['Original image source.'],captions:64});
 const allImages=await kernel.readCompleteDocumentSource(pictures.owner,pictures.source);
 assert.equal(allImages.status,'available');if(allImages.status!=='available')throw new Error('Expected all64 original images');
 assert.equal(allImages.context.images.length,64);assert.equal(allImages.manifest.images.length,64);
 assert.deepEqual(allImages.context.images.map(image=>image.captionEvidenceId),pictures.nodes.slice(1).map(n=>n.evidenceId));
 assert.ok(allImages.context.images.every(image=>hash(image.bytes)===hash(png)));
 assert.equal(allImages.context.accounting.imageBytes,64*png.length);
 assert.equal(allImages.manifest.limits.imageInputTokens,65536);assert.equal(allImages.manifest.limits.requestInputTokens,200000);
 assert.equal(allImages.manifest.limits.framingTokens,16384);
});

test('generic complete-source capacity still rejects text, image byte and raw patch overflow before returning context',pg,async()=>{
 const points=await fixture({bodies:['x'.repeat(131073)],captions:0});
 const bytes=await fixture({bodies:['€'.repeat(87381)+'é'],captions:0});
 for(const item of [points,bytes]){
  const result=await kernel.readCompleteDocumentSource(item.owner,item.source);
  assert.equal(result.status,'unavailable');if(result.status!=='unavailable')throw new Error('Expected resource refusal');
  assert.equal(result.reason,'source-size-limit');assert.equal(result.manifest.returnedNodeCount,0);assert.equal('context' in result,false);
 }
 const image=await fixture({bodies:['Original image source.'],captions:1}),pool=kernelPool();
 for(const [reason,override] of [
  ['image-byte-limit',{byte_length:32*1024*1024+1}],
  ['image-input-limit',{width:8192,height:8192}],
 ] as const){
  // Simulate oversized PG attachment metadata: the reader must refuse before
  // materializing the blob, rather than clipping it or relaxing its SHA checks.
  const oversized=new Proxy(pool,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(...args:Parameters<Pool['query']>)=>{
   const result=await (target.query as (...values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>).apply(target,args);
   return typeof args[0]==='string'&&args[0].includes('SELECT id,caption_evidence_id')
    ?{...result,rows:result.rows.map(row=>({...row,...override}))}:result;
  };}}) as Pool;
  const result=await readCompleteDocumentSource(oversized,image.owner,image.source);
  assert.equal(result.status,'unavailable');if(result.status!=='unavailable')throw new Error('Expected image resource refusal');
  assert.equal(result.reason,reason);assert.equal(result.manifest.returnedNodeCount,0);assert.equal('context' in result,false);
 }
});

test('all original bodies remain complete when parent expansion is unavailable; required caption blobs remain mandatory',pg,async()=>{
 const item=await fixture({bodies:['Original long section. '+ 'x'.repeat(8193)],captions:1,captionBody:'Original long caption. '+'y'.repeat(8193)});
 const complete=await kernel.readCompleteDocumentSource(item.owner,item.source);
 assert.equal(complete.status,'available');if(complete.status!=='available')throw new Error('Expected full original source');
 assert.deepEqual(complete.context.anchors.map(n=>n.body),item.pages.map(p=>p.text));
 const parent=complete.context.parents.find(p=>p.kind==='section')!;
 assert.equal(parent.status,'unavailable-size-exceeds-8192');assert.deepEqual(parent.nodes,[]);
 assert.equal(parent.headingMetadata?.text,'Original baseline section');assert.equal(complete.context.images.length,1);
 assert.equal(complete.manifest.complete,true);assert.equal(complete.manifest.returnedNodeCount,item.nodes.length);
 const path=resolve(process.env.LIBRARY_DIR||'./data/library',hash(png)),away=path+'.missing-test';
 try{await rename(path,away);const missing=await kernel.readCompleteDocumentSource(item.owner,item.source);
  assert.equal(missing.status,'unavailable');if(missing.status==='unavailable')assert.equal(missing.reason,'image-unavailable');
 }finally{await rename(away,path);}
});

test('actual full request serialization is bounded before any answer reservation; upgrades are rejected',pg,async()=>{
 const prose=('"\\'.repeat(100)+' end. ').repeat(13);
 const item=await fixture({bodies:Array(24).fill(prose),captions:0,separateParents:true});
 assert.equal((await kernel.readCompleteDocumentSource(item.owner,item.source)).status,'available');
 let attempts=0;const result=await kernel.answerSelectedStudySource(item.owner,'Explain the original source.',item.source,{beforeAttempt:async()=>{attempts++;}});
 assert.equal(result.status,'unavailable');if(result.status==='unavailable')assert.equal(result.reason,'request-input-limit');
 assert.equal(attempts,0);
 // Each601-codepoint emoji body is1202 UTF16 units and yields two quote units.
 // These512 original nodes fit source capacity but yield600 IDs/15600 enum chars.
 const enumOverflow=await fixture({bodies:[...Array(88).fill('😀'.repeat(601)),...Array(424).fill('Original source paragraph.')],captions:0});
 const schema=await kernel.answerSelectedStudySource(enumOverflow.owner,'Explain the original source.',enumOverflow.source,{beforeAttempt:async()=>{attempts++;}});
 assert.equal(schema.status,'unavailable');if(schema.status==='unavailable'){
  assert.equal(schema.reason,'request-input-limit');assert.equal(schema.manifest.requestSchemaLimit,'enum-string');
  assert.equal(schema.manifest.returnedNodeCount,0);
 }
 assert.equal(attempts,0,'complete schema enum overflow must still refuse before any reservation');
 await assert.rejects(kernel.answerSelectedStudySource(item.owner,'Explain.',item.source,{model:'gpt-6-astra'}),/fixed mini/);
 await assert.rejects(kernel.answerSelectedStudySource(item.owner,'Explain.',item.source,{reasoningEffort:'high'}),/fixed mini/);
});

test('whole-source owner/currentness and actual image checks reject races, stale versions, and changed blobs',pg,async()=>{
 const item=await fixture({bodies:['Original source prose.'],captions:1});
 await assert.rejects(kernel.readCompleteDocumentSource('foreign-owner',item.source),changed);
 await assert.rejects(kernel.readCompleteDocumentSource(item.owner,{...item.source,courseId:'foreign-course'}),changed);
 const path=resolve(process.env.LIBRARY_DIR||'./data/library',hash(png)),original=await readFile(path),corrupt=Buffer.from(original);corrupt[corrupt.length-1]^=1;
 try{await writeFile(path,corrupt);await assert.rejects(kernel.readCompleteDocumentSource(item.owner,item.source),
  (error:unknown)=>error instanceof DocumentContextError&&error.code==='DOCUMENT_IMAGE_CHANGED');}finally{await writeFile(path,original);}
 const pool=kernelPool();let hidden=false;
 const racing=new Proxy(pool,{get(target,key){if(key!=='query')return Reflect.get(target,key);return async(...args:Parameters<Pool['query']>)=>{
  const result=await (target.query as (...values:unknown[])=>Promise<{rows:Record<string,unknown>[]}>).apply(target,args);
  if(!hidden&&typeof args[0]==='string'&&args[0].includes('SELECT id,caption_evidence_id')){hidden=true;await kernel.hideParsedDocument(item.owner,item.id);}return result;
 };}}) as Pool;
 await assert.rejects(readCompleteDocumentSource(racing,item.owner,item.source),changed);assert.equal(hidden,true);
 await pool.query('UPDATE document_texts SET hidden=false WHERE id=$1',[item.id]);
 await kernel.ingestParsedDocument(item.document,[{...item.pages[0],text:'Reparsed current original.'},...item.pages.slice(1)],{parserVersion:'complete-fixture-v2'});
 await assert.rejects(kernel.readCompleteDocumentSource(item.owner,item.source),changed);
});

test('selected-source synthesis rereads the complete manifest before publishing; provider is a local mock',pg,async()=>{
 const item=await fixture({bodies:['Original baseline observation.'],captions:0}),bypass=process.env.AI_BUDGET_TEST_BYPASS;
 process.env.AI_BUDGET_TEST_BYPASS='true';let mockCalls=0;
 globalThis.fetch=async(_url,init)=>{
  mockCalls++;const body=JSON.parse(String(init?.body)),input=JSON.parse(body.input.find((x:{role:string})=>x.role==='user').content[0].text);
  const unit=input.quoteUnits.find((u:{selectable:boolean})=>u.selectable);
  await kernel.hideParsedDocument(item.owner,item.id);
  return new Response(JSON.stringify({status:'completed',model:'gpt-5-mini',output_text:JSON.stringify({status:'answered',message:'',
   claims:[{text:unit.text,citations:[{id:unit.id}]}]})}),{headers:{'content-type':'application/json'}});
 };
 try{await assert.rejects(kernel.answerSelectedStudySource(item.owner,'Explain the baseline.',item.source),changed);assert.equal(mockCalls,1);}
 finally{globalThis.fetch=forbid;if(bypass===undefined)delete process.env.AI_BUDGET_TEST_BYPASS;else process.env.AI_BUDGET_TEST_BYPASS=bypass;}
});
