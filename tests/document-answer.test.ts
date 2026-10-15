import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareDocumentAnswer,validateGroundedDocumentAnswer,resolveGroundedDocumentAnswerReferences,documentQuoteUnits,
 resolveDocumentAnswerSelections,buildDocumentAnswerRequest,synthesizeDocumentAnswer,DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {kernel} from '../lib/kernel/service.ts';
import {migrateKernel,kernelPool} from '../lib/kernel/db.ts';
import {COMPLETE_DOCUMENT_SOURCE_LIMITS,type CompleteDocumentSourceRead} from '../lib/kernel/document-context.ts';
import {after} from 'node:test';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'document-answer-empty-vault-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-local-test-never-sent';process.env.AI_BUDGET_TEST_BYPASS='false';
process.env.AI_MONTHLY_BUDGET='5';
after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const source={documentId:'doc',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:'source-hash'};
const body='The experiment uses two samples.\nThe result remains preliminary.';
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,images:[],parents:[],anchors:[{
 id:'pg:version:1',document_id:'doc',course_id:'course',name:'Original source',origin:'source',origin_key:'source-key',
 source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:'section:0:paragraph:0',page_number:1,
 evidence_id:'evidence',parser_version:'native-unverified',score:1,evidence_body:'full-page',parser_warnings:['Formula fidelity unverified.']} ]};}
const answer={status:'answered',message:'',claims:[{text:'The study uses two samples.',citations:[{id:'e0',quote:'uses two samples.'}]}]};

test('blank original nodes retain evidence order and checksums but cannot support a claim',()=>{
 const c=context(),bodies=[' \t\n','',body];
 c.anchors=bodies.map((text,index)=>({...c.anchors[0],id:`pg:version:${index+1}`,page_number:index+1,
  evidence_id:`original-${index}`,locator:`original:${index}`,body:text}));
 c.parents=[{parentId:'original-section',status:'available',sourceNodeCount:3,
  sourceBodyCodepoints:bodies.reduce((sum,text)=>sum+Array.from(text).length,0),nodes:c.anchors.map(hit=>({
   documentId:hit.document_id,documentVersionId:'version',sourceVersionId:hit.source_version_id,sourceHash:hit.source_hash,
   evidenceId:hit.evidence_id,locator:hit.locator,body:hit.body,bodySha256:hash(hit.body)}))}];
 const prepared=prepareDocumentAnswer('How many samples?',c);
 assert.deepEqual(prepared.supports.map(s=>[s.id,s.text,s.sha256]),bodies.map((text,index)=>[`e${index}`,text,hash(text)]));
 assert.deepEqual(prepared.input.evidence.map(e=>e.evidenceId),['original-0','original-1','original-2']);
 const blank=prepared.quoteUnits.find(unit=>unit.supportId==='e0')!,valid=prepared.quoteUnits.find(unit=>unit.supportId==='e2')!;
 assert.equal(blank.text,bodies[0]);assert.equal(blank.selectable,false);assert.equal(valid.selectable,true);
 assert.equal(prepared.quoteUnitManifest.find(unit=>unit.id===blank.id)!.evidence.evidenceId,'original-0');
 assert.equal(prepared.input.evidence[1].sha256,hash(''),'empty body retains its original evidence identity');
 const request=buildDocumentAnswerRequest(prepared,{model:'gpt-5-mini',reasoningEffort:'low',maxOutputTokens:4000});
 assert.deepEqual(request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,[valid.id]);
 const selection=(id:string)=>({...answer,claims:[{text:'Two samples.',citations:[{id}]}]});
 const resolved=resolveDocumentAnswerSelections(selection(valid.id),prepared.supports);
 assert.equal(resolved.answer.claims[0].citations[0].id,'e2');assert.equal(resolved.selectedUnits[0].evidence.evidenceId,'original-2');
 for(const id of [blank.id,'e0','e1'])assert.throws(()=>resolveDocumentAnswerSelections(selection(id),prepared.supports));
 assert.throws(()=>validateGroundedDocumentAnswer({...answer,claims:[{text:'Unsupported.',citations:[{id:'e0',quote:' \t\n'}]}]},prepared.supports));
 c.parents[0].nodes[0].bodySha256=hash('different');assert.throws(()=>prepareDocumentAnswer('What?',c),/checksum/);
});

