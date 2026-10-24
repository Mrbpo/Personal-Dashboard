import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {prepareDocumentAnswer,retainSelectedStoredNodeText,retainSelectedNativeTablePages,buildSelectedDocumentAnswerRequest,
 type DocumentAnswerContext,type StoredNodeTextSelection} from '../lib/kernel/document-answer.ts';

const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
async function fixture():Promise<DocumentAnswerContext>{
 const png=await readFile(new URL('./fixtures/native-table-mit-class5/source-page.png',import.meta.url));
 const anchors=[['a',1],['a',2],['b',1]].map(([doc,p])=>{
  const id=String(doc),page=Number(p);return {id:`pg:v-${id}:${page}`,document_id:id,source_version_id:`sv-${id}`,source_hash:sha(id),
   course_id:'',name:`Source ${id}`,origin:'fixture',origin_key:id,body:`Original extracted notation on ${id} page ${page}.`,
   locator:`page:${page}`,page_number:page,evidence_id:`${id}-page-${page}`,parser_version:'transport-fixture',score:1,evidence_body:'full-page' as const};
 });
 return {sourceContentIsUntrusted:true,parents:[],anchors,images:anchors.map(a=>({kind:'pdf-page' as const,
  source:{documentId:a.document_id,currentVersionId:`v-${a.document_id}`,sourceVersionId:a.source_version_id,sourceHash:a.source_hash,courseId:''},
  attachmentId:sha(a.evidence_id),assetId:sha(png),anchorEvidenceId:a.evidence_id,physicalPage:a.page_number,rawPdfSha256:a.source_hash,
  manifestSha256:sha('manifest-'+a.document_id),sha256:sha(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20),
  byteLength:png.length,mime:'image/png' as const,bytes:png,
  provenance:{rawPdfSha256:a.source_hash,pageRenderSha256:sha(png),pageSizePoints:{width:612,height:792},rotation:0,
   rendererPolicy:'transport-fixture-only',sourcePageCropBox:{x:0,y:0,width:612,height:792}}}))};
}

test('explicit selected text retains its registered original page without parser table/formula labels',async()=>{
 const c=await fixture(),p=prepareDocumentAnswer('Explain the printed notation.',c),before=JSON.stringify(p),
  id=p.quoteUnits.find(u=>u.supportId==='e0')!.id,selected=retainSelectedStoredNodeText({referenceIds:[id]},p),
  result=retainSelectedNativeTablePages(selected,p);
 assert.deepEqual(result.referenceIds,[id,'i0']);assert.deepEqual(result.providerReferenceIds,[id]);
 assert.deepEqual(result.systemRetainedReferenceIds,['i0']);assert.equal(result.nativeTablePageRetention,undefined);
 assert.deepEqual(result.originalPageImageRetention,{policy:'provider-selected-text-original-page-v1',retainedImageIds:['i0'],skippedImageIds:[],
  pairs:[{imageId:'i0',supportIds:['e0'],relation:'same-stored-pdf-page',semanticRelationsVerified:false}],
  inputScope:'already-retrieved-original-page-images',structureRelationsVerified:false});
 const request=buildSelectedDocumentAnswerRequest(p,result.referenceIds,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000},{scope:'application'}),
  content=request.input.at(-1)!.content as Array<{type:string;text?:string;image_url?:string}>,packet=JSON.parse(content[0].text!);
 const pixels=content.filter(c=>c.type==='input_image');assert.equal(pixels.length,1);
 assert.equal(sha(Buffer.from(pixels[0].image_url!.split(',')[1],'base64')),c.images[0].sha256);
 assert.deepEqual(packet.quoteUnits.map((u:{text:string})=>u.text),[c.anchors[0].body]);
 assert.equal(packet.evidenceSelection.coverage,'unassessed');assert.equal(JSON.stringify(p),before);
 assert.deepEqual(retainSelectedNativeTablePages(result,p),result,'pairing is idempotent');
});

test('system-retained or unrelated page text cannot expand original images; no empty-selection promotion',async()=>{
 const c=await fixture(),p=prepareDocumentAnswer('Which notation?',c),a=p.quoteUnits.find(u=>u.supportId==='e0')!.id,
  b=p.quoteUnits.find(u=>u.supportId==='e1')!.id,selected=retainSelectedStoredNodeText({referenceIds:[a]},p),
  withSystemText:StoredNodeTextSelection={...selected,referenceIds:[a,b],systemRetainedReferenceIds:[b]},
  result=retainSelectedNativeTablePages(withSystemText,p);
 assert.deepEqual(result.referenceIds,[a,b,'i0']);assert.deepEqual(result.originalPageImageRetention?.retainedImageIds,['i0']);
 assert.ok(!result.referenceIds.includes('i1')&&!result.referenceIds.includes('i2'),'other page and document originals stay excluded');
 assert.deepEqual(retainSelectedNativeTablePages(retainSelectedStoredNodeText({referenceIds:[]},p),p).referenceIds,[]);
 for(const key of ['documentId','documentVersionId','sourceVersionId','sourceHash','evidenceId'] as const){
  const changed=structuredClone(p);changed.supports.find(s=>s.id==='i0')![key]='mismatched-'+key;
  const r=retainSelectedNativeTablePages(selected,changed);assert.deepEqual(r.referenceIds,[a],`${key} mismatch must prevent image promotion`);
 }
 const region=structuredClone(p),image=region.supports.find(s=>s.id==='i0')!;
 if(!image.image||!('kind' in image.image))throw new Error('Fixture requires PDF image');
 image.image.kind='pdf-region';
 assert.deepEqual(retainSelectedNativeTablePages(selected,region).referenceIds,[a],'a region must not be treated as a complete original page');
});

test('original image retention records the existing reference cap without removing selected text',async()=>{
 const c=await fixture();c.anchors[1].body='Original paragraph. '.repeat(16000);
 const p=prepareDocumentAnswer('Compare pages.',c),first=p.quoteUnits.find(u=>u.supportId==='e0')!.id,
  ids=[first,...p.quoteUnits.filter(u=>u.supportId==='e1').slice(0,63).map(u=>u.id)];assert.equal(ids.length,64);
 const selected=retainSelectedStoredNodeText({referenceIds:ids},p),result=retainSelectedNativeTablePages(selected,p);
 assert.deepEqual(result.referenceIds,ids);assert.deepEqual(result.originalPageImageRetention?.retainedImageIds,[]);
 assert.deepEqual(result.originalPageImageRetention?.skippedImageIds,['i0','i1']);
 assert.equal(result.originalPageImageRetention?.structureRelationsVerified,false);
});
