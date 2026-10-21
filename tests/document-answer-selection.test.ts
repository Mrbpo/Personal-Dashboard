import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareDocumentAnswer,prepareDocumentAnswerForPolicy,buildDocumentAnswerRuntimeRequest,buildDocumentEvidenceSelectionRequest,
 buildSelectedDocumentAnswerRequest,validateDocumentEvidenceSelection,normalizeDocumentEvidenceSelection,retainSelectedStoredNodeText,retainDocumentSelectionContext,retainSelectedSourceIdentity,synthesizeDocumentAnswer,documentAnswerSettings,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'selection-test-'+randomUUID());
process.env.OPENAI_API_KEY='test-never-sent';process.env.AI_MONTHLY_BUDGET='5';
const sha=(s:string|Uint8Array)=>createHash('sha256').update(s).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
const settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000};
const policy={scope:'application' as const,model:'gpt-5.4-mini' as const,maxOutputTokens:3000,evidenceSelection:'select-then-answer' as const};
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],
 anchors:['a','b'].map((id,index)=>({id:`pg:v${id}:1`,document_id:id,course_id:'course',name:`Original ${id}`,origin:'fixture',origin_key:id,
  source_hash:`hash-${id}`,source_version_id:`sv-${id}`,body:index?'Unselected original B: hidden-marker-947.':'Original A establishes the sample count of two.',
  locator:'original:1',page_number:1,evidence_id:`evidence-${id}`,parser_version:'fixture',score:1,evidence_body:'full-page'})),
 images:['a','b'].map(id=>({attachmentId:`image-${id}`,assetId:sha(png),captionEvidenceId:`figure-caption-${id}`,sha256:sha(png),byteLength:png.length,
  width:1,height:1,mime:'image/png',bytes:png,source:{documentId:id,currentVersionId:`v${id}`,sourceVersionId:`sv-${id}`,sourceHash:`hash-${id}`}}))};}
const output=(value:unknown)=>new Response(JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:20},output_text:JSON.stringify(value)}),{status:200});
const claim=(id:string)=>({status:'answered',message:'',claims:[{text:'The count is two.',citations:[{id}]}]});

function identityContext():DocumentAnswerContext{
 const c=context(),body='CS229. Machine Learning course information.',bodySha256=sha(body),source={documentId:'a',currentVersionId:'va',sourceVersionId:'sv-a',sourceHash:'hash-a'};
 c.images=[];c.anchors[0]={...c.anchors[0],id:'pg:va:2',page_number:2,locator:'original:2'};
 c.parents=[{parentId:'original-identity-a',status:'available',sourceNodeCount:1,sourceBodyCodepoints:Array.from(body).length,
  nodes:[{documentId:'a',documentVersionId:'va',sourceVersionId:'sv-a',sourceHash:'hash-a',evidenceId:'identity-a',locator:'original:1',
   ordinal:0,kind:'page',body,bodySha256}]}];
 c.sourceIdentityContext={version:'literal-course-frontpage-v1',requestedCodes:['CS229'],coverage:'first-persisted-pdf-page-only',
  courseOwnershipVerified:false,semanticVerified:false,omissions:[],additions:[{source,evidenceId:'identity-a',locator:'original:1',physicalPage:1,bodySha256,
   observations:[{raw:'CS229',code:'CS229',startUtf16:0,endUtf16:5}]}]};
 return c;
}

test('selector set normalization preserves first order and rejects invalid or unoffered references before dedup',()=>{
 const c=context();c.textQuotePolicy='stored-page-v1';c.anchors[0].body='Original intervening paragraph. '.repeat(75);
 const p=prepareDocumentAnswer('What count is given?',c),
  fine=p.quoteUnits.filter(u=>u.selectable&&!u.pageContext),a=fine[0].id,b=fine[1].id;
 const raw={referenceIds:[b,a,b,a]},before=JSON.stringify(raw),r=normalizeDocumentEvidenceSelection(raw,p);
 assert.deepEqual(r.referenceIds,[b,a]);assert.equal(JSON.stringify(raw),before);
 assert.deepEqual(r.normalization,{policy:'identical-selector-reference-dedup-v1',providerReferenceIds:[b,a,b,a],
  normalizedReferenceIds:[b,a],duplicateReferenceIds:[b,a]});
 assert.deepEqual(normalizeDocumentEvidenceSelection({referenceIds:[]},p),{referenceIds:[],normalization:undefined});
 assert.equal(normalizeDocumentEvidenceSelection({referenceIds:[a,b]},p).normalization,undefined);
 assert.throws(()=>validateDocumentEvidenceSelection(raw,p),'downstream strict validator still rejects duplicates');
 for(const value of [{referenceIds:[a,'invented',a]},{referenceIds:Array(65).fill(a)},
  {referenceIds:[a,a],extra:true},{referenceIds:[a,5,a]},
  {referenceIds:[p.quoteUnits.find(u=>u.pageContext)!.id]}])
  assert.throws(()=>normalizeDocumentEvidenceSelection(value,p));
});

