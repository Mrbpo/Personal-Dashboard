import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {decodeDerivedDoclingResult} from '../lib/kernel/docling-batches.ts';
import {prepareNativeTableArtifact,prepareNativeTableObservation,type DerivedTableCandidate} from '../lib/kernel/document-table-candidates.ts';
import {prepareDocumentAnswer,retainSelectedStoredNodeText,retainSelectedNativeTablePages,buildSelectedDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);

test('selected native table page preserves original image and uncertainty, without importing unrelated page evidence',async()=>{
 const dir=new URL('./fixtures/native-table-mit-class5/',import.meta.url),raw=await readFile(new URL('result.json',dir)),png=await readFile(new URL('source-page.png',dir)),
  meta=JSON.parse(await readFile(new URL('provenance.json',dir),'utf8')),
  native=decodeDerivedDoclingResult(JSON.parse(raw.toString()),{start:1,end:1,totalPages:1,copyIndices:[0]},{verifiedBlankPages:[],formulaEnriched:false}).nativeTables[0];
 native.result={resultBlobSha256:sha(raw),derivedInputSha256:meta.sourcePdfSha256,optionsHash:sha('fixture-options'),copyIndices:[0]};
 const artifact=prepareNativeTableArtifact(native),source={documentId:'fixture-native',currentVersionId:'fixture-current',sourceVersionId:'fixture-source',sourceHash:meta.sourcePdfSha256,courseId:''},
  image={kind:'pdf-page' as const,source,attachmentId:sha('fixture-attachment'),assetId:sha(png),anchorEvidenceId:'fixture-page1',physicalPage:1,rawPdfSha256:source.sourceHash,
   manifestSha256:sha('fixture-manifest'),sha256:sha(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20),byteLength:png.length,mime:'image/png' as const,bytes:png,
   provenance:{rawPdfSha256:source.sourceHash,pageRenderSha256:sha(png),pageSizePoints:{width:612,height:792},rotation:0,rendererPolicy:'component-fixture-only',sourcePageCropBox:{x:0,y:0,width:612,height:792}}},
  identity={namespace:artifact.namespace,producer:artifact.producer,source,artifactSha256:artifact.artifactSha256,manifestSha256:image.manifestSha256,assetSha256:image.sha256,anchor:image.anchorEvidenceId},
  candidate:DerivedTableCandidate={kind:'derived-native-table',id:sha(canonical(identity)),source,pageNumber:1,anchorEvidenceId:image.anchorEvidenceId,
   manifestSha256:image.manifestSha256,assetSha256:image.sha256,artifactSha256:artifact.artifactSha256},
  observation=prepareNativeTableObservation(candidate,artifact,image),
  context:DocumentAnswerContext={sourceContentIsUntrusted:true,parents:[],images:[{...image,tableObservations:[observation]}],
   anchors:[1,2].map(page=>({id:`pg:${source.currentVersionId}:${page}`,document_id:source.documentId,source_version_id:source.sourceVersionId,source_hash:source.sourceHash,
    course_id:'',name:'Component source',origin:'fixture',origin_key:'fixture',body:page===1?'Existing table-page text.':'Unrelated second-page text.',
    locator:`page:${page}`,page_number:page,evidence_id:`fixture-page${page}`,parser_version:'component-fixture-only',score:1,evidence_body:'full-page' as const}))},
  prepared=prepareDocumentAnswer('What result is reported?',context),original=canonical(context),units=prepared.quoteUnits,
  first=units.find(u=>u.supportId==='e0')!,other=units.find(u=>u.supportId==='e1')!,
  selected=retainSelectedStoredNodeText({referenceIds:[first.id]},prepared),retained=retainSelectedNativeTablePages(selected,prepared);
 assert.deepEqual(selected.referenceIds,[first.id]);assert.deepEqual(retained.referenceIds,[first.id,'i0']);
 assert.deepEqual(retained.providerReferenceIds,[first.id]);assert.equal(retained.nativeTablePageRetention?.structureRelationsVerified,false);
 const request=buildSelectedDocumentAnswerRequest(prepared,retained.referenceIds,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000},{scope:'application'}),
  content=request.input.at(-1)!.content as Array<{type:string;text?:string}>;
 assert.equal(content.filter(c=>c.type==='input_image').length,1);assert.ok(JSON.stringify(request).includes('parser-declared-untrusted'));
 assert.deepEqual(prepared.quoteUnits,units);assert.equal(canonical(context),original);assert.equal(observation.semanticVerified,false);assert.equal(observation.relationshipVerified,false);
 for(const referenceIds of [[],[other.id],['i0']]){
  const prior=retainSelectedStoredNodeText({referenceIds},prepared);
  assert.deepEqual(retainSelectedNativeTablePages(prior,prepared).referenceIds,referenceIds);
 }
});
