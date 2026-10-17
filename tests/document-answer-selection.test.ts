import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareDocumentAnswer,prepareDocumentAnswerForPolicy,buildDocumentAnswerRuntimeRequest,buildDocumentEvidenceSelectionRequest,
 buildSelectedDocumentAnswerRequest,validateDocumentEvidenceSelection,synthesizeDocumentAnswer,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';

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
