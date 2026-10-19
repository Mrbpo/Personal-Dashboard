import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {prepareSourceValueCatalog,type SourceValueImage} from '../lib/kernel/document-source-values.ts';
import {prepareSourceQuantityCatalog,deriveSourceQuantityAnswer,sourceQuantityQuestionFamily,SourceQuantityOperationError} from '../lib/kernel/document-source-quantities.ts';
import {prepareDocumentAnswerForPolicy,prepareSelectedSourceQuantityGeneration,buildSelectedDocumentAnswerRequest,
 synthesizeDocumentAnswer,documentAnswerSettings,type DocumentAnswerContext,type DocumentSourceQuantityDerivation,type DocumentSourceQuantityRawResponse} from '../lib/kernel/document-answer.ts';
process.env.DATABASE_URL=':memory:';process.env.AI_BUDGET_TEST_BYPASS='true';process.env.OPENAI_API_KEY='fixture-never-sent';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const unit=(text:string)=>({id:'q:synthetic',supportId:'e0',text,quoteSha256:sha(text)});
const check={mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}};
const settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000};
const raw:DocumentSourceQuantityRawResponse[]=[],derivations:DocumentSourceQuantityDerivation[]=[];
const policy={scope:'application' as const,...settings,evidenceSelection:'select-then-answer' as const,citationCheck:check,sourceQuantityContract:'bound-value-v1' as const,
 recordSourceQuantityRawResponse:async(r:Readonly<DocumentSourceQuantityRawResponse>)=>{raw.push(r);},
 recordSourceQuantityDerivation:async(r:Readonly<DocumentSourceQuantityDerivation>)=>{derivations.push(r);}};
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,images:[],parents:[],anchors:[{id:'pg:source-v:1',document_id:'source',
 source_version_id:'source-sv',source_hash:sha('source-pdf'),evidence_id:'page-1',course_id:'',name:'Synthetic training note',origin:'fixture',origin_key:'one',
 page_number:1,locator:'p1',body:'Each model is trained for 100 epochs for each dataset.',parser_version:'fixture',score:1,evidence_body:'full-page'}]};}

test('source quantities bind literal spans and reject metric renaming, changed source values or unselected references',()=>{
 const u=unit('Each model is trained for 100 epochs for each dataset.'),catalog=prepareSourceQuantityCatalog(undefined,[u]),o=catalog.observations[0],
  value={status:'answered',message:'',values:[{valueId:o.id}]},before=JSON.stringify(catalog);
 const positive=deriveSourceQuantityAnswer('How many epochs is each model trained for?',value,JSON.stringify(value),catalog,undefined,[u],[u.id]);
 assert.equal(positive.normalizedSelections.claims[0].text,u.text);assert.equal(positive.operations[0].kind,'text');
 const negative=deriveSourceQuantityAnswer('How quickly is the model trained?',value,JSON.stringify(value),catalog,undefined,[u],[u.id]);
 assert.equal(negative.outcome,'source-metric-not-established');assert.equal(negative.normalizedSelections.status,'insufficient-evidence');
 for(const invalid of [{...value,values:[{valueId:o.id,metricLabel:'hours'}]},{...value,values:[{valueId:'fabricated'}]}])
  assert.throws(()=>deriveSourceQuantityAnswer('How many epochs?',invalid,JSON.stringify(invalid),catalog,undefined,[u],[u.id]),SourceQuantityOperationError);
 assert.throws(()=>deriveSourceQuantityAnswer('How many epochs?',value,JSON.stringify(value),catalog,undefined,[u],[]),SourceQuantityOperationError);
 const changed=structuredClone(catalog);changed.observations[0].value='101';
 assert.throws(()=>deriveSourceQuantityAnswer('How many epochs?',value,JSON.stringify(value),changed,undefined,[u],[u.id]),SourceQuantityOperationError);
 assert.equal(JSON.stringify(catalog),before);assert.equal(negative.semanticVerified,false);assert.equal(negative.scopeVerified,false);
});

test('authentic agreement wording preserves qualifiers and percentages do not borrow a metric from another sentence',()=>{
 const u=unit('Perfect agreement (0 or 3 doubts) occur in 48 percent of cases. AUC was measured separately.'),
  catalog=prepareSourceQuantityCatalog(undefined,[u]),o=catalog.observations.find(o=>o.value==='48')!;
 assert.equal(o.family,'agreement');assert.equal(o.kind,'text');
 if(o.kind==='text'){assert.equal(u.text.slice(o.numberStartUtf16,o.numberEndUtf16),'48');assert.equal(u.text.slice(o.metricStartUtf16,o.metricEndUtf16),'agreement');}
 const value={status:'answered',message:'',values:[{valueId:o.id}]},r=deriveSourceQuantityAnswer('What percentage of inter-annotator agreement is reported?',value,JSON.stringify(value),catalog,undefined,[u],[u.id]);
 assert.equal(r.normalizedSelections.claims[0].text,'Perfect agreement (0 or 3 doubts) occur in 48 percent of cases.');
 assert.equal(prepareSourceQuantityCatalog(undefined,[unit('AUC was measured. The score was 48 percent.')]).observations.length,0);
});

