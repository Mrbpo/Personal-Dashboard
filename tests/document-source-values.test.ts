import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {prepareSourceValueCatalog,deriveSourceValueAnswer,sourceDecimalDifference,type SourceValueCatalog,type SourceValueImage} from '../lib/kernel/document-source-values.ts';
import {prepareDocumentAnswerForPolicy,prepareSelectedSourceValueGeneration,buildSelectedDocumentAnswerRequest,buildDocumentEvidenceSelectionRequest,
 synthesizeDocumentAnswer,documentAnswerSettings,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {resolveSourceValueEvidenceSelection,validateDocumentEvidenceSelection} from '../lib/kernel/document-answer.ts';
import {prepareDocumentCitationAudit,buildDocumentCitationAuditRequest} from '../lib/kernel/document-citation-audit.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS} from '../lib/kernel/document-context.ts';
import {decodeDerivedDoclingResult} from '../lib/kernel/docling-batches.ts';
import {prepareNativeTableArtifact,prepareNativeTableObservation,type DerivedTableCandidate} from '../lib/kernel/document-table-candidates.ts';
import {studySourceValues,StudyAnswerError} from '../lib/study-answer.ts';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
process.env.DATABASE_URL=':memory:';process.env.AI_BUDGET_TEST_BYPASS='true';
const check={mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}};
const off={scope:'application' as const,model:'gpt-5.4-mini' as const,evidenceSelection:'select-then-answer' as const,citationCheck:check,maxOutputTokens:3000};
const policy={...off,sourceValueContract:'difference-v1' as const},settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000};
async function fixture(){
 const base=new URL('./fixtures/source-values-author23/',import.meta.url),meta=JSON.parse(await readFile(new URL('selected-image.json',base),'utf8')),
  png=await readFile(new URL('original.png',base)),provenance=JSON.parse(await readFile(new URL('provenance.json',base),'utf8'));
 assert.equal(sha(png),provenance.originalPngSha256);assert.equal(sha(JSON.stringify(meta,null,2)+'\n'),provenance.selectedImageMetadataSha256);
 const image={attachmentId:meta.attachmentId,assetId:meta.sha256,sha256:meta.sha256,byteLength:png.length,mime:'image/png' as const,
  width:meta.width,height:meta.height,bytes:png,captionEvidenceId:meta.evidenceId,source:meta.tableObservations[0].candidate.source,
  tableObservations:meta.tableObservations};
 // A component context, not a newly registered current source/fidelity result.
 const context:DocumentAnswerContext={anchors:[{id:'pg:synthetic-other-version:1',document_id:'synthetic-other-source',source_version_id:'other-source-version',
  source_hash:sha('other'),course_id:'',name:'Other source',origin:'fixture',origin_key:'other',body:'An unrelated original statement is retained.',
  locator:'original:1',page_number:1,evidence_id:'other-evidence',parser_version:'fixture',score:1,evidence_body:'full-page'}],parents:[],sourceContentIsUntrusted:true,
  images:[image],imageAnchors:[{id:`pg:${image.source.currentVersionId}:1`,document_id:image.source.documentId,source_version_id:image.source.sourceVersionId,
   source_hash:image.source.sourceHash,course_id:image.source.courseId??'',name:'Frozen public figure',origin:'fixture',origin_key:'frozen-author-image',
   body:'Offline source-image binding fixture only.',locator:'fixture-caption',page_number:1,evidence_id:image.captionEvidenceId,parser_version:'frozen-fixture',
   reader_selection:'evidence-node-ids',retrieval_mode:'reader-selection',evidence_body:'full-page'}]};
 return {meta,image,context,sourceImage:{...meta,image} as SourceValueImage,base};
}
function operation(c:SourceValueCatalog){
 const at=(row:number,col:number)=>c.cells.find(cell=>cell.row===row&&cell.column===col)!;
 return {kind:'difference' as const,leftValueRef:at(10,3).id,rightValueRef:at(9,3).id,leftRowLabelRef:at(10,0).id,rightRowLabelRef:at(9,0).id,
  columnLabelRefs:[at(0,3).id,at(1,3).id]};
}
const raw=(op:unknown)=>({status:'answered',message:'',claims:[op]});
test('source values: actual saved generation AST yields exact .14 and original PNG refs without rewriting the old wrong raw',async()=>{
 const f=await fixture(),catalog=prepareSourceValueCatalog([f.sourceImage]);assert.equal(catalog.status,'available');
 const value=raw(operation(catalog)),r=deriveSourceValueAnswer(value,JSON.stringify(value),catalog,[f.meta.id]);
 assert.equal(r.operations[0].difference,'0.14');assert.equal(r.operations[0].sourceCells[0].text,'66.31');assert.equal(r.operations[0].sourceCells[1].text,'66.17');
 assert.match(r.normalizedSelections.claims[0].text,/66\.31.*66\.17.*0\.14/);assert.match(r.normalizedSelections.claims[0].text,/Accuracy\/%.+VQA-2.0/);
 assert.deepEqual(r.normalizedSelections.claims[0].citations,[{id:f.meta.id}]);assert.equal(r.operations[0].sourceTable.imageSha256,f.image.sha256);
 assert.equal(r.operations[0].semanticVerified,false);assert.equal(r.operations[0].relationshipVerified,false);assert.equal(r.operations[0].visibilityVerified,false);
 const old=JSON.parse(await readFile(new URL('old-provider.raw.json',f.base),'utf8')),oldText=old.output_text||old.output.flatMap((x:any)=>x.content??[]).map((x:any)=>x.text??'').join('');
 assert.throws(()=>deriveSourceValueAnswer(JSON.parse(oldText),oldText,catalog,[f.meta.id]),'old free claims are not a new ID-only operation result');
 assert.equal(sourceDecimalDifference('66.31','65.36'),'0.95');
 for(const bad of ['-','','1e2','1,000','2%',' 1'])assert.throws(()=>sourceDecimalDifference(bad,'0'));
 assert.equal(r.operations[0].sourceCells.at(-2)!.headerRole,'section','explicit section text is retained without inferring a hierarchy or unit conversion');
});
test('source values: cell/source mutations, wrong columns/missing values, foreign tables and complete catalog bounds fail closed',async()=>{
 const f=await fixture(),c=prepareSourceValueCatalog([f.sourceImage]),op=operation(c);
 for(const change of [(s:any)=>s.documentVersionId='changed',(s:any)=>s.sha256=sha('changed'),
  (s:any)=>s.tableObservations[0].candidate.artifactSha256=sha('changed'),(s:any)=>s.tableObservations[0].artifact.grid.tables[0].cells[0].text='changed']){
  const s=structuredClone(f.sourceImage);change(s);assert.throws(()=>prepareSourceValueCatalog([s]));
 }
 const changed=structuredClone(c);changed.cells[0].text='changed';const{catalogSha256:_old,...rest}=changed;changed.catalogSha256=sha(canonical(rest));
 assert.throws(()=>deriveSourceValueAnswer(raw(op),JSON.stringify(raw(op)),changed,[f.meta.id]));
 for(const bad of [{...op,leftValueRef:'unknown'}, {...op,rightValueRef:c.cells.find(c=>c.row===6&&c.column===2)!.id},
  {...op,rightValueRef:c.cells.find(c=>c.text==='-')!.id},{...op,difference:'0.14',citations:[{id:'q:wrong'}]}])
  assert.throws(()=>deriveSourceValueAnswer(raw(bad),JSON.stringify(raw(bad)),c,[f.meta.id]));
 assert.throws(()=>deriveSourceValueAnswer(raw(op),JSON.stringify(raw(op)),c,['q:only-text']));
 const many=Array.from({length:7},(_,i)=>({...f.sourceImage,id:'synthetic-alias-'+i}));
 const limited=prepareSourceValueCatalog(many);assert.equal(limited.status,'unavailable');assert.equal(limited.reason,'catalog-cell-limit');
 assert.equal(limited.complete,false);assert.deepEqual(limited.cells,[]);
 const byteLimited=prepareSourceValueCatalog(many.slice(0,4));assert.equal(byteLimited.status,'unavailable');assert.equal(byteLimited.reason,'catalog-byte-limit');assert.deepEqual(byteLimited.cells,[]);
 const dir=new URL('./fixtures/native-table-mit-class5/',import.meta.url),nativeRaw=await readFile(new URL('result.json',dir)),png=await readFile(new URL('source-page.png',dir)),
  meta=JSON.parse(await readFile(new URL('provenance.json',dir),'utf8'));
 const n=decodeDerivedDoclingResult(JSON.parse(nativeRaw.toString()),{start:1,end:1,totalPages:1,copyIndices:[0]},{verifiedBlankPages:[],formulaEnriched:false}).nativeTables[0];
 n.result={resultBlobSha256:sha(nativeRaw),derivedInputSha256:meta.sourcePdfSha256,optionsHash:sha('saved-options'),copyIndices:[0]};
 const artifact=prepareNativeTableArtifact(n),source={documentId:'saved-native-fixture',currentVersionId:'saved-current',sourceVersionId:'saved-source',sourceHash:meta.sourcePdfSha256,courseId:''};
 const img:any={kind:'pdf-page',source,attachmentId:sha('native-attachment'),anchorEvidenceId:'native-page',physicalPage:1,rawPdfSha256:source.sourceHash,
  manifestSha256:sha('saved-manifest'),sha256:sha(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
 const identity={namespace:artifact.namespace,producer:artifact.producer,source,artifactSha256:artifact.artifactSha256,manifestSha256:img.manifestSha256,
  assetSha256:img.sha256,anchor:img.anchorEvidenceId};
 const candidate:DerivedTableCandidate={kind:'derived-native-table',id:sha(canonical(identity)),source,pageNumber:1,anchorEvidenceId:img.anchorEvidenceId,
  manifestSha256:img.manifestSha256,assetSha256:img.sha256,artifactSha256:artifact.artifactSha256};
 const observed={id:'i9',kind:'image' as const,documentId:source.documentId,documentVersionId:source.currentVersionId,sourceVersionId:source.sourceVersionId,
  sourceHash:source.sourceHash,evidenceId:img.anchorEvidenceId,sha256:img.sha256,image:img,tableObservations:[prepareNativeTableObservation(candidate,artifact,img)]};
 const both=prepareSourceValueCatalog([f.sourceImage,observed]);assert.equal(both.status,'available');assert.equal(both.tables[1].producer,'docling-native-table-v1');
 assert.deepEqual(both.cells.filter(x=>x.tableId===both.tables[1].id).map(x=>x.text),n.cellTexts.map(x=>x.text));
 const foreign={...op,rightValueRef:both.cells.find(cell=>cell.tableId===both.tables[1].id)!.id};
 assert.throws(()=>deriveSourceValueAnswer(raw(foreign),JSON.stringify(raw(foreign)),both,[f.meta.id,'i9']));
});
test('source values: selector/off generator bytes stay exact, only selected PNG values enter, and actual request overflow retains the old request',async()=>{
 const f=await fixture(),p=prepareDocumentAnswerForPolicy('A comparison?',f.context,off),ids=[p.quoteUnits[0].id,'i0'];
 assert.equal(JSON.stringify(buildDocumentEvidenceSelectionRequest(p,settings,off)),JSON.stringify(buildDocumentEvidenceSelectionRequest(p,settings,policy)));
 assert.equal(JSON.stringify(buildSelectedDocumentAnswerRequest(p,ids,settings,off)),JSON.stringify(buildSelectedDocumentAnswerRequest(p,ids,settings,policy)));
 const noImage=prepareSelectedSourceValueGeneration(p,[ids[0]],settings,policy);assert.equal(noImage.applied,false);
 assert.equal(JSON.stringify(noImage.request),JSON.stringify(buildSelectedDocumentAnswerRequest(p,[ids[0]],settings,off)));
 const actual=prepareSelectedSourceValueGeneration(p,ids,settings,policy);assert.equal(actual.applied,true);assert.equal(actual.request.text.format.name,'grounded_document_source_values_v1');
 assert.equal(actual.catalog.tables[0].imageId,'i0');assert.equal((actual.request.input.at(-1)!.content as any[]).filter((x:any)=>x.type==='input_image').length,1);
 const old=buildSelectedDocumentAnswerRequest(p,ids,settings,off),nonImage=(r:unknown)=>Buffer.byteLength(JSON.stringify(r,(k,v)=>k==='image_url'?'data:image/png;base64,':v));
 const budget=COMPLETE_DOCUMENT_SOURCE_LIMITS,imageTokens=2*Math.ceil(f.image.width/32)*Math.ceil(f.image.height/32)+1;
 p.warnings.push('x'.repeat(budget.requestInputTokens-budget.framingTokens-imageTokens-nonImage(old)-1024));
 const ordinary=buildSelectedDocumentAnswerRequest(p,ids,settings,off),full=prepareSelectedSourceValueGeneration(p,ids,settings,policy);
 assert.ok(nonImage(ordinary)+budget.framingTokens+imageTokens<budget.requestInputTokens);assert.equal(full.applied,false);assert.equal(full.reason,'selected-request-input-limit');
 assert.equal(JSON.stringify(full.request),JSON.stringify(ordinary));
 assert.equal(studySourceValues('off'),undefined);assert.equal(studySourceValues('difference-v1'),'difference-v1');assert.throws(()=>studySourceValues('typo'),StudyAnswerError);
 await assert.rejects(documentAnswerSettings({...policy,evidenceSelection:undefined}));await assert.rejects(documentAnswerSettings({...policy,citationCheck:undefined}));
});
test('source values: new raw persists before invalid operations, valid mixed statements keep their citations, and PNG-only audits use explicit normalized claims',async()=>{
 const f=await fixture(),p=prepareDocumentAnswerForPolicy('A comparison?',f.context,off),ids=[p.quoteUnits[0].id,'i0'],g=prepareSelectedSourceValueGeneration(p,ids,settings,policy);
 assert.equal(g.applied,true);const saved=globalThis.fetch,events:string[]=[],records:any[]=[];let calls=0,invalid=true;
 const statementText='The other source supplies a statement.';
 const mixed={status:'answered',message:'',claims:[{kind:'statement',text:statementText,citations:[{id:ids[0]}]},operation(g.catalog)]};
 const rawOutput=(x:unknown)=>Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:1,output_tokens:1},output_text:JSON.stringify(x)});
 try{
  globalThis.fetch=async()=>{calls++;return rawOutput(calls%2===1?{referenceIds:ids}:invalid?raw({...operation(g.catalog),rightValueRef:'unknown'}):mixed);};
  const runPolicy={...policy,recordSourceValueRawResponse:async(r:any)=>{events.push('raw');records.push(r);},recordSourceValueDerivation:async(r:any)=>{events.push('derived');records.push(r);}};
  await assert.rejects(synthesizeDocumentAnswer('A comparison?',async()=>f.context,runPolicy),/Unknown source cell/);assert.equal(calls,2);assert.deepEqual(events,['raw']);
  assert.match(records[0].rawBody,/unknown/);assert.equal(sha(records[0].rawBody),records[0].rawSha256);
  invalid=false;events.length=0;records.length=0;
  const result=await synthesizeDocumentAnswer('A comparison?',async()=>f.context,runPolicy);assert.equal(calls,4);assert.deepEqual(events,['raw','derived']);
  assert.equal(result.providerSelections,null);assert.ok('sourceValueDerivation' in result&&result.sourceValueDerivation);
  const d=result.sourceValueDerivation!;assert.equal(d.providerRequestSha256,result.providerRequestSha256);assert.equal(d.sourceInputFingerprint,result.inputFingerprint);
  assert.equal(d.normalizedSelections.claims[0].text,statementText);assert.deepEqual(d.normalizedSelections.claims[0].citations,[{id:ids[0]}]);
  assert.deepEqual(d.normalizedSelections.claims[1].citations,[{id:'i0'}]);assert.deepEqual(d.rawProviderResult,mixed);
  const local=prepareDocumentCitationAudit('A comparison?',f.context,{inputFingerprint:result.inputFingerprint,quoteUnitManifestSha256:result.quoteUnitManifestSha256,
   providerSelections:d.normalizedSelections,claimIndex:1,unitPolicy:'author-image-caption-v1'});
  const audit=buildDocumentCitationAuditRequest(local.packet);assert.equal(JSON.stringify(audit).includes('tableObservations'),false);
  assert.equal((audit.input.at(-1)!.content as any[]).filter((x:any)=>x.type==='input_image').length,1);
 }finally{globalThis.fetch=saved;}
});

