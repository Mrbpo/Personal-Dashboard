import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {preparePersistedTextCoverage,projectPersistedTextCoverage} from '../lib/kernel/document-text-coverage.ts';
import {prepareDocumentAnswer,buildDocumentEvidenceSelectionRequest,buildSelectedDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import type {DocumentTextSourceManifest} from '../lib/kernel/document-context.ts';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
 ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const source={documentId:'coverage-doc',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:sha('immutable original')};
const title='Coverage Fixture.pdf',question=`In ${title}, which listed topic is not elaborated?`;
const settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:2000};
function fixture(){
 const bodies=['Topics: rivers, forests and deserts.','Rivers flow toward other bodies of water.','Forests contain trees. 😀',''];
 const anchors=bodies.map((body,i)=>({id:`pg:version:${i+1}`,document_id:source.documentId,course_id:'',name:title,origin:'fixture',origin_key:'fixture',
  source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:`page:${i+1}`,page_number:i+1,evidence_id:`page-${i+1}`,
  parser_version:'fixture',score:1,evidence_body:'full-page' as const}));
 const unsigned={method:'current-persisted-text-v1' as const,nodeOrder:'persisted-source-order' as const,textCoverage:'all-current-persisted-nodes' as const,
  source,sourceNodeCount:4,returnedNodeCount:4,sourceBodyCodepoints:bodies.reduce((n,b)=>n+Array.from(b).length,0),
  sourceBodyUtf8Bytes:bodies.reduce((n,b)=>n+Buffer.byteLength(b),0),orderedTextSha256:sha(canonical(bodies)),structureManifestSha256:sha('structure'),
  originalFileCompletenessVerified:false as const,visualCompletenessVerified:false as const,parserWarnings:[]};
 const manifest:DocumentTextSourceManifest={...unsigned,manifestSha256:sha(canonical(unsigned))};
 const context:DocumentAnswerContext={anchors,parents:[],images:[],sourceContentIsUntrusted:true};
 return {manifest,context};
}
const packet=(r:{input:Array<{content:unknown}>})=>JSON.parse((r.input.at(-1)!.content as {text:string}[])[0].text);

test('selected HTTP-shared generation carries actual full stored text coverage, without changing the selector wire',()=>{
 const {context,manifest}=fixture(),before=JSON.stringify(context),old=prepareDocumentAnswer(question,context),
  prepared=prepareDocumentAnswer(question,{...context,persistedTextProof:manifest}),units=prepared.quoteUnits.filter(u=>u.selectable),
  request=buildSelectedDocumentAnswerRequest(prepared,units.map(u=>u.id),settings),p=packet(request);
 assert.notEqual(prepared.fingerprint,old.fingerprint);
 assert.deepEqual(buildDocumentEvidenceSelectionRequest(prepared,settings),buildDocumentEvidenceSelectionRequest(old,settings));
 assert.equal(p.persistedTextCoverage.coverage,'all-current-persisted-nodes');
 assert.equal(p.persistedTextCoverage.coveredNodeCount,4);assert.equal(p.persistedTextCoverage.originalFileCompletenessVerified,false);
 assert.equal(p.persistedTextCoverage.visualCompletenessVerified,false);assert.equal(p.persistedTextCoverage.textFaithfulness,'unassessed');
 assert.deepEqual(p.quoteUnits,packet(buildSelectedDocumentAnswerRequest(old,units.map(u=>u.id),settings)).quoteUnits);
 assert.equal(packet(buildSelectedDocumentAnswerRequest(old,units.map(u=>u.id),settings)).persistedTextCoverage,undefined);
 assert.equal(JSON.stringify(context),before);
});

test('retaining every source support ID cannot hide a missing quote span or an empty selector',()=>{
 const {context,manifest}=fixture(),prepared=prepareDocumentAnswer(question,{...context,persistedTextProof:manifest}),
  units=prepared.quoteUnits.filter(u=>u.selectable),support=prepared.supports.find(s=>s.evidenceId==='page-2')!,
  without=units.filter(u=>u.supportId!==support.id),request=buildSelectedDocumentAnswerRequest(prepared,without.map(u=>u.id),settings);
 assert.equal(packet(request).persistedTextCoverage.coverage,'partial-current-persisted-nodes');
 assert.equal(packet(request).persistedTextCoverage.nodes.find((n:{evidenceId:string})=>n.evidenceId==='page-2').fullBodySupplied,false);
 assert.equal(projectPersistedTextCoverage(prepared.persistedTextCoverage!,prepared.supports,[]).coverage,'partial-current-persisted-nodes');
 assert.throws(()=>buildSelectedDocumentAnswerRequest(prepared,[],settings),/requires original evidence/);
});

test('coverage rejects stale sources, mutated text, missing/duplicate nodes and forged manifests',()=>{
 const {context,manifest}=fixture(),proof=preparePersistedTextCoverage(manifest,context.anchors);
 assert.equal(proof.nodes[2].bodyUtf16Length,context.anchors[2].body.length);
 for(const mutate of [
  (a:typeof context.anchors)=>{a[0].source_version_id='stale';},
  (a:typeof context.anchors)=>{a[0].body+='added';},
  (a:typeof context.anchors)=>{a.pop();},
  (a:typeof context.anchors)=>{a[1]={...a[0]};},
  (a:typeof context.anchors)=>{a[0].evidence_body='snippet' as never;}
 ]){const anchors=structuredClone(context.anchors);mutate(anchors);assert.throws(()=>preparePersistedTextCoverage(manifest,anchors),/binding changed/);}
 assert.throws(()=>preparePersistedTextCoverage({...manifest,manifestSha256:sha('forged')},context.anchors),/binding changed/);
 const changed={...manifest,originalFileCompletenessVerified:true};
 const {manifestSha256:_,...unsigned}=changed;
 assert.throws(()=>preparePersistedTextCoverage({...changed,manifestSha256:sha(canonical(unsigned))} as never,context.anchors),/binding changed/);
});

test('only exact original spans cover a node; foreign sources cannot fill gaps',()=>{
 const {context,manifest}=fixture(),prepared=prepareDocumentAnswer(question,{...context,persistedTextProof:manifest}),proof=prepared.persistedTextCoverage!,
  support=prepared.supports.find(s=>s.evidenceId==='page-1')!,body=support.text!,other=prepared.quoteUnits.filter(u=>u.selectable&&u.supportId!==support.id),
  span=(start:number,end:number)=>({supportId:support.id,startUtf16:start,endUtf16:end,text:body.slice(start,end),selectable:true});
 assert.equal(projectPersistedTextCoverage(proof,prepared.supports,[...other,span(0,12),span(10,body.length)]).coverage,'all-current-persisted-nodes');
 assert.equal(projectPersistedTextCoverage(proof,prepared.supports,[...other,span(0,10),span(11,body.length)]).coverage,'partial-current-persisted-nodes');
 assert.throws(()=>projectPersistedTextCoverage(proof,prepared.supports,[...other,{...span(0,body.length),text:'invented'}]),/binding changed/);
 const foreign={...support,id:'foreign',documentId:'another',evidenceId:'foreign-page'};
 assert.equal(projectPersistedTextCoverage(proof,[...prepared.supports,foreign],[...other,{...span(0,body.length),supportId:'foreign'}]).coverage,'partial-current-persisted-nodes');
});