test('an original table with an unrecognized metric remains unknown rather than borrowing the requested AUC label',async()=>{
 const meta=JSON.parse(await readFile(new URL('./fixtures/source-values-author23/selected-image.json',import.meta.url),'utf8')),
  image={sha256:meta.sha256,width:meta.width,height:meta.height,attachmentId:meta.attachmentId,captionEvidenceId:meta.evidenceId,
   source:meta.tableObservations[0].candidate.source},table=prepareSourceValueCatalog([{...meta,image} as SourceValueImage]),
  catalog=prepareSourceQuantityCatalog(table,[]),o=catalog.observations.find(o=>o.kind==='table'&&o.value==='66.31')!;
 assert.equal(o.family,null);const value={status:'answered',message:'',values:[{valueId:o.id}]},r=deriveSourceQuantityAnswer(
  'What mean AUC is reported?',value,JSON.stringify(value),catalog,table,[],[meta.id]);
 assert.equal(r.outcome,'source-metric-not-established');assert.equal(r.normalizedSelections.status,'insufficient-evidence');
 assert.equal(r.semanticVerified,false);assert.equal(o.kind,'table');if(o.kind==='table')assert.ok(o.columnLabels.includes('Accuracy/%'));
});

test('off/ordinary routes retain the original generator wire and policies stay explicit',async()=>{
 for(const q of ['Explain the training setup.','What was the inter-annotator agreement between the expert annotators?','Compare AUC and rater agreement.']){
  assert.equal(sourceQuantityQuestionFamily(q),null);const p=prepareDocumentAnswerForPolicy(q,context(),policy),ids=[p.quoteUnits[0].id],
   proposed=prepareSelectedSourceQuantityGeneration(p,ids,settings,policy);
  assert.equal(proposed.applied,false);assert.deepEqual(proposed.request,buildSelectedDocumentAnswerRequest(p,ids,settings,policy));
 }
 await assert.rejects(documentAnswerSettings({...policy,sourceValueContract:'difference-v1'}),/Source quantities require/);
 await assert.rejects(documentAnswerSettings({...policy,recordSourceQuantityRawResponse:undefined}),/Source quantities require/);
});

test('the application generator records the actual raw and compiles a mismatched source unit to neutral refusal without a third model call',async()=>{
 raw.length=0;derivations.length=0;const c=context(),question='How quickly is this model trained?',p=prepareDocumentAnswerForPolicy(question,c,policy),saved=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));let output;
  if(calls===1)output={referenceIds:[p.quoteUnits[0].id]};
  else{assert.equal(request.text.format.name,'grounded_document_source_quantities_v1');const packet=JSON.parse(request.input.at(-1).content[0].text),o=packet.sourceQuantityCatalog.observations.find((o:any)=>o.family==='iteration-count');
   output={status:'answered',message:'',values:[{valueId:o.id}]};}
  return Response.json({status:'completed',model:'gpt-5.4-mini',output_text:JSON.stringify(output)});};
 try{const result=await synthesizeDocumentAnswer(question,async()=>c,policy);
  assert.equal(calls,2);assert.equal(result.answer.status,'insufficient-evidence');assert.deepEqual(result.selectedUnits,[]);
  assert.equal(raw.length,1);assert.equal(derivations.length,1);assert.equal(derivations[0].outcome,'source-metric-not-established');
  assert.deepEqual(JSON.parse(JSON.parse(raw[0].rawBody).output_text),derivations[0].rawProviderResult);
  assert.equal(derivations[0].sourceInputFingerprint,result.inputFingerprint);
  assert.equal(derivations[0].sourceBindings[0].source.sourceHash,c.anchors[0].source_hash);
  assert.equal(derivations[0].sourceBindings[0].source.documentVersionId,'source-v');
  assert.equal(derivations[0].sourceBindings[0].source.evidenceId,'page-1');
  assert.equal(derivations[0].sourceBindings[0].quoteUnit?.quoteSha256,p.quoteUnits[0].quoteSha256);
  assert.equal(derivations[0].textUnitManifestSha256.length,64);
 }finally{globalThis.fetch=saved;}
});