test('table retention: legal duplicate suggestions remain distinct from current bound-table retention and actual generator input',async()=>{
 const f=await fixture(),base=f.context.anchors[0];
 f.context.anchors.push(...[2,3].map(i=>({...base,id:`pg:other-version-${i}:1`,document_id:`other-source-${i}`,source_version_id:`other-sv-${i}`,
  source_hash:sha('other-'+i),body:`Other original source statement ${i}.`,evidence_id:`other-evidence-${i}`})));
 const p=prepareDocumentAnswerForPolicy('A table question?',f.context,off),q=p.quoteUnits.filter(u=>u.selectable).map(u=>u.id),
  value={referenceIds:[q[0],q[1],q[2],q[0],q[0],q[0]]},before=JSON.stringify(value);
 const resolution=resolveSourceValueEvidenceSelection(value,p);
 assert.deepEqual(resolution.providerReferenceIds,value.referenceIds);assert.deepEqual(resolution.normalizedProviderReferenceIds,q);
 assert.deepEqual(resolution.systemRetainedReferenceIds,['i0']);assert.deepEqual(resolution.referenceIds,[...q,'i0']);assert.equal(JSON.stringify(value),before);
 assert.equal(resolution.retentionPolicy,'source-value-retain-bound-table-images-v1');
 assert.throws(()=>validateDocumentEvidenceSelection(value,p),'the default strict validator still rejects duplicate suggestions');
 assert.equal(JSON.stringify(buildDocumentEvidenceSelectionRequest(p,settings,off)),JSON.stringify(buildDocumentEvidenceSelectionRequest(p,settings,policy)));
 const saved=globalThis.fetch;let calls=0,actualGenerator:any;
 try{
  globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));
   if(calls===2)actualGenerator=request;
   return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:1,output_tokens:1},
    output_text:JSON.stringify(calls===1?value:{status:'answered',message:'',claims:[{kind:'statement',text:p.quoteUnits[0].text,citations:[{id:q[0]}]}]})});
  };
  const result=await synthesizeDocumentAnswer('A table question?',async()=>f.context,{...policy,recordSourceValueRawResponse:async()=>{},recordSourceValueDerivation:async()=>{}});
  assert.equal(calls,2);assert.ok('evidenceSelection' in result);const selection=result.evidenceSelection;
  assert.deepEqual(selection?.providerReferenceIds,value.referenceIds);
  assert.deepEqual(selection?.normalizedProviderReferenceIds,q);assert.deepEqual(selection?.systemRetainedReferenceIds,['i0']);
  assert.deepEqual(selection?.referenceIds,[...q,'i0']);assert.equal(selection?.outcome,'provided-with-system-retention');
  const content=actualGenerator.input.at(-1).content,packet=JSON.parse(content[0].text);
  assert.equal(content.filter((part:any)=>part.type==='input_image').length,1);assert.equal(packet.sourceValueCatalog.tables[0].imageId,'i0');
  assert.deepEqual(result.selectedUnits.map(unit=>unit.selectionId),[q[0]],'retaining a table never silently adds it to a statement citation');
 }finally{globalThis.fetch=saved;}
});