test('empty and whitespace-only sources return neutral insufficient evidence without reserving or fetching',async()=>{
 const original=globalThis.fetch;let calls=0,attempts=0;
 globalThis.fetch=async()=>{calls++;throw new Error('Blank-only evidence must not call a provider');};
 try{for(const text of ['', ' \t\n']){
  const c=context();c.anchors[0].body=text;
  const result=await synthesizeDocumentAnswer('What is supported?',async()=>c,{beforeAttempt:async()=>{attempts++;}});
  assert.deepEqual(result.answer,{status:'insufficient-evidence',message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE,claims:[]});
  assert.equal(result.textEvidenceCount,1);assert.equal(result.evidence[0].sha256,hash(text));
  assert.equal(result.model,null);assert.equal(result.providerRequestSha256,null);assert.equal(result.providerSelections,null);
  if(text)assert.equal(result.quoteUnitManifest[0].selectable,false);
 }}finally{globalThis.fetch=original;}
 assert.equal(calls,0);assert.equal(attempts,0);
});

test('complete-source blank-only route preserves its source manifest and neutral result before request construction',async()=>{
 const c=context();c.anchors[0].body=' \t\n';let reads=0,attempts=0;
 const complete:CompleteDocumentSourceRead={status:'available',context:{...c,parents:[],images:[],accounting:{anchorCount:1,parentCount:0,contextNodeCount:0,contextBodyCodepoints:0,imageCount:0,imageBytes:0}},
  manifest:{method:'complete-current-source',nodeOrder:'original-source',complete:true,reason:null,source,sourceNodeCount:1,returnedNodeCount:1,
   sourceBodyCodepoints:3,sourceBodyUtf8Bytes:3,orderedTextSha256:hash(c.anchors[0].body),structureManifestSha256:hash('structure'),
   parserWarnings:[],document:{name:'Original source',origin:'source',originKey:'source-key',parserVersion:'native-unverified'},hierarchy:[],
   nodes:[{...source,documentVersionId:source.currentVersionId,evidenceId:'evidence',locator:c.anchors[0].locator,ordinal:0,kind:'paragraph',bodySha256:hash(c.anchors[0].body)}],
   images:[],imageInputTokenUpper:0,limits:COMPLETE_DOCUMENT_SOURCE_LIMITS,manifestSha256:hash('blank-complete-manifest')}};
 const original=kernel.readCompleteDocumentSource,fetch=globalThis.fetch;
 kernel.readCompleteDocumentSource=async()=>{reads++;return complete;};
 globalThis.fetch=async()=>{throw new Error('Blank-only complete source must not call a provider');};
 try{
  const result=await kernel.answerSelectedStudySource('owner','What is supported?',source,{beforeAttempt:async()=>{attempts++;}});
  assert.equal(result.status,'available');if(result.status!=='available')throw new Error('Expected complete source');
  assert.deepEqual(result.manifest,complete.manifest);assert.equal(result.result.answer.status,'insufficient-evidence');
  assert.equal(result.result.answer.message,DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE);assert.equal(result.result.evidence.length,1);
  assert.equal(reads,2,'synthesis still rechecks the complete current source');assert.equal(attempts,0);
 }finally{kernel.readCompleteDocumentSource=original;globalThis.fetch=fetch;}
});

