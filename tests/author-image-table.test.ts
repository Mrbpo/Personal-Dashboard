import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {prepareAuthorImageTableArtifact,prepareAuthorImageTableObservation,assertAuthorImageTableObservation,
 type DerivedAuthorImageTableCandidate} from '../lib/kernel/document-table-candidates.ts';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest} from '../lib/kernel/document-citation-audit.ts';
import {hash,canonical,image,syntheticRun} from './fixtures/author-image-table-v1/run.ts';
globalThis.fetch=async()=>{throw new Error('Author image registration tests prohibit external requests');};
const manifest=hash('structure');
function candidateFor(a:ReturnType<typeof prepareAuthorImageTableArtifact>):DerivedAuthorImageTableCandidate{
 return {kind:'derived-author-image-table',id:hash(canonical({namespace:a.namespace,producer:a.producer,source:a.source,
  artifactSha256:a.artifactSha256,structureManifestSha256:a.structureManifestSha256,attachmentId:a.attachmentId,assetSha256:a.assetSha256,anchor:a.captionEvidenceId})),
  source:a.source,anchorEvidenceId:a.captionEvidenceId,attachmentId:a.attachmentId,structureManifestSha256:a.structureManifestSha256,
  assetSha256:a.assetSha256,artifactSha256:a.artifactSha256};
}
function context(observations?:ReturnType<typeof prepareAuthorImageTableObservation>[]):DocumentAnswerContext{
 return {anchors:[],parents:[],sourceContentIsUntrusted:true,images:[{...image,...(observations?{tableObservations:observations}:{})}],imageAnchors:[{
  id:`pg:${image.source.currentVersionId}:1`,document_id:image.source.documentId,source_version_id:image.source.sourceVersionId,
  source_hash:image.source.sourceHash,course_id:'',name:'Fixture',origin:'fixture',origin_key:'fixture',body:'Actual caption node',locator:'caption:0',
  page_number:1,evidence_id:image.captionEvidenceId,parser_version:'fixture',reader_selection:'evidence-node-ids',retrieval_mode:'reader-selection',evidence_body:'full-page'}]};
}
test('author table: legacy complete AST and section/spans stay unchanged; only original PNG is selectable and locally audited',async()=>{
 const grid=JSON.parse(await readFile(new URL('./fixtures/author-image-table-v1/candidate.json',import.meta.url),'utf8'));
 const a=prepareAuthorImageTableArtifact(await syntheticRun(image,manifest,grid),image,manifest),o=prepareAuthorImageTableObservation(candidateFor(a),a,image);
 assert.deepEqual(a.grid,grid);assert.equal(a.grid.tables[0].cells[1].headerRole,'section');assert.equal(a.physicalPage,null);assert.equal(a.bbox,null);
 const p=prepareDocumentAnswer('Compare measurements',context([o])),plain=prepareDocumentAnswer('Compare measurements',context());
 assert.notEqual(p.fingerprint,plain.fingerprint);assert.deepEqual(p.quoteUnits,[]);assert.deepEqual(p.supports.map(s=>s.id),['i0']);
 const request=buildDocumentAnswerRequest(p,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000});
 const actual=JSON.parse(String((request.input[1].content as any[])[0].text));
 assert.deepEqual(actual.evidence[0].tableObservations[0].artifact.grid,grid);assert.equal(o.semanticVerified,false);
 const local=prepareDocumentCitationAudit('Compare measurements',context([o]),{inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,
  providerSelections:{status:'answered',message:'',claims:[{text:'A test statement',citations:[{id:'i0'}]}]},claimIndex:0});
 const wire=JSON.stringify(buildDocumentCitationAuditRequest(local.packet));
 assert.equal(wire.includes('tableObservations'),false);assert.equal(wire.includes('Rank Correlation'),false);
 assert.equal((buildDocumentCitationAuditRequest(local.packet).input[1].content as any[]).filter(c=>c.type==='input_image').length,1);
});
test('author table: foreign current/caption/PNG, edited candidate, transport hash and unknown model reject before registration',async()=>{
 const run=await syntheticRun(image,manifest);
 for(const change of [(v:any)=>v.http=Buffer.from('{"status":200,"rawSha256":"wrong"}'),
  (v:any)=>v.candidate=Buffer.from('{"complete":true}'),(v:any)=>v.tsv=Buffer.from('modified'),
  (v:any)=>v.requestIdentity=Buffer.from(JSON.stringify({...JSON.parse(Buffer.from(v.requestIdentity).toString()),requestSha256:hash('different')}))]){
  const bad=structuredClone(run);change(bad);assert.throws(()=>prepareAuthorImageTableArtifact(bad,image,manifest));
 }
 assert.throws(()=>prepareAuthorImageTableArtifact(run,{...image,source:{...image.source,currentVersionId:'foreign'}},manifest));
 assert.throws(()=>prepareAuthorImageTableArtifact(run,{...image,attachmentId:'foreign'},manifest));
 assert.throws(()=>prepareAuthorImageTableArtifact(run,image,hash('other structure')));
 const bad:any=structuredClone(run),raw=JSON.parse(Buffer.from(bad.rawResponse).toString());raw.model='unknown-provider-model';bad.rawResponse=Buffer.from(JSON.stringify(raw));
 bad.http=Buffer.from(JSON.stringify({status:200,rawSha256:hash(bad.rawResponse)}));assert.throws(()=>prepareAuthorImageTableArtifact(bad,image,manifest));
});
test('author table: complete envelope limit is unavailable without truncation; foreign observation and count overflow reject; default input unchanged',async()=>{
 const grid={complete:true,uncertain:[],tables:[{caption:null,rowCount:12,columnCount:1,cells:Array.from({length:12},(_,row)=>
  ({row,column:0,rowSpan:1,columnSpan:1,headerRole:'none',text:'z'.repeat(4000),bold:'none'}))}]};
 const a=prepareAuthorImageTableArtifact(await syntheticRun(image,manifest,grid),image,manifest),o=prepareAuthorImageTableObservation(candidateFor(a),a,image);
 assert.equal(o.status,'unavailable');assert.equal(o.reason,'observation-byte-limit');assert.equal(o.artifact,undefined);assert.equal(a.grid.tables[0].cells.length,12);
 assertAuthorImageTableObservation(o,image);const bad=structuredClone(o);bad.candidate.attachmentId='foreign';assert.throws(()=>assertAuthorImageTableObservation(bad,image));
 const rehashed=structuredClone(o);rehashed.candidate.artifactSha256=hash('other artifact');
 const {observationSha256:_old,...changed}=rehashed;rehashed.observationSha256=hash(canonical(changed));
 assert.throws(()=>assertAuthorImageTableObservation(rehashed,image),'an outer rehash cannot hide a changed unavailable candidate identity');
 assert.throws(()=>prepareDocumentAnswer('What?',context([o,o,o])));
 const plain=prepareDocumentAnswer('What?',context()),explicit=context();(explicit.images[0] as any).tableObservations=undefined;
 assert.equal(JSON.stringify(plain.input),JSON.stringify(prepareDocumentAnswer('What?',explicit).input));
});
