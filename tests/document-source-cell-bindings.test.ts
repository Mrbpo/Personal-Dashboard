import {test} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {readFile} from 'node:fs/promises';
import {prepareNativeTableArtifact,prepareNativeTableObservation,NATIVE_TABLE_NAMESPACE,NATIVE_TABLE_PRODUCER} from '../lib/kernel/document-table-candidates.ts';
import {prepareSourceCellBindingCatalog,deriveSourceCellBindingAnswer,sourceCellBindingAnswerSchema} from '../lib/kernel/document-source-cell-bindings.ts';
import type {DoclingNativeTable} from '../lib/kernel/docling-result.ts';
import {prepareDocumentAnswerForPolicy,prepareSelectedSourceValueGeneration,synthesizeDocumentAnswer,documentSourceGenerationRoute,resolveSourceValueEvidenceSelection,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
globalThis.fetch=async()=>{throw Error('Cell binding component tests forbid provider calls');};
async function fixture(omitRowLabel=false,unknownHeader=false,allRowLabelsUnknown=false){
 const png=await readFile(new URL('./fixtures/native-table-mit-class5/source-page.png',import.meta.url)),
  cell=(r:number,c:number,text:string,role='none',span=1)=>({start_row_offset_idx:r,end_row_offset_idx:r+1,start_col_offset_idx:c,end_col_offset_idx:c+span,
   row_span:1,col_span:span,row_header:role==='row',column_header:role==='column',row_section:false,text}),
  raw=[cell(0,1,'Model A','column',2),cell(0,3,'Model B','column',2),cell(1,1,'ppl','column'),cell(1,2,'BLEU','column'),cell(1,3,'ppl','column'),cell(1,4,'BLEU','column'),
   cell(2,0,'Zh','row'),cell(2,1,'8.92'),cell(2,2,'5.32'),cell(2,3,'9.53'),cell(2,4,'5.48'),
   cell(3,0,'Fr','row'),cell(3,1,'9.68'),cell(3,2,'1.95'),cell(3,3,'9.90'),cell(3,4,'2.03')].filter(c=>!omitRowLabel||c.start_row_offset_idx!==2||c.start_col_offset_idx!==0)
    .map((c,i)=>unknownHeader&&i===0?{...c,row_header:true}:allRowLabelsUnknown&&c.row_header?{...c,column_header:true}:c),
  native:DoclingNativeTable={reference:'#/tables/0',pageNumbers:[1],raw:{data:{num_rows:4,num_cols:5,table_cells:raw}},
   cellTexts:raw.map((c,cellIndex)=>({cellIndex,text:c.text})),captions:[],result:{resultBlobSha256:sha('synthetic-result'),derivedInputSha256:sha('synthetic-pdf'),optionsHash:sha('synthetic-options'),copyIndices:[0]}};
 // Synthetic geometry/values on an unchanged fixture PNG: never a PDF fidelity score.
 const artifact=prepareNativeTableArtifact(native),source={documentId:'component-doc',currentVersionId:sha('v'),sourceVersionId:sha('s'),sourceHash:sha('synthetic-pdf')},
  image={kind:'pdf-page' as const,physicalPage:1,attachmentId:sha('attachment'),assetId:sha(png),anchorEvidenceId:'page-evidence',rawPdfSha256:source.sourceHash,
   manifestSha256:sha('manifest'),source,mime:'image/png' as const,sha256:sha(png),byteLength:png.length,width:png.readUInt32BE(16),height:png.readUInt32BE(20),bytes:png,
   provenance:{rawPdfSha256:source.sourceHash,pageRenderSha256:sha(png),pageSizePoints:{width:612,height:792},rotation:0,rendererPolicy:'synthetic-component-fixture',sourcePageCropBox:{x:0,y:0,width:612,height:792}}},
  identity={namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,source,artifactSha256:artifact.artifactSha256,manifestSha256:image.manifestSha256,assetSha256:image.sha256,anchor:image.anchorEvidenceId},
  candidate={kind:'derived-native-table' as const,id:sha(canonical(identity)),source,pageNumber:1,anchorEvidenceId:image.anchorEvidenceId,manifestSha256:image.manifestSha256,assetSha256:image.sha256,artifactSha256:artifact.artifactSha256},
  observation=prepareNativeTableObservation(candidate,artifact,image,'declared-v1'),
  support={id:'i0',kind:'image' as const,documentId:source.documentId,documentVersionId:source.currentVersionId,sourceVersionId:source.sourceVersionId,
   sourceHash:source.sourceHash,evidenceId:image.anchorEvidenceId,sha256:image.sha256,image,tableObservations:[observation]},catalog=prepareSourceCellBindingCatalog([support]);
 const node={id:`pg:${source.currentVersionId}:1`,document_id:source.documentId,source_version_id:source.sourceVersionId,source_hash:source.sourceHash,
  course_id:'',name:'Synthetic binding fixture',origin:'fixture',origin_key:'fixture',body:'',locator:'page:1',page_number:1,evidence_id:image.anchorEvidenceId,
  parser_version:'synthetic-component',evidence_body:'full-page' as const,reader_selection:'evidence-node-ids' as const,retrieval_mode:'reader-selection' as const},
  context:DocumentAnswerContext={anchors:[{id:'pg:other-version:1',document_id:'other-doc',source_version_id:'other-source-version',
   source_hash:sha('other-source'),course_id:'',name:'Other original source',origin:'fixture',origin_key:'other',locator:'page:1',page_number:1,
   parser_version:'fixture',score:1,evidence_body:'full-page',evidence_id:'other-evidence',body:'An original independent explanation remains available.'}],
   parents:[],imageAnchors:[node],images:[{...image,tableObservations:[observation]}],sourceContentIsUntrusted:true};
 return {catalog,observation,support,context,native,image,candidate,at:(row:number,col:number)=>catalog.cells.find(c=>c.row===row&&c.column===col)!.id};
}
const result=(...claims:unknown[])=>({status:'answered',message:'',claims}),decode=(value:unknown,catalog:Awaited<ReturnType<typeof fixture>>['catalog'],ids=['i0','q:a','q:b'])=>deriveSourceCellBindingAnswer(value,JSON.stringify(value),catalog,ids);
const schemaValueIds=(schema:ReturnType<typeof sourceCellBindingAnswerSchema>)=>(schema.properties.claims as {
 items:{anyOf:Array<{properties:{valueRef:{enum:string[]}}}>}}).items.anyOf[0].properties.valueRef.enum;

test('v2 retains omitted available native declarations without promoting an incomplete grid or changing legacy retention',async()=>{
 const f=await fixture(),policy={scope:'application' as const,model:'gpt-5.4-mini' as const,evidenceSelection:'select-then-answer' as const,
  sourceValueContract:'cell-bindings-v2' as const,citationCheck:{mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}}},
  prepared=prepareDocumentAnswerForPolicy('Read the original table.',f.context,policy);
 assert.equal(f.observation.status,'unavailable');assert.equal(f.observation.cellDeclarations?.status,'available');
 assert.deepEqual(resolveSourceValueEvidenceSelection({referenceIds:[]},prepared).referenceIds,[]);
 const retained=resolveSourceValueEvidenceSelection({referenceIds:[]},prepared,true);
 assert.deepEqual(retained.referenceIds,['i0']);assert.deepEqual(retained.systemRetainedReferenceIds,['i0']);
 const generated=prepareSelectedSourceValueGeneration(prepared,retained.referenceIds,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000},policy);
 assert.equal(generated.applied,true);assert.equal(generated.catalog.tables[0].gridStatus,'unavailable');
 assert.ok(generated.catalog.tables[0].unknownPositions.length>0);assert.equal(generated.catalog.cells.length,f.catalog.cells.length);
 assert.equal(generated.request.text.format.name,'grounded_document_cell_bindings_v2');
 assert.doesNotMatch(JSON.stringify(generated.request),/cellDeclarationWitness/);
 const changed=structuredClone(prepared),o=changed.supports.find(s=>s.kind==='image')!.tableObservations![0];
 o.observationSha256='0'.repeat(64);assert.throws(()=>resolveSourceValueEvidenceSelection({referenceIds:[]},changed,true));
});
test('cell bindings quote complete labels/values, support both axes and preserve mixed-source statements',async()=>{
 const f=await fixture();assert.equal(f.observation.status,'unavailable');assert.equal(f.catalog.status,'available');
 const a=decode(result({kind:'table-value',valueRef:f.at(2,1)}),f.catalog),b=decode(result({kind:'table-value',valueRef:f.at(2,3)}),f.catalog);
 assert.match(a.normalizedSelections.claims[0].text,/Model A.*ppl.*8\.92/);assert.doesNotMatch(a.normalizedSelections.claims[0].text,/Model B/);
 assert.match(b.normalizedSelections.claims[0].text,/Model B.*ppl.*9\.53/);
 const horizontal=decode(result({kind:'table-difference',leftValueRef:f.at(2,3),rightValueRef:f.at(2,1)},
  {kind:'statement',text:'Unverified ordinary synthesis remains separate.',citations:[{id:'q:a'},{id:'q:b'}]}),f.catalog);
 assert.equal(horizontal.operations[0].difference,'0.61');assert.equal(horizontal.operations[0].semanticVerified,false);
 assert.equal(horizontal.normalizedSelections.claims[1].citations.length,2);assert.equal(horizontal.operations.length,1);
 const vertical=decode(result({kind:'table-difference',leftValueRef:f.at(3,1),rightValueRef:f.at(2,1)}),f.catalog);
 assert.equal(vertical.operations[0].difference,'0.76');assert.equal(vertical.operations[0].bindings[0].table.gridStatus,'unavailable');
 assert.equal(horizontal.operations[0].bindings[0].columnLabels.length,2);
 const schema=sourceCellBindingAnswerSchema(f.catalog,['i0']);assert.equal(JSON.stringify(schema).includes('"enum":[]'),false);
});
test('value schema and parser-derived paths use the same binding validator while preserving original observations',async()=>{
 const f=await fixture(),original=canonical(f.native),schema=sourceCellBindingAnswerSchema(f.catalog,['i0','q:a']),
  valueIds=schemaValueIds(schema),
  cells=f.catalog.wire.tables[0].cells;
 assert.equal(f.catalog.wire.valuePathAuthority,'parser-derived-unverified');
 assert.equal(valueIds.length,8);assert.equal(cells.length,16);
 assert.equal(Buffer.byteLength(canonical(f.catalog.wire))<=32768,true);
 for(const cell of cells){
  if(cell.valuePath.status!=='parser-derived'){
   assert.equal(valueIds.includes(cell.id),false);continue;
  }
  assert.equal(valueIds.includes(cell.id),true);
  const bound=decode(result({kind:'table-value',valueRef:cell.id}),f.catalog).operations[0].bindings[0];
  assert.deepEqual(cell.valuePath.rowLabels,bound.rowLabels.map(c=>c.text));
  assert.deepEqual(cell.valuePath.columnLabels,bound.columnLabels.map(c=>c.text));
  assert.equal(bound.table.gridStatus,'unavailable');assert.equal(bound.table.semanticVerified,false);
 }
 assert.equal(canonical(f.native),original);
 assert.throws(()=>sourceCellBindingAnswerSchema(f.catalog,['q:a']),(e:any)=>e.code==='source-cell-no-selected-values');
 const broken=await fixture(true),brokenSchema=sourceCellBindingAnswerSchema(broken.catalog,['i0']),
  unknown=broken.catalog.wire.tables[0].cells.find(c=>c.id===broken.at(2,1))!;
 assert.equal(unknown.valuePath.status,'unknown');
 assert.equal(schemaValueIds(brokenSchema).includes(unknown.id),false);
 const changed=structuredClone(f.catalog),value=changed.wire.tables[0].cells.find(c=>c.valuePath.status==='parser-derived')!;
 if(value.valuePath.status!=='parser-derived')throw Error('Expected derived fixture path');
 value.valuePath.columnLabels[0]='Foreign model';
 assert.throws(()=>decode(result({kind:'table-value',valueRef:f.at(2,1)}),changed),(e:any)=>e.code==='source-cell-catalog-changed');
});