test('duplicate offered model selections reach generation in both lanes with an auditable receipt and no extra call',async()=>{
 const c=context();c.images=[];c.anchors=c.anchors.slice(0,1);
 const question='What count does Original a report?',p=prepareDocumentAnswer(question,c),id=p.quoteUnits[0].id,saved=globalThis.fetch;
 try{
  for(const typed of [false,true]){
   let calls=0;globalThis.fetch=async(_url,init)=>{calls++;const req=JSON.parse(String(init?.body));
    if(calls===1)return output({referenceIds:[id,id]});
    const input=JSON.parse(req.input.at(-1).content[0].text);
    assert.equal(input.quoteUnits.filter((u:any)=>u.id===id).length,1);
    assert.doesNotMatch(JSON.stringify(input),/hidden-marker-947/);return output(claim(id));};
   const result=await synthesizeDocumentAnswer(question,async()=>c,{...policy,
    citationCheck:{mode:'selected-once',beforeAttempt:async()=>{},recordResponse:async()=>{}},
    ...(typed?{sourceValueContract:'cell-bindings-v2' as const,recordSourceValueRawResponse:async()=>{},recordSourceValueDerivation:async()=>{}}:{})});
   assert.equal(calls,2);assert.equal(result.answer.status,'answered');
   assert.ok('evidenceSelection' in result);
   assert.deepEqual(result.evidenceSelection!.referenceNormalization?.providerReferenceIds,[id,id]);
   assert.deepEqual(result.evidenceSelection!.referenceNormalization?.normalizedReferenceIds,[id]);
   assert.deepEqual(result.evidenceSelection!.referenceNormalization?.duplicateReferenceIds,[id]);
   assert.equal(result.evidenceSelection!.coverage,'unassessed');
  }
 }finally{globalThis.fetch=saved;}
});

test('same-source identity survives ordinary and typed fallback selection in actual generation payloads',async()=>{
 const c=identityContext(),question='Compare CS229 textbooks.',p=prepareDocumentAnswer(question,c),
  material=p.quoteUnits.find(q=>q.supportId==='e0')!.id,identity=p.quoteUnits.find(q=>q.text.startsWith('CS229.'))!,saved=globalThis.fetch;
 const check={mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}};
 try{
  for(const sourceValues of [false,true]){
   let calls=0;
   globalThis.fetch=async(_url,init)=>{calls++;const req=JSON.parse(String(init?.body));
    if(calls===1)return output({referenceIds:[material]});
    const input=JSON.parse(req.input.at(-1).content[0].text);
    assert.ok(input.quoteUnits.some((q:any)=>q.id===identity.id&&q.text===identity.text&&q.quoteSha256===identity.quoteSha256));
    assert.ok(req.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum.includes(identity.id));
    assert.doesNotMatch(JSON.stringify(req.input),/hidden-marker-947|input_image/);
    return output(claim(identity.id));};
   const result=await synthesizeDocumentAnswer(question,async()=>c,{...policy,citationCheck:check,sourceIdentityContext:'literal-course-frontpage-v1',
    ...(sourceValues?{sourceValueContract:'cell-bindings-v2' as const,recordSourceValueRawResponse:async()=>{},recordSourceValueDerivation:async()=>{}}:{})});
   assert.equal(calls,2,'no additional model phase');assert.ok('evidenceSelection' in result);
   assert.equal(result.evidenceSelection?.outcome,'provided-with-system-retention');
   assert.ok(result.evidenceSelection?.referenceIds.includes(identity.id));
   assert.deepEqual(result.evidenceSelection?.sourceIdentityRetention?.addedReferenceIds,[identity.id]);
   assert.equal(result.evidenceSelection?.sourceIdentityRetention?.courseOwnershipVerified,false);
   if(sourceValues)assert.ok(result.evidenceSelection?.systemRetainedReferenceIds?.includes(identity.id),'typed receipt cannot overwrite common references');
  }
 }finally{globalThis.fetch=saved;}
});

test('identity retention rejects stale bindings and does not rescue empty or foreign-source selections',()=>{
 const c=identityContext(),q='Compare CS229 textbooks.',p=prepareDocumentAnswer(q,c),foreign=p.quoteUnits.find(u=>u.supportId==='e1')!.id;
 assert.deepEqual(retainSelectedSourceIdentity([],[],p)!.referenceIds,[]);
 const none=retainSelectedSourceIdentity([foreign],[foreign],p)!;assert.deepEqual(none.referenceIds,[foreign]);
 assert.equal(none.decisions[0].status,'source-not-selected');
 const invalid=structuredClone(c);invalid.sourceIdentityContext!.additions[0].source.sourceVersionId='stale';
 assert.throws(()=>prepareDocumentAnswer(q,invalid),/identity evidence differs/);
 const wrongSpan=structuredClone(c);wrongSpan.sourceIdentityContext!.additions[0].observations[0].endUtf16=4;
 assert.throws(()=>prepareDocumentAnswer(q,wrongSpan),/identity span differs/);
 const unverified=structuredClone(c);(unverified.sourceIdentityContext as any).courseOwnershipVerified=true;
 assert.throws(()=>prepareDocumentAnswer(q,unverified),/identity binding/);
 const plain=structuredClone(c);delete plain.sourceIdentityContext;
 const before=prepareDocumentAnswer(q,plain);assert.equal(retainSelectedSourceIdentity([before.quoteUnits[0].id],[before.quoteUnits[0].id],before),undefined);
 assert.notEqual(before.fingerprint,p.fingerprint,'validated identity binding participates in source rechecks');
});