test('table retention: unknown and original/effective capacity remain strict; empty advice retains only available current table images',async()=>{
 const f=await fixture(),p=prepareDocumentAnswerForPolicy('A table question?',f.context,off),q=p.quoteUnits[0].id;
 for(const value of [{referenceIds:[q,'outside-context']},{referenceIds:[q,1]},{referenceIds:Array(65).fill(q)},
  {referenceIds:[q],extra:true},{referenceIds:'not-array'},{}])assert.throws(()=>resolveSourceValueEvidenceSelection(value,p));
 assert.deepEqual(resolveSourceValueEvidenceSelection({referenceIds:[]},p).referenceIds,['i0']);
 assert.deepEqual(resolveSourceValueEvidenceSelection({referenceIds:['i0']},p).systemRetainedReferenceIds,[],'already suggested image is not falsely attributed as a system addition');
 const plainContext={...f.context,images:[{...f.image,tableObservations:undefined}]},plain=prepareDocumentAnswerForPolicy('A table question?',plainContext,off);
 assert.deepEqual(resolveSourceValueEvidenceSelection({referenceIds:[]},plain).referenceIds,[]);
 assert.deepEqual(validateDocumentEvidenceSelection({referenceIds:[]},plain),[],'no table leaves the existing neutral insufficient-evidence path intact');
 const unavailable=structuredClone(p);for(const s of unavailable.supports)for(const o of s.tableObservations??[])o.status='unavailable';
 assert.deepEqual(resolveSourceValueEvidenceSelection({referenceIds:[]},unavailable).referenceIds,[],'an unavailable observation is never promoted by the resolver');
 const large=structuredClone(f.context);large.anchors[0].body='word '.repeat(16000);
 const full=prepareDocumentAnswerForPolicy('A table question?',large,off),sixtyFour=full.quoteUnits.filter(u=>u.selectable).slice(0,64).map(u=>u.id);
 assert.equal(sixtyFour.length,64);assert.equal(validateDocumentEvidenceSelection({referenceIds:sixtyFour},full).length,64);
 assert.throws(()=>resolveSourceValueEvidenceSelection({referenceIds:sixtyFour},full),/64-reference limit/,'65 effective references reject rather than dropping sources');
});
