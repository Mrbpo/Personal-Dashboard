import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {decodeDerivedDoclingResult} from '../lib/kernel/docling-batches.ts';
import {prepareNativeTableArtifact,prepareNativeTableObservation,NATIVE_TABLE_NAMESPACE,NATIVE_TABLE_PRODUCER,
 NATIVE_TABLE_OBSERVATION_LIMITS,type DerivedTableCandidate,type NativeTableObservedImage} from '../lib/kernel/document-table-candidates.ts';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest} from '../lib/kernel/document-citation-audit.ts';
import {mergeStudyEvidence} from '../lib/kernel/service.ts';
import {createDocumentImageBudget} from '../lib/kernel/document-image-budget.ts';
import type {DocumentSelectedNodeHit} from '../lib/kernel/document-evidence.ts';

globalThis.fetch=async()=>{throw Error('Native observation checks prohibit HTTP');};
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown)=>JSON.stringify(v,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
 Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
async function fixture(){
 const dir=resolve('tests/fixtures/native-table-mit-class5');
 const [raw,png,provenance]=await Promise.all(['result.json','source-page.png','provenance.json'].map(name=>readFile(resolve(dir,name))));
 const meta=JSON.parse(provenance.toString('utf8'));assert.equal(sha(raw),meta.rawResultSha256);assert.equal(sha(png),meta.sourcePngSha256);
 const table=decodeDerivedDoclingResult(JSON.parse(raw.toString('utf8')),{start:1,end:1,totalPages:1,copyIndices:[0]},
  {verifiedBlankPages:[],formulaEnriched:false}).nativeTables[0];
 table.result={resultBlobSha256:sha(raw),derivedInputSha256:meta.sourcePdfSha256,optionsHash:sha(JSON.stringify(meta.conversion)),copyIndices:[0]};
 const source={documentId:'saved-mit-'+sha('document'),currentVersionId:sha('version'),sourceVersionId:sha('source-version'),sourceHash:meta.sourcePdfSha256,courseId:''};
 const node:DocumentSelectedNodeHit={id:`pg:${source.currentVersionId}:1`,document_id:source.documentId,source_version_id:source.sourceVersionId,
  source_hash:source.sourceHash,course_id:'',name:'Saved MIT',origin:'public-fixture',origin_key:'saved-mit',body:'Original stored page body.',
  locator:'page:1',page_number:1,evidence_id:'page-evidence',parser_version:'fixture',reader_selection:'evidence-node-ids',
  retrieval_mode:'reader-selection',evidence_body:'full-page'};
 const image:NativeTableObservedImage={kind:'pdf-page',physicalPage:1,attachmentId:sha('attachment'),assetId:sha(png),anchorEvidenceId:node.evidence_id,
  rawPdfSha256:source.sourceHash,manifestSha256:sha('manifest'),source,mime:'image/png',sha256:sha(png),byteLength:png.length,
  width:png.readUInt32BE(16),height:png.readUInt32BE(20),bytes:png,provenance:{rawPdfSha256:source.sourceHash,pageRenderSha256:sha(png),
   pageSizePoints:{width:612,height:792},rotation:0,rendererPolicy:'saved-fixture',sourcePageCropBox:{x:0,y:0,width:612,height:792}}};
 const artifact=prepareNativeTableArtifact(table);
 const candidateFor=(a=artifact):DerivedTableCandidate=>{
  const identity={namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,source,artifactSha256:a.artifactSha256,
   manifestSha256:image.manifestSha256,assetSha256:image.sha256,anchor:image.anchorEvidenceId};
  return {kind:'derived-native-table',id:sha(canonical(identity)),source,pageNumber:1,anchorEvidenceId:image.anchorEvidenceId,
   manifestSha256:image.manifestSha256,assetSha256:image.sha256,artifactSha256:a.artifactSha256};};
 const context=(i:NativeTableObservedImage):DocumentAnswerContext=>({anchors:[],parents:[],imageAnchors:[node],images:[i],sourceContentIsUntrusted:true});
 return {image,context,artifact,candidate:candidateFor(),candidateFor,table};
}

test('native observations: saved cells, spans, flags and raw refs enter actual image input, while local checking still sees only original PNG',async()=>{
 const f=await fixture(),observation=prepareNativeTableObservation(f.candidate,f.artifact,f.image),image={...f.image,tableObservations:[observation]};
 const p=prepareDocumentAnswer('What does the table report?',f.context(image)),plain=prepareDocumentAnswer('What does the table report?',f.context(f.image));
 assert.deepEqual(p.quoteUnits,[]);assert.notEqual(p.fingerprint,plain.fingerprint);
 const request=buildDocumentAnswerRequest(p,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000});
 const input=JSON.parse(String((request.input[1].content as any[])[0].text)),actual=input.evidence[0].tableObservations[0];
 assert.deepEqual(actual.native,f.artifact.native);assert.deepEqual(actual.native.raw.data,f.artifact.native.raw.data);
 assert.deepEqual(actual.native.cellTexts,f.artifact.native.cellTexts);assert.equal(actual.semanticVerified,false);
 assert.equal(actual.relationshipVerified,false);assert.equal(actual.visibilityVerified,false);
 assert.equal(actual.rawProvenancePageBasis,'derived-input-local');assert.equal(actual.rawProvenanceCoordinateMapping,'unverified');
 assert.deepEqual(request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,['i0']);
 const selections={status:'answered' as const,message:'',claims:[{text:'Synthetic claim for transport only.',citations:[{id:'i0'}]}]};
 const local=prepareDocumentCitationAudit('What does the table report?',f.context(image),{inputFingerprint:p.fingerprint,
  quoteUnitManifestSha256:p.quoteUnitManifestSha256,providerSelections:selections,claimIndex:0});
 const localRequest=buildDocumentCitationAuditRequest(local.packet);
 assert.equal(JSON.stringify(localRequest).includes("Gaussian 'Pillbox'"),false,'parser declarations cannot rescue local image entailment');
 assert.equal((localRequest.input[1].content as any[]).filter(i=>i.type==='input_image').length,1);
});