test('identity retention preserves the existing reference capacity atomically',()=>{
 const c=identityContext();
 for(let i=3;i<=65;i++)c.anchors.push({...c.anchors[0],id:`pg:va:${i}`,page_number:i,evidence_id:`material-${i}`,locator:`original:${i}`,body:`Original material ${i}.`});
 const p=prepareDocumentAnswer('Compare CS229 textbooks.',c),materialSupports=new Set(p.supports.filter(s=>s.kind==='text'&&s.documentId==='a'&&s.evidenceId!=='identity-a').map(s=>s.id)),
  ids=p.quoteUnits.filter(q=>materialSupports.has(q.supportId)).map(q=>q.id);
 assert.equal(ids.length,64);
 const result=retainSelectedSourceIdentity(ids,ids,p)!;
 assert.deepEqual(result.referenceIds,ids);assert.deepEqual(result.addedReferenceIds,[]);assert.equal(result.decisions[0].status,'reference-limit');
 const existing=identityContext(),page=existing.parents[0].nodes[0];
 existing.anchors.push({...existing.anchors[0],id:'pg:va:1',page_number:1,locator:page.locator,evidence_id:page.evidenceId,body:page.body});
 const source=existing.sourceIdentityContext!.additions[0].source;
 existing.sourceIdentityContext!.additions=[];existing.sourceIdentityContext!.omissions=[{source,reason:'already-in-context'}];
 const prepared=prepareDocumentAnswer('Compare CS229 textbooks.',existing),material=prepared.quoteUnits.find(q=>q.supportId==='e0')!,
  identity=prepared.quoteUnits.find(q=>q.text.startsWith('CS229.'))!,retained=retainSelectedSourceIdentity([material.id],[material.id],prepared)!;
 assert.ok(retained.referenceIds.includes(identity.id),'an existing first page is retained too; not only newly added reader nodes');
});

test('application generation effort changes only generation and preserves the original selection request',()=>{
 const p=prepareDocumentAnswer('What did Original a test?',context()),ids=[p.quoteUnits[0].id],
  medium={...policy,generationReasoningEffort:'medium' as const},
  lowRequest=buildSelectedDocumentAnswerRequest(p,ids,settings,policy),mediumRequest=buildSelectedDocumentAnswerRequest(p,ids,settings,medium);
 assert.equal(mediumRequest.reasoning.effort,'medium');assert.equal(mediumRequest.model,lowRequest.model);
 assert.equal(mediumRequest.max_output_tokens,3000);
 assert.deepEqual({...mediumRequest,reasoning:lowRequest.reasoning},lowRequest,'source, prompt, schema and other settings stay identical');
 assert.deepEqual(buildDocumentEvidenceSelectionRequest(p,settings,medium),buildDocumentEvidenceSelectionRequest(p,settings,policy));
});

test('generation output envelope changes only generation while preserving selection and validates its explicit chain',async()=>{
 const p=prepareDocumentAnswer('What did Original a test?',context()),ids=[p.quoteUnits[0].id],
  check={mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}},
  base={...policy,citationCheck:check,generationReasoningEffort:'medium' as const},
  extended={...base,generationOutputTokens:6000 as const},
  before=buildSelectedDocumentAnswerRequest(p,ids,settings,base),after=buildSelectedDocumentAnswerRequest(p,ids,settings,extended);
 assert.equal(after.max_output_tokens,6000);assert.equal(before.max_output_tokens,3000);
 assert.deepEqual({...after,max_output_tokens:before.max_output_tokens},before,'source/model/prompt/schema/effort remain identical');
 assert.deepEqual(buildDocumentEvidenceSelectionRequest(p,settings,extended),buildDocumentEvidenceSelectionRequest(p,settings,base));
 assert.equal((await documentAnswerSettings(extended)).maxOutput,3000,'base selector bound stays unchanged');
 for(const invalid of [{...extended,generationOutputTokens:6001},{...extended,scope:'development',generationReasoningEffort:undefined},
  {...extended,evidenceSelection:undefined},{...extended,citationCheck:undefined}])
  await assert.rejects(documentAnswerSettings(invalid as any),/Generation output envelope/);
});