test('source quote units losslessly reconstruct Unicode evidence and strictly resolve only supplied selections',()=>{
 const c=context(),original='a'.repeat(1199)+'😀\r\n\r\n'+('𠮷 clause. '.repeat(180))+' '.repeat(2500)+' end.';
 c.anchors[0].body=original;
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64'),imageHash=hash(bytes);
 c.images=[{attachmentId:'unit-image',assetId:imageHash,captionEvidenceId:'caption',sha256:imageHash,byteLength:bytes.length,
  width:1,height:1,mime:'image/png',bytes,source}];
 const prepared=prepareDocumentAnswer('What is supplied?',c),units=prepared.quoteUnits,selectable=units.filter(unit=>unit.selectable);
 assert.equal(units.map(unit=>unit.text).join(''),original);assert.ok(units.some(unit=>!unit.selectable),'blank runs are retained');
 let offset=0;
 for(const unit of units){
  assert.equal(unit.startUtf16,offset);assert.ok(unit.endUtf16>offset);assert.ok(unit.text.length<=1200);
  assert.equal(unit.text,original.slice(unit.startUtf16,unit.endUtf16));assert.equal(unit.quoteSha256,hash(unit.text));
  const left=original.charCodeAt(unit.endUtf16-1),right=original.charCodeAt(unit.endUtf16);
  assert.ok(!(left>=0xd800&&left<=0xdbff&&right>=0xdc00&&right<=0xdfff),'never split a surrogate pair');offset=unit.endUtf16;
 }
 assert.equal(offset,original.length);assert.deepEqual(prepareDocumentAnswer('What is supplied?',c).quoteUnits,units);
 assert.deepEqual(documentQuoteUnits(prepared.supports.map(s=>s.kind==='text'?{...s,id:'e99'}:s)).map(u=>u.id),units.map(u=>u.id));
 assert.deepEqual(documentQuoteUnits(prepared.supports.map(s=>Object.fromEntries(Object.entries(s).reverse()) as typeof s)).map(u=>u.id),units.map(u=>u.id));
 assert.throws(()=>documentQuoteUnits([...prepared.supports,prepared.supports[0]]),/Duplicate or colliding/);
 assert.ok(prepared.input.evidence.every(item=>!Object.hasOwn(item,'text')),'no duplicate full text in model input');
 assert.equal(prepared.input.quoteUnits.map(unit=>unit.text).join(''),original);
 assert.equal(prepared.quoteUnitManifestSha256,hash(JSON.stringify(prepared.quoteUnitManifest)));
 const request=buildDocumentAnswerRequest(prepared,{model:'gpt-5-mini',reasoningEffort:'low',maxOutputTokens:4000});
 assert.deepEqual(request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,
  [...selectable.map(unit=>unit.id),'i0']);
 const user=request.input.find(item=>item.role==='user')!;assert.ok(Array.isArray(user.content));
 assert.equal(user.content.filter(item=>item.type==='input_image').length,1);
 assert.equal(JSON.parse(user.content[0].text!).quoteUnits.map((unit:{text:string})=>unit.text).join(''),original);
 assert.throws(()=>buildDocumentAnswerRequest(prepared,{model:'gpt-5-mini',reasoningEffort:'low',maxOutputTokens:0}));
 const manyNodes=(count:number)=>{const many=context();many.anchors=Array.from({length:count},(_,n)=>({...many.anchors[0],
  id:`pg:version:${n+1}`,page_number:n+1,evidence_id:`schema-evidence-${n}`,locator:`node:${n}`,body:`Original node ${n}.`}));
  return prepareDocumentAnswer('What is supplied?',many);};
 const settings={model:'gpt-5-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:4000};
 const many=buildDocumentAnswerRequest(manyNodes(256),settings),enumIds=many.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum;
 assert.equal(enumIds.length,256);assert.ok(enumIds.every(id=>id.length===26));assert.ok(enumIds.join('').length<=15000);
 assert.throws(()=>buildDocumentAnswerRequest(manyNodes(578),settings),/enum string limit/);
 assert.throws(()=>buildDocumentAnswerRequest(manyNodes(998),settings),/enum count limit/);
 const selected={status:'answered',message:'',claims:[{text:'A source-backed statement.',citations:[{id:selectable[0].id},{id:'i0'}]}]},raw=JSON.stringify(selected);
 const result=resolveDocumentAnswerSelections(selected,prepared.supports);
 assert.deepEqual(result.answer.claims[0].citations,[{id:'e0',quote:selectable[0].text},{id:'i0',quote:''}]);
 assert.deepEqual(result.providerSelections,selected);assert.equal(JSON.stringify(selected),raw);
 assert.deepEqual(validateGroundedDocumentAnswer(result.answer,prepared.supports),result.answer);
 assert.equal(result.selectedUnits[0].evidence.evidenceId,'evidence');assert.equal(result.selectedUnits[0].startUtf16,selectable[0].startUtf16);
 assert.equal(result.selectedUnits[0].endUtf16,selectable[0].endUtf16);assert.equal(result.selectedUnits[0].quoteSha256,hash(selectable[0].text));
 assert.equal(result.selectedUnits[1].kind,'image');assert.equal(result.selectedUnits[1].startUtf16,null);
 const citations=(...ids:string[])=>({...selected,claims:[{...selected.claims[0],citations:ids.map(id=>({id}))}]});
 for(const invalid of [citations('outside'),citations('e0'),citations(units.find(unit=>!unit.selectable)!.id),
  citations(selectable[0].id,selectable[0].id),citations('i0','i0'),citations(),
  {...selected,extra:true},{...selected,claims:[{...selected.claims[0],citations:[{id:selectable[0].id,quote:'authored text'}]}]},
  {...selected,status:'conflicting-evidence',claims:[{text:'First.',citations:[{id:selectable[0].id}]},
   {text:'Second.',citations:[{id:selectable[1].id}]}]}])
  assert.throws(()=>resolveDocumentAnswerSelections(invalid,prepared.supports));
 c.anchors[0].body+=' Changed.';const changed=prepareDocumentAnswer('What is supplied?',c);
 assert.notEqual(changed.fingerprint,prepared.fingerprint);assert.notEqual(changed.quoteUnitManifestSha256,prepared.quoteUnitManifestSha256);
 assert.throws(()=>resolveDocumentAnswerSelections(selected,changed.supports),'old selections cannot bind to changed original text');
 c.images[0].bytes=Buffer.from('a caption is not pixels');assert.throws(()=>prepareDocumentAnswer('What?',c),/checksum/);
});

test('document answer reservation includes a large citation schema before any provider request',async()=>{
 const {paidOpenAI}=await import('../lib/ai-budget.ts');
 const savedBudget=process.env.AI_MONTHLY_BUDGET,savedRates=process.env.AI_MODEL_RATES,originalFetch=globalThis.fetch;
 let calls=0;
 try{
  process.env.AI_MONTHLY_BUDGET='0.002';
  process.env.AI_MODEL_RATES=JSON.stringify({'gpt-5-mini':{input:1,output:0,context:400000}});
  const request={model:'gpt-5-mini',input:[{role:'user',content:'x'}],max_output_tokens:10,
   text:{format:{type:'json_schema',schema:{type:'string',enum:Array.from({length:300},(_,n)=>'q:'+hash(String(n)))}}}};
  globalThis.fetch=async()=>{calls++;return Response.json({usage:{input_tokens:0,output_tokens:0}});};
  await assert.rejects(paidOpenAI('responses',request,undefined,{kind:'document-answer',dailyLimit:200}),
   error=>error instanceof Error&&error.name==='AiBudgetDeferredError');
  assert.equal(calls,0,'schema-heavy answer is blocked before fetch, despite tiny input');
  await paidOpenAI('responses',request,undefined,{kind:'other-kind-control',dailyLimit:200});
  assert.equal(calls,1,'other kinds retain their existing input accounting; fetch is only a local stub');
 }finally{
  globalThis.fetch=originalFetch;
  if(savedBudget===undefined)delete process.env.AI_MONTHLY_BUDGET;else process.env.AI_MONTHLY_BUDGET=savedBudget;
  if(savedRates===undefined)delete process.env.AI_MODEL_RATES;else process.env.AI_MODEL_RATES=savedRates;
 }
});

test('unique existing text reference repair preserves raw data and strict final rejection boundaries',()=>{
 const c=context();c.anchors.push({...c.anchors[0],id:'pg:version:2',page_number:2,evidence_id:'second-evidence',
  locator:'section:1:paragraph:0',body:'A uniquely supported result.'});
 const prepared=prepareDocumentAnswer('What result is supplied?',c),supports=[...prepared.supports,
  {...prepared.supports[0],id:'i0',kind:'image' as const,text:undefined}];
 const quote='uniquely  supported\nresult.',raw={status:'answered',message:'',claims:[{
  text:'The source reports this result.',citations:[{id:'e0',quote}]}]},before=JSON.stringify(raw);
 assert.throws(()=>validateGroundedDocumentAnswer(raw,supports));
 const result=resolveGroundedDocumentAnswerReferences(raw,supports);
 assert.deepEqual(result.answer,{...raw,claims:[{...raw.claims[0],citations:[{id:'e1',quote}]}]});
 assert.equal(JSON.stringify(raw),before,'never mutate the original provider object');
 assert.equal(result.citationRepairs.length,1);const repair=result.citationRepairs[0];
 assert.deepEqual([repair.claimIndex,repair.citationIndex,repair.originalSupportId,repair.resolvedSupportId],[0,0,'e0','e1']);
 assert.equal(repair.originalEvidence.evidenceId,'evidence');assert.equal(repair.resolvedEvidence.evidenceId,'second-evidence');
 assert.equal(repair.resolvedEvidence.sourceVersionId,source.sourceVersionId);assert.equal(repair.reason,'unique-exact-text-match');
 assert.equal(repair.quoteSha256,hash('uniquely supported result.'));
 assert.deepEqual(validateGroundedDocumentAnswer(result.answer,supports),result.answer);
 const changed=(id:string,quote:string)=>({...raw,claims:[{...raw.claims[0],citations:[{id,quote}]}]});
 for(const invalid of [changed('outside',quote),changed('i0',quote),changed('e0',''),
  changed('e0','a uniquely supported result.'),changed('e0','"uniquely supported result."'),
  {...raw,extra:true},{...raw,claims:[{...raw.claims[0],citations:[{id:'e0',quote,extra:true}]}]},
  {...raw,claims:[{...raw.claims[0],citations:[{id:'e0',quote},{id:'e1',quote}]}]},
  {...raw,status:'conflicting-evidence',claims:[raw.claims[0],{text:'Another claim.',citations:[{id:'e1',quote}]}]}])
  assert.throws(()=>resolveGroundedDocumentAnswerReferences(invalid,supports));
 assert.throws(()=>resolveGroundedDocumentAnswerReferences(raw,[...supports,{...prepared.supports[1],id:'e2'}]),
  'multiple exact text matches are ambiguous');
 assert.deepEqual(resolveGroundedDocumentAnswerReferences(answer,supports).citationRepairs,[]);
 assert.equal(JSON.stringify(raw),before);
});

test('insufficient evidence returns only a neutral status while preserving strict output shapes',()=>{
 const prepared=prepareDocumentAnswer('What is the outcome?',context());
 const raw={status:'insufficient-evidence',message:'The paper never mentions any samples or outcomes.',claims:[]};
 const validated=validateGroundedDocumentAnswer(raw,prepared.supports);
 assert.equal(validated.message,'I cannot provide a sufficiently supported answer.');
 assert.equal(validated.status,'insufficient-evidence');assert.deepEqual(validated.claims,[]);
 assert.equal(raw.message,'The paper never mentions any samples or outcomes.','raw provider data remains unchanged');
 for(const changed of [{...raw,message:''},{...raw,message:'  '},{...raw,message:null},
  {...raw,message:'x'.repeat(3001)},{...raw,claims:answer.claims},
  {...answer,message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE},
  {...answer,status:'conflicting-evidence',message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE},
  {...answer,claims:[{text:'A result.',citations:[{id:'e0',quote:'a conclusive result'}]}]}])
  assert.throws(()=>validateGroundedDocumentAnswer(changed,prepared.supports));
 assert.deepEqual(validateGroundedDocumentAnswer(answer,prepared.supports),answer);
});

test('one statement may cite distinct actual quotes from the same evidence without duplicating a citation',()=>{
 const prepared=prepareDocumentAnswer('What was measured and how certain is the result?',context());
 const combined={status:'answered',message:'',claims:[{text:'Two samples were used and the result is preliminary.',citations:[
  {id:'e0',quote:'uses two samples.'},{id:'e0',quote:'The result remains preliminary.'}]}]};
 assert.deepEqual(validateGroundedDocumentAnswer(combined,prepared.supports),combined);
 for(const quote of ['uses two samples.','uses  two samples.','a conclusive result'])
  assert.throws(()=>validateGroundedDocumentAnswer({...combined,claims:[{...combined.claims[0],citations:[
   combined.claims[0].citations[0],{id:'e0',quote}]}]},prepared.supports));
 const duplicateImage={status:'answered',message:'',claims:[{text:'A supplied image.',citations:[
  {id:'i0',quote:''},{id:'i0',quote:''}]}]};
 assert.throws(()=>validateGroundedDocumentAnswer(duplicateImage,[{id:'i0',kind:'image'}]));
 assert.throws(()=>validateGroundedDocumentAnswer({...combined,status:'conflicting-evidence',claims:[
  combined.claims[0],{text:'A second statement.',citations:[combined.claims[0].citations[1]]}]},prepared.supports));
});

test('answers require supplied evidence and reject invented quotes and unreferenced claims',()=>{
 const prepared=prepareDocumentAnswer('How many samples?',context());
 assert.deepEqual(validateGroundedDocumentAnswer(answer,prepared.supports),answer);
 for(const changed of [
  {...answer,claims:[{text:'Three samples.',citations:[{id:'e0',quote:'three samples'}]}]},
  {...answer,claims:[{text:'Two samples.',citations:[{id:'outside-source',quote:'two samples'}]}]},
  {...answer,claims:[{text:'Two samples.',citations:[]}]},
  {...answer,message:'Unreferenced additional facts.'},
  {...answer,extra:'unexpected'}])assert.throws(()=>validateGroundedDocumentAnswer(changed,prepared.supports));
 const declined={status:'insufficient-evidence',message:'No outcome is supplied.',claims:[]};
 assert.deepEqual(validateGroundedDocumentAnswer(declined,prepared.supports),{...declined,message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE});
 assert.throws(()=>validateGroundedDocumentAnswer({...declined,claims:answer.claims},prepared.supports));
 assert.throws(()=>validateGroundedDocumentAnswer({...answer,status:'conflicting-evidence'},prepared.supports));
});

test('a complete parent preserves evidence identities and refuses snippets, truncated parents or changed bodies',()=>{
 const c=context();const node={documentId:'doc',documentVersionId:'version',sourceVersionId:source.sourceVersionId,
  sourceHash:source.sourceHash,evidenceId:'evidence',locator:c.anchors[0].locator,body,bodySha256:hash(body)};
 c.parents=[{parentId:'section-0',status:'available',sourceNodeCount:1,sourceBodyCodepoints:Array.from(body).length,nodes:[node]}];
 assert.equal(prepareDocumentAnswer('What is the result?',c).supports.length,1);
 c.anchors[0].evidence_body=undefined;assert.throws(()=>prepareDocumentAnswer('What?',c),/not snippets/);
 c.anchors[0].evidence_body='full-page';c.parents[0].sourceNodeCount=2;
 assert.throws(()=>prepareDocumentAnswer('What?',c),/incomplete/);
 c.parents[0].sourceNodeCount=1;node.documentVersionId='changed';
 assert.throws(()=>prepareDocumentAnswer('What?',c),/Conflicting/);
});

test('actual PNG bytes are bound to image citations; captions cannot impersonate pixels',()=>{
 // Complete, small public-domain test PNG, not merely a caption or an IHDR stub.
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
 const c=context(),sha=hash(bytes);
 c.images=[{attachmentId:'attachment',assetId:sha,captionEvidenceId:'caption',sha256:sha,byteLength:bytes.length,
  width:1,height:1,mime:'image/png',bytes,source}];
 const prepared=prepareDocumentAnswer('What does the figure show?',c);
 const illustrated={status:'answered',message:'',claims:[{text:'The supplied figure is one pixel.',citations:[{id:'i0',quote:''}]}]};
 assert.deepEqual(validateGroundedDocumentAnswer(illustrated,prepared.supports),illustrated);
 assert.throws(()=>validateGroundedDocumentAnswer({...illustrated,claims:[{text:'A figure.',citations:[{id:'i0',quote:'invented OCR'}]}]},prepared.supports));
 c.images[0].bytes=Buffer.from('only a caption');assert.throws(()=>prepareDocumentAnswer('What?',c),/checksum/);
});

test('answer fingerprints preserve version, parsing warnings and unavailable context',()=>{
 const c=context(),original=prepareDocumentAnswer('What?',c).fingerprint;
 c.anchors[0].id='pg:new-version:1';assert.notEqual(prepareDocumentAnswer('What?',c).fingerprint,original);
 c.anchors[0].id='pg:version:1';c.parents=[{parentId:'large-section',status:'unavailable-size-exceeds-8192',
  sourceNodeCount:20,sourceBodyCodepoints:9000,nodes:[]}];
 const prepared=prepareDocumentAnswer('What?',c);
 assert.notEqual(prepared.fingerprint,original);assert.equal(prepared.supports.length,1);
 assert.deepEqual(prepared.warnings,['Formula fidelity unverified.']);assert.equal(prepared.unavailableParents.length,1);
});

test('synthesis revalidates current sources, rejects incomplete output and makes no paid repair request',async()=>{
 const original=globalThis.fetch;let calls=0,reads=0,attempts=0,requestHash='';
 globalThis.fetch=async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body));requestHash=hash(String(init?.body));
  assert.equal(request.model,'gpt-5-mini');assert.equal(request.store,false);
  assert.equal(request.reasoning.effort,'low');assert.equal(request.max_output_tokens,4000);
  assert.match(request.input[0].content,/untrusted data/);
  assert.match(request.input[0].content,/canonical Kernel facts/);
  const input=JSON.parse(request.input[1].content[0].text),unit=input.quoteUnits.find((item:{text:string})=>item.text.includes('uses two samples.'));
  return Response.json({status:'completed',model:'gpt-5-mini',output_text:JSON.stringify({...answer,
   claims:[{text:answer.claims[0].text,citations:[{id:unit.id}]}]}),usage:{input_tokens:100,output_tokens:100}});
 };
 try{
  const result=await synthesizeDocumentAnswer('How many samples?',async()=>{reads++;return context();},
   {beforeAttempt:async()=>{attempts++;}});
  assert.equal(result.answer.status,'answered');assert.equal(result.model,'gpt-5-mini');
  assert.equal(result.promptVersion,'grounded-document-answer-v5');
  assert.equal(result.providerRequestSha256,requestHash);assert.equal(result.selectedUnits.length,1);
  assert.equal(reads,2);assert.equal(attempts,1);assert.equal(calls,1);
  reads=0;
  await assert.rejects(synthesizeDocumentAnswer('How many samples?',async()=>{
   const c=context();if(++reads===2)c.anchors[0].id='pg:changed:1';return c;
  }),/evidence changed/);
  assert.equal(calls,2);assert.equal(reads,2);
  globalThis.fetch=async()=>{calls++;return Response.json({status:'incomplete',output_text:JSON.stringify(answer)});};
  await assert.rejects(synthesizeDocumentAnswer('How many samples?',async()=>context()),/incomplete/);
  assert.equal(calls,3,'incomplete or stale evidence never triggers an automatic paid retry');
 }finally{globalThis.fetch=original;}
});