test('native observations: foreign source, version, PNG and artifact mutations reject; oversized observation stays unavailable beside unchanged PNG',async()=>{
 const f=await fixture(),observation=prepareNativeTableObservation(f.candidate,f.artifact,f.image);
 for(const change of [
  (o:any)=>o.candidate.source.documentId='foreign',
  (o:any)=>o.candidate.source.currentVersionId='old-version',
  (o:any)=>o.candidate.assetSha256='f'.repeat(64),
  (o:any)=>o.candidate.artifactSha256='e'.repeat(64),
  (o:any)=>o.result.optionsHash='d'.repeat(64),
  (o:any)=>o.native.raw.data.table_cells[0].text='altered'
 ]){const modified=structuredClone(observation);change(modified);
  const item=modified.candidate;item.id=sha(canonical({namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,
   source:item.source,artifactSha256:item.artifactSha256,manifestSha256:item.manifestSha256,assetSha256:item.assetSha256,anchor:item.anchorEvidenceId}));
  const {observationSha256:_old,...value}=modified;modified.observationSha256=sha(canonical(value));
  assert.throws(()=>prepareDocumentAnswer('What?',f.context({...f.image,tableObservations:[modified]})));}
 const foreignSource={...f.image.source,documentId:'foreign-doc',currentVersionId:sha('foreign-version'),sourceVersionId:sha('foreign-source')};
 const foreignImage={...f.image,source:foreignSource},foreignCandidate={...f.candidate,source:foreignSource};
 foreignCandidate.id=sha(canonical({namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,source:foreignSource,
  artifactSha256:foreignCandidate.artifactSha256,manifestSha256:foreignCandidate.manifestSha256,
  assetSha256:foreignCandidate.assetSha256,anchor:foreignCandidate.anchorEvidenceId}));
 const validForeign=prepareNativeTableObservation(foreignCandidate,f.artifact,foreignImage);
 assert.throws(()=>prepareDocumentAnswer('What?',f.context({...f.image,tableObservations:[validForeign]})),
  'a valid, consistently hashed observation for another document/version cannot attach to the original image');
 assert.throws(()=>prepareDocumentAnswer('What?',f.context({...f.image,bytes:Buffer.alloc(f.image.byteLength),tableObservations:[observation]})),/checksum/);
 const large=structuredClone(f.table);large.raw.originalPadding='x'.repeat(40000);
 const artifact=prepareNativeTableArtifact(large),unavailable=prepareNativeTableObservation(f.candidateFor(artifact),artifact,f.image);
 assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.reason,'observation-byte-limit');assert.equal(unavailable.native,undefined);
 const p=prepareDocumentAnswer('What?',f.context({...f.image,tableObservations:[unavailable]}));
 assert.equal(p.supports[0].image?.sha256,f.image.sha256);assert.deepEqual(p.supports[0].image?.bytes,f.image.bytes);
 assert.equal(p.input.evidence[0].tableObservations?.[0].candidate.artifactSha256,artifact.artifactSha256);
 assert.deepEqual(artifact.native,large,'full immutable artifact is not truncated');
 const near=structuredClone(f.table);near.raw.transportPadding='';
 const emptyArtifact=prepareNativeTableArtifact(near),empty=prepareNativeTableObservation(f.candidateFor(emptyArtifact),emptyArtifact,f.image);
 near.raw.transportPadding='x'.repeat(NATIVE_TABLE_OBSERVATION_LIMITS.bytes-Buffer.byteLength(canonical(empty))+8);
 const nearArtifact=prepareNativeTableArtifact(near),nearLimit=prepareNativeTableObservation(f.candidateFor(nearArtifact),nearArtifact,f.image);
 assert.equal(nearLimit.status,'unavailable');assert.ok(nearLimit.nativeByteLength+1024<=NATIVE_TABLE_OBSERVATION_LIMITS.bytes,
  'valid near-boundary native fits a guessed 1024-byte envelope but its exact transport does not');
 prepareDocumentAnswer('What?',f.context({...f.image,tableObservations:[nearLimit]}));
});