test('larger generation output reserves its real cost and retains ambiguous outcome without retry',async()=>{
 const {paidOpenAI}=await import('../lib/ai-budget.ts'),{database}=await import('../lib/database.ts'),original=globalThis.fetch,
  names=['AI_BUDGET_TEST_BYPASS','AI_MODEL_RATES'] as const,saved=Object.fromEntries(names.map(n=>[n,process.env[n]])),
  p=prepareDocumentAnswer('What did Original a test?',context()),ids=[p.quoteUnits[0].id],
  before=buildSelectedDocumentAnswerRequest(p,ids,settings,policy),after={...before,max_output_tokens:6000},rows:Array<{reserved:number;charged:number|null;status:string}>=[];
 let calls=0,ambiguous=false;
 const latest=async()=>database.prepare('SELECT reserved,charged,status FROM ai_ledger ORDER BY rowid DESC LIMIT 1').first<{reserved:number;charged:number|null;status:string}>();
 try{
  process.env.AI_BUDGET_TEST_BYPASS='false';delete process.env.AI_MODEL_RATES;
  globalThis.fetch=async()=>{calls++;rows.push((await latest())!);if(ambiguous)throw Error('Synthetic ambiguous transport');
   return Response.json({status:'incomplete',model:'gpt-5.4-mini',usage:{input_tokens:100,output_tokens:3000},output:[]});};
  await paidOpenAI('responses',before,undefined,{kind:'document-answer',dailyLimit:200});
  await paidOpenAI('responses',after,undefined,{kind:'document-answer',dailyLimit:200});
  assert.ok(Math.abs(rows[1].reserved-rows[0].reserved-.0135)<1e-10,'additional3000 output is reserved at the configured base mini rate');
  assert.equal((await latest())!.status,'settled');assert.equal((await latest())!.charged,(100*.75+3000*4.5)/1e6);
  ambiguous=true;await assert.rejects(paidOpenAI('responses',after,undefined,{kind:'document-answer',dailyLimit:200}),/ambiguous transport/);
  const held=(await latest())!;assert.equal(held.status,'reserved');assert.equal(held.charged,null);assert.equal(held.reserved,rows[1].reserved);
  assert.equal(calls,3,'no automatic retry');
 }finally{globalThis.fetch=original;for(const n of names)if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];}
});

test('generation verbosity preserves the exact source request and selector, with explicit chain validation',async()=>{
 const p=prepareDocumentAnswer('What did Original a test?',context()),ids=[p.quoteUnits[0].id],
  check={mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}},base={...policy,citationCheck:check},
  medium={...base,generationVerbosity:'medium' as const},before=buildSelectedDocumentAnswerRequest(p,ids,settings,base),
  after=buildSelectedDocumentAnswerRequest(p,ids,settings,medium);
 assert.equal((after.text as {verbosity?:string}).verbosity,'medium');assert.equal((before.text as {verbosity?:string}).verbosity,'low');
 assert.deepEqual({...after,text:{...after.text,verbosity:'low'}},before,'only generation text.verbosity changes');
 assert.deepEqual(buildDocumentEvidenceSelectionRequest(p,settings,medium),buildDocumentEvidenceSelectionRequest(p,settings,base));
 await documentAnswerSettings(medium);
 for(const invalid of [{...medium,generationVerbosity:'high'},{...medium,scope:'development'},
  {...medium,evidenceSelection:undefined},{...medium,citationCheck:undefined}])
  await assert.rejects(documentAnswerSettings(invalid as any),/Generation verbosity/);
});

test('mentioned source attribution survives selection without suppressing complementary sources',()=>{
 const c=context(),p=prepareDocumentAnswer('What did Original a test?',c),
  packet=(request:any)=>JSON.parse(request.input.at(-1).content[0].text),
  selection=packet(buildDocumentEvidenceSelectionRequest(p,settings,policy));
 assert.deepEqual(selection.mentionedSource,{policy:'exact-mentioned-source-attribution-v1',documentId:'a',
  documentVersionId:'va',sourceVersionId:'sv-a',sourceHash:'hash-a',title:'Original a'});
 assert.equal(selection.evidence.length,p.input.evidence.length);
 assert.deepEqual(selection.quoteUnits,p.input.quoteUnits);
 const foreign=p.quoteUnits.find(u=>u.supportId==='e1')!,
  selected=packet(buildSelectedDocumentAnswerRequest(p,[foreign.id],settings,policy));
 assert.deepEqual(selected.mentionedSource,selection.mentionedSource,'requested identity survives even if only another source was selected');
 assert.equal(selected.evidence[0].documentId,'b');assert.equal(selected.evidence.length,1);
 assert.equal(selected.quoteUnits[0].text,foreign.text);
 const multi=prepareDocumentAnswer('Compare Original a and Original b.',c);
 assert.equal(multi.input.mentionedSource,undefined);
 assert.deepEqual(multi.input.evidence,p.input.evidence,'multiple named documents remain available');
});

test('mentioned source attribution stays unknown for duplicate names or mixed versions',()=>{
 const duplicate=context();duplicate.anchors[1].name='Original a';
 assert.equal(prepareDocumentAnswer('What did Original a test?',duplicate).input.mentionedSource,undefined);
 const mixed=context();mixed.anchors.push({...mixed.anchors[0],id:'pg:other-version:2',page_number:2,evidence_id:'other-version'});
 assert.equal(prepareDocumentAnswer('What did Original a test?',mixed).input.mentionedSource,undefined);
 assert.equal(prepareDocumentAnswer('What did Original ab test?',context()).input.mentionedSource,undefined);
});