test('no bindable values keeps original generation and evidence instead of sending empty enums',async()=>{
 const f=await fixture(false,false,true);
 assert.equal(f.catalog.status,'unavailable');assert.equal(f.catalog.reason,'no-bindable-cell-values');
 const policy={scope:'application' as const,model:'gpt-5.4-mini' as const,maxOutputTokens:3000,evidenceSelection:'select-then-answer' as const,
  sourceValueContract:'cell-bindings-v2' as const,citationCheck:{mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}}},
  prepared=prepareDocumentAnswerForPolicy('Read the original table.',f.context,policy),
  generated=prepareSelectedSourceValueGeneration(prepared,['i0'],{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000},policy);
 assert.equal(generated.applied,false);assert.equal(generated.reason,'no-bindable-cell-values');
 assert.equal(generated.request.text.format.name,'grounded_document_answer_units');
 assert.equal(JSON.stringify(generated.request).includes('"enum":[]'),false);
 assert.equal(JSON.stringify(generated.request).includes('native-cell-declarations-v1'),true);
});

test('cell bindings reject renamed values, unknown headers, foreign cells, changed catalogs and incompatible metrics',async()=>{
 const f=await fixture();
 for(const value of [result({kind:'table-value',valueRef:f.at(2,1),label:'Model B'}),result({kind:'table-value',valueRef:'b99/1'}),
  result({kind:'table-difference',leftValueRef:f.at(2,3),rightValueRef:f.at(2,2)}),
  result({kind:'statement',text:'An image table value cannot use the ordinary image path.',citations:[{id:'i0'}]}),
  result({text:'Old wrong free assertion.',citations:[{id:'i0'}]})])assert.throws(()=>decode(value,f.catalog));
 assert.throws(()=>decode(result({kind:'table-value',valueRef:f.at(2,1)}),f.catalog,['q:a']));
 const broken=await fixture(true);assert.throws(()=>decode(result({kind:'table-value',valueRef:broken.at(2,1)}),broken.catalog),
  (e:any)=>e.stage==='structure-storage'&&e.code==='source-cell-header-path-unknown');
 const unknown=await fixture(false,true);assert.throws(()=>decode(result({kind:'table-value',valueRef:unknown.at(2,1)}),unknown.catalog),
  (e:any)=>e.stage==='structure-storage');
 const native=structuredClone(f.native);native.reference='#/tables/1';const artifact=prepareNativeTableArtifact(native),
  candidate={...f.candidate,artifactSha256:artifact.artifactSha256};
 candidate.id=sha(canonical({namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,source:candidate.source,
  artifactSha256:artifact.artifactSha256,manifestSha256:candidate.manifestSha256,assetSha256:candidate.assetSha256,anchor:candidate.anchorEvidenceId}));
 const both=prepareSourceCellBindingCatalog([{...f.support,tableObservations:[f.observation,prepareNativeTableObservation(candidate,artifact,f.image,'declared-v1')]}]);
 assert.throws(()=>decode(result({kind:'table-difference',leftValueRef:'b0/7',rightValueRef:'b1/7'}),both),
  (e:any)=>e.code==='source-cell-comparison-axis-or-metric-mismatch');
 const changed=structuredClone(f.catalog);changed.cells[0].text='renamed';assert.throws(()=>decode(result({kind:'table-value',valueRef:f.at(2,1)}),changed));
 // Ordinary text assertions are still generative; never count them as bound values.
 assert.equal(decode(result({kind:'statement',text:'Unverified synthesis.',citations:[{id:'q:a'}]}),f.catalog).operations.length,0);
});