test('native observations: merge retains base observation without changing original image duplicate checks or legacy no-observation input',async()=>{
 const f=await fixture(),observation=prepareNativeTableObservation(f.candidate,f.artifact,f.image),observed={...f.image,tableObservations:[observation]};
 const budget=createDocumentImageBudget();assert.equal(budget.include(observed,1),true);assert.equal(budget.include(f.image,2),true);
 assert.equal(budget.snapshot().accounting.images,1);
 assert.throws(()=>budget.include({...f.image,manifestSha256:sha('other-manifest')},3),/Conflicting duplicate/);
 const merged=mergeStudyEvidence(f.context(observed),f.context(f.image));assert.ok(merged);
 assert.deepEqual((merged.images[0] as NativeTableObservedImage).tableObservations,[observation]);
 prepareDocumentAnswer('What?',merged);
 const invalid={...observed,tableObservations:[{...observation,attachmentId:sha('different')}]};
 assert.throws(()=>prepareDocumentAnswer('What?',f.context(invalid)),'budget dedupe does not grant observation authority');
 const plain=prepareDocumentAnswer('What?',f.context(f.image)),explicit=prepareDocumentAnswer('What?',f.context({...f.image,tableObservations:undefined}));
 assert.equal(JSON.stringify(plain.input),JSON.stringify(explicit.input));assert.equal(plain.fingerprint,explicit.fingerprint);
 assert.equal('tableObservations' in plain.input.evidence[0],false);
});