test('application retains omitted original text in a selected node without adding foreign nodes or images',async()=>{
 const c=context();c.anchors[0].body=Array.from({length:4},(_,i)=>`Stored paragraph ${i}. ${'Original context. '.repeat(65)}`).join('\n\n');
 const p=prepareDocumentAnswer('What are the stored stages?',c),units=p.quoteUnits.filter(unit=>unit.supportId==='e0'),
  suggested=units[0].id,omitted=units.at(-1)!.id,before=JSON.stringify(p);
 assert.ok(units.length>1);
 const retention=retainSelectedStoredNodeText({referenceIds:[suggested,'i0']},p),request=buildSelectedDocumentAnswerRequest(p,retention.referenceIds,settings,policy),
  packet=JSON.parse(String((request.input.at(-1)!.content as any[])[0].text));
 assert.deepEqual(retention.providerReferenceIds,[suggested,'i0']);assert.ok(retention.systemRetainedReferenceIds.includes(omitted));
 assert.ok(packet.quoteUnits.some((unit:any)=>unit.id===omitted&&unit.quoteSha256===sha(unit.text)));
 assert.doesNotMatch(JSON.stringify(request.input),/hidden-marker-947|Actual image evidence i1/);
 assert.deepEqual(retention.expandedSupportIds,['e0']);assert.equal(retention.structureRelationsVerified,false);
 assert.equal(retention.coverage,'unassessed');assert.equal(JSON.stringify(p),before);
 const saved=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(_url,init)=>{
   const request=JSON.parse(String(init?.body));calls++;
   if(calls===1)return output({referenceIds:[suggested]});
   const input=JSON.parse(request.input.at(-1).content[0].text);
   assert.ok(input.quoteUnits.some((unit:any)=>unit.id===omitted));
   assert.ok(request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum.includes(omitted));
   return output(claim(omitted));
  };
  const result=await synthesizeDocumentAnswer('What are the stored stages?',async()=>c,policy);
  assert.ok('evidenceSelection' in result);
  assert.equal(calls,2,'transport requires no additional model phase');
  assert.equal(result.evidenceSelection?.outcome,'provided-with-system-retention');
  assert.deepEqual(result.evidenceSelection?.textNodeRetention?.providerReferenceIds,[suggested]);
  assert.equal(result.selectedUnits[0].selectionId,omitted);
 }finally{globalThis.fetch=saved;}
});

test('named-source context preserves cross-node qualifications and excludes foreign text or unselected images',async()=>{
 const c=context();c.anchors.push({...c.anchors[0],id:'pg:va:2',page_number:2,evidence_id:'qualification-a',locator:'original:2',
  body:'This row is an author-added control, not the configuration of the prior publication.'});
 const question='What is the improvement in Original a?',p=prepareDocumentAnswerForPolicy(question,c,policy),
  id=p.quoteUnits.find(u=>u.supportId==='e0')!.id,qualification=p.quoteUnits.find(u=>u.text.includes('author-added control'))!;
 const before=JSON.stringify(p),r=retainDocumentSelectionContext({referenceIds:[id]},p);
 assert.ok(r.referenceIds.includes(qualification.id));assert.equal(r.mentionedSourceRetention?.status,'retained');
 assert.deepEqual(r.providerReferenceIds,[id]);assert.equal(JSON.stringify(p),before);
 const req=buildSelectedDocumentAnswerRequest(p,r.referenceIds,settings,policy),packet=JSON.parse(String((req.input.at(-1)!.content as any[])[0].text));
 assert.ok(packet.quoteUnits.some((u:any)=>u.id===qualification.id&&u.text===qualification.text&&u.quoteSha256===qualification.quoteSha256));
 assert.doesNotMatch(JSON.stringify(req.input),/hidden-marker-947|input_image/);
 const saved=globalThis.fetch;let calls=0;
 try{globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));
   if(calls===2)assert.match(JSON.stringify(request.input),/author-added control/);
   return output(calls===1?{referenceIds:[id]}:claim(id));};
  const result=await synthesizeDocumentAnswer(question,async()=>c,policy);assert.equal(calls,2);
  assert.ok('evidenceSelection' in result);assert.equal(result.evidenceSelection?.textNodeRetention?.mentionedSourceRetention?.status,'retained');
 }finally{globalThis.fetch=saved;}
});

test('named-source retention refuses ambiguity, mixed versions and atomic size or reference overflow',()=>{
 const make=()=>{const c=context();c.images=[];c.anchors.push({...c.anchors[0],id:'pg:va:2',page_number:2,evidence_id:'qualification-a',locator:'original:2',body:'Original qualification.'});return c;};
 const run=(c:DocumentAnswerContext,q='What is the improvement in Original a?')=>{const p=prepareDocumentAnswer(q,c),id=p.quoteUnits[0].id;
  return {p,id,result:retainDocumentSelectionContext({referenceIds:[id]},p)};};
 assert.equal(run(make(),'Compare Original a and Original b.').result.mentionedSourceRetention,undefined);
 const mixed=make();mixed.anchors[2].id='pg:other-version:2';assert.equal(run(mixed).result.mentionedSourceRetention,undefined);
 const large=make();large.anchors[2].body='Long original '.repeat(2600);const a=run(large);
 assert.equal(a.result.mentionedSourceRetention?.status,'skipped-size-limit');assert.deepEqual(a.result.referenceIds,[a.id]);
 const many=make();for(let i=3;i<68;i++)many.anchors.push({...many.anchors[0],id:`pg:va:${i}`,page_number:i,evidence_id:`a-${i}`,body:`Original note ${i}.`});
 const b=run(many);assert.equal(b.result.mentionedSourceRetention?.status,'skipped-reference-limit');assert.deepEqual(b.result.referenceIds,[b.id]);
 assert.deepEqual(retainDocumentSelectionContext({referenceIds:[]},b.p).referenceIds,[]);
 const foreign=make(),p=prepareDocumentAnswer('What is in Original a?',foreign);
 const foreignId=p.quoteUnits.find(u=>u.text.includes('hidden-marker-947'))!.id,
  retained=retainDocumentSelectionContext({referenceIds:[foreignId]},p);
 assert.equal(retained.mentionedSourceRetention?.status,'retained');
 assert.equal(retained.mentionedSourceRetention?.policy,'bounded-mentioned-source-text-v2');
 assert.deepEqual(retained.providerReferenceIds,[foreignId]);assert.ok(retained.referenceIds.includes(foreignId));
 assert.ok(retained.referenceIds.includes(p.quoteUnits.find(u=>u.text==='Original qualification.')!.id));
 assert.ok(retained.systemRetainedReferenceIds.every(id=>p.quoteUnits.some(u=>u.id===id)));
 assert.ok(retained.referenceIds.every(id=>!id.startsWith('i')),'no unselected images are added');
});