test('development answers reject a provider model mismatch and never label mini as Astra',async()=>{
 const names=['KERNEL_ADMIN_DEVELOPMENT_RUN','KERNEL_DATABASE_URL','DATABASE_URL','AI_MODEL_RATES'] as const;
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]])),original=globalThis.fetch;
 let calls=0,attempts=0;
 try{
  process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
  process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
  process.env.AI_MODEL_RATES=JSON.stringify({'gpt-6-astra':{input:10,output:50,context:1050000}});
  globalThis.fetch=async()=>{calls++;return Response.json({status:'completed',model:'gpt-5-mini',
   output_text:JSON.stringify(answer),usage:{input_tokens:100,output_tokens:100}});};
  await assert.rejects(synthesizeDocumentAnswer('How many samples?',async()=>context(),{
   scope:'development',model:'gpt-6-astra',reasoningEffort:'high',maxOutputTokens:16384,timeoutMs:120000,
   beforeAttempt:async()=>{attempts++;}}),/different or unverified model/);
  assert.equal(calls,1);assert.equal(attempts,1);
 }finally{globalThis.fetch=original;for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
});

test('Kernel study answers use actual PG parent/image evidence and refuse sources hidden during generation',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const tag=randomUUID(),owner='answer-owner-'+tag,id='answer-doc-'+tag,title='Study answer source '+tag;
 const bodies=[body,'Both samples are compared under identical conditions.','Figure 1: Comparison of two samples.'];
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:title,hash:hash(JSON.stringify(bodies)),mime:'text/plain',
  origin:'answer-fixture',originKey:id},bodies.map((text,index)=>({pageNumber:index+1,locator:'original-node:'+index,text})),
  {parserVersion:'answer-fixture-v1',warnings:['Formula fidelity unverified.']});
 const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});assert.equal(resolution.status,'resolved');
 if(resolution.status!=='resolved')throw new Error('Source unresolved');
 const expected={...resolution.document,courseId:''},nodes=(await kernel.readDocumentSourcePages(owner,expected)).nodes;
 await kernel.registerDocumentStructure(owner,expected,{rawSourceHash:expected.sourceHash,parserVersion:'original-structure-v1',
  parents:[{id:'section',heading:'Experimental conditions'}],nodes:nodes.map((node,index)=>({evidenceId:node.evidenceId,
   locator:node.locator,ordinal:index,kind:index===2?'caption':'paragraph',parentId:index===2?null:'section',bodySha256:node.bodySha256}))});
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
 await kernel.registerDocumentImage(owner,expected,{captionEvidenceId:nodes[2].evidenceId,originalReference:'figure.png',
  provenance:{sourceUrl:'https://example.edu/original/figure.png',revision:'fixture-v1'},bytes});
 const original=globalThis.fetch;let calls=0,hide=false;
 globalThis.fetch=async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body)),content=request.input[1].content,
   input=JSON.parse(content[0].text),unit=input.quoteUnits.find((item:{text:string})=>item.text.includes('uses two samples.'));
  assert.ok(unit);assert.equal(content.filter((item:{type:string})=>item.type==='input_image').length,1);
  if(hide)await kernel.hideParsedDocument(owner,id);
  return Response.json({status:'completed',model:'gpt-5-mini',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify({
   status:'answered',message:'',claims:[{text:'The experiment uses two samples.',citations:[{id:unit.id}]}]})});
 };
 try{
  const options={sourceHint:{selectedDocumentTitle:title},semantic:false,aiRerank:false,includeParents:true,includeImages:true};
  const result=await kernel.answerStudyContent(owner,'How many samples?',options);
  assert.equal(result.answer.status,'answered');assert.equal(result.imageEvidenceCount,1);assert.equal(result.textEvidenceCount,3);
  assert.deepEqual(result.warnings,['Formula fidelity unverified.']);assert.equal(calls,1);
  hide=true;await assert.rejects(kernel.answerStudyContent(owner,'How many samples?',options),/no longer current|Selected document/);
  assert.equal(calls,2,'a changed source is rejected without a model retry');
 }finally{globalThis.fetch=original;}
});
