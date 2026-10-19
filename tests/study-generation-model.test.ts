import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {database} from '../lib/database.ts';
import {paidOpenAI,terraAnswerReservation,terraAnswerCharge} from '../lib/ai-budget.ts';
import {synthesizeDocumentAnswer,documentAnswerSettings,prepareDocumentAnswer,buildDocumentAnswerRequest,terraGenerationInputUpper,type DocumentAnswerContext,type DocumentAnswerPolicy} from '../lib/kernel/document-answer.ts';
import {studyGenerationModel} from '../lib/study-answer.ts';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'generation-model-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-local-only';process.env.AI_MONTHLY_BUDGET='5';process.env.AI_BUDGET_TEST_BYPASS='false';
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],images:[],anchors:[{
 id:'pg:current:1',document_id:'study',course_id:'',name:'Study',origin:'fixture',origin_key:'study',source_hash:sha('source'),
 source_version_id:'sv',body:'The study reports a count of two.',locator:'page:1',page_number:1,evidence_id:'page-one',parser_version:'fixture',score:1,evidence_body:'full-page'}]};}
const policy:DocumentAnswerPolicy={scope:'application',model:'gpt-5.4-mini',reasoningEffort:'low',generationReasoningEffort:'medium',maxOutputTokens:3000,
 evidenceSelection:'select-then-answer',citationCheck:{mode:'selected-once',beforeAttempt:async()=>{},recordResponse:async()=>{}}};
const usage={input_tokens:100,output_tokens:20,input_tokens_details:{cached_tokens:0,cache_write_tokens:90}};
const response=(model:string,value:unknown)=>new Response(JSON.stringify({status:'completed',model,usage,output_text:JSON.stringify(value)}));

test('generation override changes only the generator while preserving selector wire, actual model receipts and default generation',async()=>{
 const saved=globalThis.fetch,run=async(override:boolean)=>{
  const requests:any[]=[];
  globalThis.fetch=async(_url,init)=>{
   const body=JSON.parse(String(init?.body));requests.push(body);
   if(requests.length===1){assert.equal(body.model,'gpt-5.4-mini');const input=JSON.parse(body.input.at(-1).content[0].text);
    return response('gpt-5.4-mini-2026-03-17',{referenceIds:[input.quoteUnits[0].id]});}
   assert.equal(body.model,override?'gpt-5.6-terra':'gpt-5.4-mini');
   const input=JSON.parse(body.input.at(-1).content[0].text);
   return response(override?'gpt-5.6-terra':'gpt-5.4-mini-2026-03-17',{status:'answered',message:'',claims:[{text:'The count is two.',citations:[{id:input.quoteUnits[0].id}]}]});
  };
  const result=await synthesizeDocumentAnswer('What count?',async()=>context(),{...policy,...(override?{generationModel:'gpt-5.6-terra' as const}:{})});
  assert.equal(requests.length,2);assert.equal(result.evidenceSelection?.requestedModel,'gpt-5.4-mini');
  assert.equal(result.requestedModel,override?'gpt-5.6-terra':'gpt-5.4-mini');assert.equal(result.answer.claims[0].text,'The count is two.');
  return requests;
 };
 try{const old=await run(false),candidate=await run(true);assert.deepEqual(candidate[0],old[0]);
  assert.deepEqual({...candidate[1],model:'gpt-5.4-mini'},old[1],'only model differs in the actual generation wire');
 }finally{globalThis.fetch=saved;}
});

test('Terra bills cached and written inputs correctly and caps the entire no-premium input range',()=>{
 assert.equal(terraAnswerReservation(272000,4000),.728);
 assert.equal(terraAnswerCharge({status:'completed',model:'gpt-5.6-terra',usage:{input_tokens:1000,output_tokens:100,
  input_tokens_details:{cached_tokens:200,cache_write_tokens:300}}},1000,100),.00299);
 assert.throws(()=>terraAnswerReservation(272001,4000));assert.throws(()=>terraAnswerReservation(1000,4001));
 assert.throws(()=>terraAnswerCharge({status:'completed',model:'gpt-5.4-mini',usage},100,20),/Unverified/);
});

test('unknown Terra usage keeps its ordinary reservation and rejects the answer',async()=>{
 const before=await database.prepare('SELECT id FROM ai_ledger').all<{id:string}>(),ids=new Set(before.results.map(r=>r.id)),saved=globalThis.fetch;
 try{globalThis.fetch=async()=>new Response(JSON.stringify({status:'completed',model:'gpt-5.6-terra',usage:{...usage,input_tokens:101}}));
  await assert.rejects(paidOpenAI('responses',{model:'gpt-5.6-terra',max_output_tokens:20},null,{kind:'document-answer',dailyLimit:100,inputTokenUpper:100}),/reservation retained/);
 }finally{globalThis.fetch=saved;}
 const rows=(await database.prepare('SELECT id,status,charged,reserved FROM ai_ledger').all<{id:string;status:string;charged:number|null;reserved:number}>()).results.filter(r=>!ids.has(r.id));
 assert.equal(rows.length,1);assert.equal(rows[0].status,'reserved');assert.equal(rows[0].charged,null);assert.ok(rows[0].reserved>0);
});

test('generation opt-in rejects invalid scope or absent image accounting before provider work',async()=>{
 assert.equal(studyGenerationModel('inherit'),undefined);assert.equal(studyGenerationModel('gpt-5.6-terra'),'gpt-5.6-terra');
 assert.throws(()=>studyGenerationModel('gpt-6-astra'));
 await assert.rejects(documentAnswerSettings({...policy,generationModel:'gpt-5.6-terra',evidenceSelection:undefined}),/bounded application/);
 const c=context(),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
 c.images=[{attachmentId:'image',assetId:sha(png),captionEvidenceId:'page-one',sha256:sha(png),byteLength:png.length,width:1,height:1,mime:'image/png',bytes:png,
  source:{documentId:'study',currentVersionId:'current',sourceVersionId:'sv',sourceHash:sha('source')}}];
 const p=prepareDocumentAnswer('What is shown?',c),request=buildDocumentAnswerRequest(p,{model:'gpt-5.6-terra',reasoningEffort:'medium',maxOutputTokens:3000});
 assert.throws(()=>terraGenerationInputUpper(request,p,['i0']),/image accounting/);
});