test('stored-node retention respects the 64-ID bound atomically and leaves empty or invalid selection strict',()=>{
 const c=context();c.anchors[0].body=Array.from({length:80},(_,i)=>`Paragraph ${i}. ${'word '.repeat(210)}`).join('\n\n');
 const p=prepareDocumentAnswer('What count?',c),units=p.quoteUnits.filter(unit=>unit.supportId==='e0');
 assert.ok(units.length>64);
 const result=retainSelectedStoredNodeText({referenceIds:[units[0].id]},p);
 assert.deepEqual(result.referenceIds,[units[0].id]);assert.deepEqual(result.skippedSupportIds,['e0']);
 assert.deepEqual(result.systemRetainedReferenceIds,[],'no silent partial node expansion at the limit');
 assert.deepEqual(retainSelectedStoredNodeText({referenceIds:[]},p).referenceIds,[]);
 for(const value of [{referenceIds:[units[0].id,units[0].id]},{referenceIds:['invented']},{referenceIds:[units[0].id],extra:true}])
  assert.throws(()=>retainSelectedStoredNodeText(value,p));
});

test('selection preserves source IDs while generation excludes unselected bodies and original images',()=>{
 const p=prepareDocumentAnswer('What count and figure are given?',context()),before=JSON.stringify(p),id=p.quoteUnits[0].id;
 const selection=buildDocumentEvidenceSelectionRequest(p,settings,policy),request=buildSelectedDocumentAnswerRequest(p,[id,'i0'],settings,policy);
 assert.equal(selection.text.format.name,'document_evidence_selection');
 assert.equal(selection.text.format.schema.properties.referenceIds.maxItems,64);
 const original=JSON.parse(String((selection.input.at(-1)!.content as any[])[0].text));assert.equal(original.quoteUnits.length,2);
 const content=request.input.at(-1)!.content as any[],packet=JSON.parse(content[0].text);
 assert.deepEqual(packet.quoteUnits.map((unit:any)=>unit.id),[id]);assert.equal(packet.quoteUnits[0].text,p.quoteUnits[0].text);
 assert.equal(packet.quoteUnits[0].quoteSha256,sha(p.quoteUnits[0].text));assert.equal(packet.evidenceSelection.coverage,'unassessed');
 assert.equal(content.filter(item=>item.type==='input_image').length,1);assert.match(JSON.stringify(content),/Actual image evidence i0/);
 assert.doesNotMatch(JSON.stringify(content),/hidden-marker-947|Actual image evidence i1/);
 assert.deepEqual(packet.documentMetadata.map((d:any)=>d.documentId),['a']);assert.equal(packet.completeSourceProof,undefined);
 const both=buildSelectedDocumentAnswerRequest(p,[id,p.quoteUnits[1].id],settings,policy);
 assert.equal(JSON.parse(String((both.input.at(-1)!.content as any[])[0].text)).documentMetadata.length,2,'multi-source selection remains possible');
 assert.equal(request.input[0].content,buildDocumentAnswerRuntimeRequest(p,settings,policy).input[0].content,'answer prompt is unchanged');
 assert.equal(JSON.stringify(p),before);
 for(const value of [{referenceIds:[id,id]},{referenceIds:['made-up']},{referenceIds:['e0']},{referenceIds:[id],claim:'extra'},{}])
  assert.throws(()=>validateDocumentEvidenceSelection(value,p));
});

test('two-stage application binds exact selected IDs and rejects a later citation outside the supplied input',async()=>{
 const saved=globalThis.fetch,c=context(),p=prepareDocumentAnswer('What count?',c),id=p.quoteUnits[0].id;let calls:any[]=[];
 try{
  globalThis.fetch=async(_url,init)=>{const req=JSON.parse(String(init?.body));calls.push(req);
   return output(calls.length===1?{referenceIds:[id]}:claim(id));};
  const result=await synthesizeDocumentAnswer('What count?',async()=>c,policy);
  assert.ok('evidenceSelection' in result);
  assert.equal(calls.length,2);assert.equal(result.selectedUnits[0].selectionId,id);assert.equal(result.evidenceSelection?.coverage,'unassessed');
  assert.equal(result.evidenceSelection?.referenceIds?.[0],id);assert.notEqual(result.evidenceSelection?.providerRequestSha256,result.providerRequestSha256);
  assert.doesNotMatch(JSON.stringify(calls[1].input),/hidden-marker-947/);
  calls=[];globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return output(calls.length===1?{referenceIds:[id]}:claim(p.quoteUnits[1].id));};
  await assert.rejects(synthesizeDocumentAnswer('What count?',async()=>c,policy),/outside the selected input/);assert.equal(calls.length,2);
 }finally{globalThis.fetch=saved;}
});