test('cell binding generator uses the shared selector/raw persistence/decoder without adding model stages',async()=>{
 const {studySourceValues,answerKernelStudy}=await import('../lib/study-answer.ts');
 assert.equal(studySourceValues('cell-bindings-v2'),'cell-bindings-v2');
 const f=await fixture(),saved=globalThis.fetch,env=process.env.AI_BUDGET_TEST_BYPASS;
 process.env.AI_BUDGET_TEST_BYPASS='true';process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='fixture-never-forwarded';
 let calls=0,rawRecorded=false,derivationRecorded=false;
 const policy={scope:'application' as const,model:'gpt-5.4-mini' as const,maxOutputTokens:3000,evidenceSelection:'select-then-answer' as const,
  sourceValueContract:'cell-bindings-v2' as const,citationCheck:{mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}},
  recordSourceValueRawResponse:async()=>{rawRecorded=true;},recordSourceValueDerivation:async()=>{assert.equal(rawRecorded,true);derivationRecorded=true;}},
  prepared=prepareDocumentAnswerForPolicy('Read Model B value and explain its original context.',f.context,policy),
  ids=[...prepared.quoteUnits.filter(q=>q.selectable).map(q=>q.id),'i0'],generation=prepareSelectedSourceValueGeneration(prepared,ids,
   {model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000},policy);
 assert.equal(generation.kind,'cell-bindings-v2');assert.equal(generation.applied,true);
 assert.equal(generation.request.text.format.name,'grounded_document_cell_bindings_v2');
 assert.equal(JSON.stringify(generation.request).includes('"sources":'),false,'private catalog sources/witnesses must not enter model input');
 assert.equal(documentSourceGenerationRoute('What is the human mean AUC?',{...policy,sourceQuantityContract:'bound-value-v1'}),'source-quantities');
 assert.equal(documentSourceGenerationRoute('Read the table value.',{...policy,sourceQuantityContract:'bound-value-v1'}),'source-values');
 try{
  globalThis.fetch=async(_url,init)=>{
   const wire=JSON.parse(String(init?.body));calls++;
   if(calls===1){assert.equal(wire.text.format.name,'document_evidence_selection');return Response.json({status:'completed',model:'gpt-5.4-mini',output_text:JSON.stringify({referenceIds:ids})});}
   assert.equal(calls,2);assert.equal(wire.text.format.name,'grounded_document_cell_bindings_v2');
   return Response.json({status:'completed',model:'gpt-5.4-mini',output_text:JSON.stringify(result({kind:'table-value',valueRef:f.at(2,3)},
    {kind:'statement',text:'An original independent explanation remains available.',citations:[{id:ids[0]}]}))});
  };
  const answer=await synthesizeDocumentAnswer('Read Model B value and explain its original context.',async()=>f.context,policy);
  assert.equal(calls,2);assert.equal(derivationRecorded,true);assert.equal(answer.sourceValueContract?.policy,'cell-bindings-v2');
  if(!('sourceValueDerivation' in answer)||!answer.sourceValueDerivation)throw Error('Expected a new source-cell derivation');
  assert.equal(answer.sourceValueDerivation.method,'source-cell-bindings-v2');assert.match(answer.answer.claims[0].text,/Model B.*ppl.*9\.53/);
  assert.equal(answer.selectedUnits[0].selectionId,'i0');assert.equal(answer.answer.claims.length,2);
 }finally{globalThis.fetch=saved;if(env===undefined)delete process.env.AI_BUDGET_TEST_BYPASS;else process.env.AI_BUDGET_TEST_BYPASS=env;}
 const oldContract=process.env.STUDY_SOURCE_VALUES,oldDeclarations=process.env.KERNEL_NATIVE_CELL_OBSERVATIONS;
 try{
  process.env.STUDY_SOURCE_VALUES='cell-bindings-v2';process.env.KERNEL_NATIVE_CELL_OBSERVATIONS='off';
  await assert.rejects(answerKernelStudy('fixture-owner','Read the value.','',[]),(e:any)=>e.stage==='configuration'&&e.code==='cell-bindings-require-native-declarations');
 }finally{
  if(oldContract===undefined)delete process.env.STUDY_SOURCE_VALUES;else process.env.STUDY_SOURCE_VALUES=oldContract;
  if(oldDeclarations===undefined)delete process.env.KERNEL_NATIVE_CELL_OBSERVATIONS;else process.env.KERNEL_NATIVE_CELL_OBSERVATIONS=oldDeclarations;
 }
});
