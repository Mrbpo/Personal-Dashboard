import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildDocumentSourceTextView,documentSourceTextViewRequest,DOCUMENT_SOURCE_TEXT_VIEW_SCOPE} from '../lib/kernel/document-source-text-view.ts';
import {DocumentContextError,type DocumentTextSourceRead,type DocumentTextSourceManifest} from '../lib/kernel/document-context.ts';
const sha=(v:string)=>createHash('sha256').update(v).digest('hex'),canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
 ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
function sign(value:Omit<DocumentTextSourceManifest,'manifestSha256'>):DocumentTextSourceManifest{return {...value,manifestSha256:sha(canonical(value))};}
function fixture():Extract<DocumentTextSourceRead,{status:'available'}>{
 const source={documentId:'real-source',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:sha('original PDF')},
  bodies=['Original line.\n第二行 😀','\tOriginal table text stays unchanged.\n',''],
  anchors=bodies.map((body,i)=>({id:`pg:version:${i+1}`,document_id:source.documentId,course_id:'',name:'Original.pdf',origin:'fixture',origin_key:'original',
   source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:`original-page:${i+1}`,page_number:i+1,evidence_id:`actual-node-${i+1}`,
   parser_version:'fixture-parser-v1',parser_warnings:i===1?['table-relationship-unknown']:[],score:1,evidence_body:'full-page' as const}));
 const manifest=sign({method:'current-persisted-text-v1',nodeOrder:'persisted-source-order',textCoverage:'all-current-persisted-nodes',source,
  sourceNodeCount:3,returnedNodeCount:3,sourceBodyCodepoints:bodies.reduce((n,b)=>n+Array.from(b).length,0),sourceBodyUtf8Bytes:bodies.reduce((n,b)=>n+Buffer.byteLength(b),0),
  orderedTextSha256:sha(canonical(bodies)),structureManifestSha256:sha('original structure'),originalFileCompletenessVerified:false,visualCompletenessVerified:false,parserWarnings:['table-relationship-unknown']});
 return {status:'available',manifest,context:{anchors,parents:[],images:[],sourceContentIsUntrusted:true,
  accounting:{anchorCount:3,parentCount:0,contextNodeCount:3,contextBodyCodepoints:manifest.sourceBodyCodepoints,imageCount:0,imageBytes:0}}};
}

test('whole stored-text view preserves every real node, exact Unicode bytes and boundaries without invented evidence IDs',()=>{
 const read=fixture(),before=JSON.stringify(read),view=buildDocumentSourceTextView(read,read.manifest.manifestSha256);
 assert.equal(view.status,'available');if(view.status!=='available')throw Error('Expected available');
 assert.equal(view.nodes.length,3);assert.equal('evidenceId' in view,false);
 assert.deepEqual(view.nodes.map(n=>[n.evidenceId,n.locator,n.body]),read.context.anchors.map(a=>[a.evidence_id,a.locator,a.body]));
 for(const node of view.nodes)assert.equal(node.bodySha256,sha(node.body));
 assert.equal(view.textFaithfulness,'unassessed');assert.equal(view.originalFileCompletenessVerified,false);assert.equal(view.visualCompletenessVerified,false);
 assert.deepEqual(view.nodes[1].parserWarnings,['table-relationship-unknown']);
 const {viewSha256,...unsigned}=view;assert.equal(viewSha256,sha(canonical(unsigned)));
 assert.equal(JSON.stringify(read),before);view.nodes[1].parserWarnings.push('changed output');assert.equal(JSON.stringify(read),before);
});

test('pins, missing or mutated source text cannot produce a complete view',()=>{
 const read=fixture();
 assert.throws(()=>buildDocumentSourceTextView(read,sha('different manifest')),(e:unknown)=>e instanceof DocumentContextError&&e.code==='DOCUMENT_CONTEXT_CHANGED');
 assert.throws(()=>buildDocumentSourceTextView(read,''),/Invalid source text view/);
 for(const mutate of [
  (r:typeof read)=>{r.context.anchors[0].body+='invented';},
  (r:typeof read)=>{r.context.anchors.pop();},
  (r:typeof read)=>{r.context.anchors[1]={...r.context.anchors[0]};},
  (r:typeof read)=>{r.context.anchors.push({...r.context.anchors[0],document_id:'foreign',body:'foreign text'});},
  (r:typeof read)=>{r.context.anchors[0].source_version_id='stale';}
 ]){const changed=structuredClone(read);mutate(changed);assert.throws(()=>buildDocumentSourceTextView(changed));}
 const {manifestSha256:_,...unsigned}=read.manifest;
 assert.throws(()=>buildDocumentSourceTextView({...read,manifest:sign({...unsigned,sourceNodeCount:513,returnedNodeCount:513})}));
});

test('unavailable complete text is explicit and contains no partial or zero-content source view',()=>{
 const read=fixture(),{manifestSha256:_,...unsigned}=read.manifest;
 for(const reason of ['source-size-limit','structure-unavailable'] as const){
  const result=buildDocumentSourceTextView({status:'unavailable',reason,manifest:sign({...unsigned,textCoverage:'unavailable',returnedNodeCount:0,orderedTextSha256:null,structureManifestSha256:null})});
  assert.equal(result.status,'unavailable');assert.equal('nodes'in result,false);assert.equal('viewSha256'in result,false);
 }
 assert.throws(()=>buildDocumentSourceTextView({status:'unavailable',reason:'source-size-limit',manifest:read.manifest}));
});

test('source-view request scope is explicit, bounded and never silently becomes another reader',()=>{
 const read=fixture(),source=read.manifest.source,query=new URLSearchParams({evidence:'1',scope:DOCUMENT_SOURCE_TEXT_VIEW_SCOPE,
  version:source.currentVersionId,sourceVersion:source.sourceVersionId,sourceHash:source.sourceHash});
 assert.deepEqual(documentSourceTextViewRequest(source.documentId,query),{source,manifestSha256:undefined});
 query.set('manifest',read.manifest.manifestSha256);assert.equal(documentSourceTextViewRequest(source.documentId,query)?.manifestSha256,read.manifest.manifestSha256);
 assert.equal(documentSourceTextViewRequest(source.documentId,new URLSearchParams({evidence:'1',snapshot:'1',evidenceId:'actual-node-1'})),undefined,'legacy node/snapshot route is unchanged');
 for(const [key,value] of [['scope','unknown'],['evidence','0'],['version',''],['manifest','not-a-hash'],['snapshot','1'],['evidenceId','actual-node-1'],['nativeRegions','1'],['parserRegions','1'],['preview','1']]){
  const bad=new URLSearchParams(query);bad.set(key,value);assert.throws(()=>documentSourceTextViewRequest(source.documentId,bad));
 }
 assert.throws(()=>documentSourceTextViewRequest('x'.repeat(1001),query));
});