test('isolated application daily allowance shares selection generation and local kind without lifting monthly funds',async()=>{
 const {database}=await import('../lib/database.ts'),{budgetMonth,AiBudgetDeferredError}=await import('../lib/ai-budget.ts');
 const {KernelService}=await import('../lib/kernel/service.ts');
 // The literal guard is tested after initializing only this process's in-memory
 // SQLite. No PostgreSQL or file:/pdf-data/benchmark.sqlite connection is opened.
 await database.prepare('SELECT count(*) n FROM ai_ledger').first();
 assert.equal(process.env.DATABASE_URL,':memory:');
 const ledgerRows=async()=>(await database.prepare('SELECT * FROM ai_ledger ORDER BY id').all<Record<string,unknown>>()).results,
  originalRows=await ledgerRows(),originalIds=new Set(originalRows.map(r=>String(r.id))),ownedIds=new Set<string>(),
  dayStart=Math.floor(Date.now()/86400000)*86400000,dayEnd=dayStart+86400000,
  dayCount=async()=>Number((await database.prepare("SELECT count(*) n FROM ai_ledger WHERE kind='document-answer' AND created_at>=? AND created_at<?")
   .bind(dayStart,dayEnd).first<{n:number}>())!.n),beforeDayCount=await dayCount(),
  fillCount=Math.max(0,200-beforeDayCount),startDayCount=beforeDayCount+fillCount,fixturePrefix='synthetic-prior-'+randomUUID()+'-';
 const names=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN','AI_BUDGET_TEST_BYPASS','AI_MONTHLY_BUDGET'] as const;
 const env=Object.fromEntries(names.map(n=>[n,process.env[n]])),saved=globalThis.fetch,c=context(),question='What count?';
 const attempts:string[]=[],raw:any[]=[],checkedPolicy={...policy,dailyLimit:1000,citationCheck:{mode:'selected-once' as const,
  beforeAttempt:async(id:string)=>{attempts.push(id);},recordResponse:async(value:unknown)=>{raw.push(value);}}};
 const p=prepareDocumentAnswerForPolicy(question,c,checkedPolicy),id=p.quoteUnits.find(u=>u.selectable)!.id,
  kernel=new KernelService(),formats:string[]=[],rowCounts:number[]=[];
 (kernel as any).studyAnswerContextReader=async()=>async()=>c;
 try{
  process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
  process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';process.env.AI_BUDGET_TEST_BYPASS='false';process.env.AI_MONTHLY_BUDGET='1';
  if(fillCount)await database.prepare(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<?)
   INSERT INTO ai_ledger(id,month,kind,reserved,charged,status,created_at)
   SELECT ?||n,?,'document-answer',0.000001,0,'settled',? FROM seq`).bind(fillCount,fixturePrefix,budgetMonth(),Date.now()).run();
  for(let n=1;n<=fillCount;n++)ownedIds.add(fixturePrefix+n);
  globalThis.fetch=async(_url,init)=>{const fresh=(await ledgerRows()).filter(r=>!originalIds.has(String(r.id))&&!ownedIds.has(String(r.id)));
   for(const row of fresh)ownedIds.add(String(row.id));assert.equal(fresh.length,1,'Only this mock phase creates a fresh ordinary reservation');
   const request=JSON.parse(String(init?.body)),format=request.text.format.name;formats.push(format);rowCounts.push(await dayCount());
   if(format==='document_evidence_selection'){
    assert.equal(JSON.stringify(request),JSON.stringify(buildDocumentEvidenceSelectionRequest(p,settings,{...checkedPolicy,dailyLimit:200})));
    return output({referenceIds:[id]});}
   if(format==='grounded_document_answer_units')return output(claim(id));
   assert.equal(format,'citation_local_visual_unit_v1');
   return output({claimId:'c0',judgment:'supported',reason:'Synthetic fixture only.',citationFindings:{r0:{judgment:'supports',reason:'Synthetic original text.'}},
    objectUnitScope:{claim:'sample count',evidence:'sample count',alignment:'same'}});};
  const result=await kernel.answerStudyContent('owner',question,{},checkedPolicy);
  assert.equal(result.answer.status,'answered');assert.equal(attempts.length,1);assert.equal(raw.length,1);
  assert.deepEqual(formats,['document_evidence_selection','grounded_document_answer_units','citation_local_visual_unit_v1']);
  assert.deepEqual(rowCounts,[1,2,3].map(n=>startDayCount+n));
  const rows=await ledgerRows(),created=rows.filter(r=>ownedIds.has(String(r.id)));
  assert.equal(rows.length,originalRows.length+fillCount+3);assert.equal(created.length,fillCount+3);
  assert.ok(created.every(r=>r.kind==='document-answer'&&r.status==='settled'));
  const blocked=(reason:string)=>(e:unknown)=>e instanceof AiBudgetDeferredError&&e.reason===reason;
  await assert.rejects(kernel.answerStudyContent('owner',question,{}, {...checkedPolicy,dailyLimit:startDayCount+3}),blocked('daily'));
  process.env.AI_MONTHLY_BUDGET='0';
  await assert.rejects(kernel.answerStudyContent('owner',question,{},checkedPolicy),blocked('monthly'));
  assert.equal(formats.length,3);assert.equal(await dayCount(),startDayCount+3);
 }finally{globalThis.fetch=saved;
  try{for(const id of ownedIds){assert.ok(!originalIds.has(id));await database.prepare('DELETE FROM ai_ledger WHERE id=?').bind(id).run();}
   assert.deepEqual(await ledgerRows(),originalRows,'Only this fixture rows were removed; all prior rows and values survive');
  }finally{for(const n of names)if(env[n]===undefined)delete process.env[n];else process.env[n]=env[n];}
 }
});

test('empty selection and source changes stop before any generation without retries',async()=>{
 const saved=globalThis.fetch;
 try{for(const changed of [false,true]){
  const c=context(),p=prepareDocumentAnswer('What count?',c);let calls=0;
  globalThis.fetch=async()=>{calls++;if(changed)c.anchors[0].body+=' Changed source.';return output({referenceIds:changed?[p.quoteUnits[0].id]:[]});};
  if(changed)await assert.rejects(synthesizeDocumentAnswer('What count?',async()=>c,policy),/changed during evidence selection/);
  else{const result=await synthesizeDocumentAnswer('What count?',async()=>c,policy);assert.equal(result.answer.status,'insufficient-evidence');
   assert.ok('evidenceSelection' in result);
   assert.equal(result.evidenceSelection?.outcome,'no-evidence-selected');assert.equal(result.providerRequestSha256,null);}
  assert.equal(calls,1);
 }}finally{globalThis.fetch=saved;}
});

test('retained single-pass application has no selector request or receipt',async()=>{
 const saved=globalThis.fetch,c=context(),p=prepareDocumentAnswer('What count?',c);let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;assert.equal(JSON.parse(String(init?.body)).text.format.name,'grounded_document_answer_units');return output(claim(p.quoteUnits[0].id));};
 try{const {evidenceSelection,...single}=policy,result=await synthesizeDocumentAnswer('What count?',async()=>c,single);
  assert.equal(calls,1);assert.equal('evidenceSelection' in result,false);
 }finally{globalThis.fetch=saved;}
});

test('explicit unique caption-image units preserve original members and prevent caption-only references',async()=>{
 const c=context();assert.ok('captionEvidenceId' in c.images[0]);c.images[0].captionEvidenceId='evidence-a';
 const plain=prepareDocumentAnswer('What is in the table?',c),paired=prepareDocumentAnswerForPolicy('What is in the table?',c,policy),id=plain.quoteUnits[0].id;
 assert.equal(plain.quoteUnits[0].selectable,true);assert.equal(paired.quoteUnits[0].id,id);assert.equal(paired.quoteUnits[0].selectable,false);
 assert.equal(paired.quoteUnits[0].text,plain.quoteUnits[0].text);assert.equal(paired.quoteUnits[0].startUtf16,plain.quoteUnits[0].startUtf16);
 assert.equal(paired.quoteUnits[0].quoteSha256,plain.quoteUnits[0].quoteSha256);
 assert.throws(()=>validateDocumentEvidenceSelection({referenceIds:[id]},paired));
 const req=buildSelectedDocumentAnswerRequest(paired,['i0'],settings,policy),packet=JSON.parse(String((req.input.at(-1)!.content as any[])[0].text));
 assert.equal(packet.unitPolicy,'author-image-caption-v1');assert.equal(packet.evidence[0].captionMembers[0].text,plain.quoteUnits[0].text);
 assert.deepEqual(req.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,['i0']);
 assert.equal((req.input.at(-1)!.content as any[]).filter(item=>item.type==='input_image').length,1);
 assert.notEqual(paired.fingerprint,plain.fingerprint);assert.equal(prepareDocumentAnswerForPolicy('What is in the table?',c).fingerprint,plain.fingerprint);
 const saved=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));
  if(calls===1)assert.ok(!request.text.format.schema.properties.referenceIds.items.enum.includes(id));
  else assert.match(JSON.stringify(request.input),/Actual visual unit i0/);
  return output(calls===1?{referenceIds:['i0']}:claim('i0'));};
 try{const result=await synthesizeDocumentAnswer('What is in the table?',async()=>c,policy);
  assert.ok('evidenceSelection' in result);assert.equal(result.evidenceSelection?.unitPolicy,'author-image-caption-v1');
  assert.equal(result.selectedUnits[0].kind,'image');assert.equal(result.selectedUnits[0].evidence.captionMembers?.[0].text,plain.quoteUnits[0].text);
  assert.equal(calls,2);
 }finally{globalThis.fetch=saved;}
 c.images.push({...c.images[0],attachmentId:'ambiguous-image'});
 assert.equal(prepareDocumentAnswerForPolicy('What is in the table?',c,policy).quoteUnits[0].selectable,true,'ambiguous pairs remain ungrouped');
 c.images[0].source.sourceHash='different-current-source';c.images.pop();
 assert.equal(prepareDocumentAnswerForPolicy('What is in the table?',c,policy).quoteUnits[0].selectable,true,'foreign source cannot bind a caption');
});
