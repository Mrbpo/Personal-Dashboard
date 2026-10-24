import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {database} from '../lib/database.ts';
import {paidOpenAI,solGenerationCharge,solGenerationReservation} from '../lib/ai-budget.ts';
import {synthesizeDocumentAnswer,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {studyGenerationModel} from '../lib/study-answer.ts';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(process.cwd(),'data/generator-model-fixture-vault-never-written');
process.env.OPENAI_API_KEY='fixture-no-real-provider-key';
process.env.AI_MONTHLY_BUDGET='5';
process.env.AI_BUDGET_TEST_BYPASS='false';
type CapturedRequest={model:string;service_tier?:string;prompt_cache_options?:{mode:string;ttl:string};
 max_output_tokens:number;input:Array<{content:string|Array<{type:string;text?:string;image_url?:string}>}>};

test('application generator override keeps selector mini and verifies actual generator/ledger without retry',async()=>{
 await database.prepare('SELECT count(*) n FROM ai_ledger').first();
 const keys=['DATABASE_URL','KERNEL_DATABASE_URL','KERNEL_ADMIN_DEVELOPMENT_RUN','STUDY_GENERATION_MODEL'] as const;
 const saved=Object.fromEntries(keys.map(k=>[k,process.env[k]])),originalFetch=globalThis.fetch;
 const context:DocumentAnswerContext={sourceContentIsUntrusted:true,parents:[],images:[],anchors:[{
  id:'pg:version:1',document_id:'source',course_id:'',name:'Source',origin:'fixture',origin_key:'source',
  source_hash:'original-pdf-sha',source_version_id:'source-version',body:'Two samples were evaluated.',locator:'page:1',page_number:1,
  evidence_id:'evidence',parser_version:'fixture',score:1,evidence_body:'full-page'}]};
 const requests:CapturedRequest[]=[];let generatorModel='gpt-6.1-sol';
 const latest=()=>database.prepare('SELECT reserved,charged,status FROM ai_ledger ORDER BY rowid DESC LIMIT 1').first<{reserved:number;charged:number|null;status:string}>();
 try{
  delete process.env.STUDY_GENERATION_MODEL;
  assert.equal(studyGenerationModel(),undefined);
  assert.throws(()=>studyGenerationModel('gpt-6.1-sol'),/Development PDF/);
  process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
  process.env.KERNEL_DATABASE_URL='postgresql://unused:unused@localhost/pdf_acceptance_20261006';
  process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';
  assert.equal(studyGenerationModel('gpt-6.1-sol'),'gpt-6.1-sol');
  globalThis.fetch=async(input,init)=>{
   assert.equal(String(input),'https://api.openai.com/v1/responses');
   const body=JSON.parse(String(init?.body)) as CapturedRequest;requests.push(body);
   const sol=body.model==='gpt-6.1-sol';
   const content=body.input.at(-1)!.content;assert.ok(Array.isArray(content));
   const packet=JSON.parse(content[0].text!);
   const id=packet.quoteUnits.find((q:{id:string;selectable:boolean})=>q.selectable).id;
   const value=sol?{status:'answered',message:'',claims:[{text:'Two samples were evaluated.',citations:[{id}]}]}:{referenceIds:[id]};
   const usage=sol?{input_tokens:100,output_tokens:50,input_tokens_details:{cached_tokens:20,cache_write_tokens:30,
    cache_write_tokens_details:{ttl_30m_tokens:30,ttl_12h_tokens:0}}}:{input_tokens:100,output_tokens:50};
   return Response.json({status:'completed',model:sol?generatorModel:body.model,service_tier:'default',usage,
    output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]});
  };
  const policy={scope:'application' as const,model:'gpt-5.4-mini' as const,generationModel:'gpt-6.1-sol' as const,
   evidenceSelection:'select-then-answer' as const,citationCheck:{mode:'selected-once' as const,beforeAttempt:async()=>{},recordResponse:async()=>{}}};
  const result=await synthesizeDocumentAnswer('How many samples?',async()=>context,policy);
  assert.deepEqual(requests.map(r=>r.model),['gpt-5.4-mini','gpt-6.1-sol']);
  assert.equal(requests[0].prompt_cache_options,undefined);
  assert.deepEqual(requests[1].prompt_cache_options,{mode:'implicit',ttl:'30m'});
  assert.equal(requests[1].service_tier,'default');
  assert.equal(result.model,'gpt-6.1-sol');assert.equal(result.requestedModel,'gpt-6.1-sol');
  assert.equal(result.answer.claims[0].citations[0].quote,context.anchors[0].body);
  assert.equal((await latest())!.charged,(50*2+20*.1+30*2.5+50*10)/1e6);
  assert.equal((await latest())!.reserved,solGenerationReservation(requests[1]));
  generatorModel='gpt-5.4-mini';
  await assert.rejects(synthesizeDocumentAnswer('How many samples?',async()=>context,policy),/different or unverified model/);
  assert.equal(requests.length,4,'two separate routed attempts, no model fallback or retry');
  assert.equal((await latest())!.status,'reserved');assert.equal((await latest())!.charged,null);
  const before=requests.length;
  const image=structuredClone(requests[1]);assert.ok(Array.isArray(image.input[1].content));
  image.input[1].content.push({type:'input_image',image_url:'data:image/png;base64,AAAA'});
  await assert.rejects(paidOpenAI('responses',image,null,{kind:'document-answer',dailyLimit:200}),/text-only/);
  assert.equal(requests.length,before,'unverified image cost rejected before provider fetch');
  assert.equal(solGenerationCharge({model:'gpt-6.1-sol',service_tier:'default',usage:{input_tokens:14589,output_tokens:142,
   input_tokens_details:{cached_tokens:0,cache_write_tokens:14586}}}),null,'old unknown TTL breakdown stays unreconciled');
 }finally{globalThis.fetch=originalFetch;for(const k of keys){if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}}
});

test('Sol reservation rejects oversized and altered transport; split writes are not double counted',()=>{
 const body={model:'gpt-6.1-sol',service_tier:'default',prompt_cache_options:{mode:'implicit',ttl:'30m'},max_output_tokens:6000,
  input:[{role:'user',content:[{type:'input_text',text:'source'}]}]};
 assert.ok(solGenerationReservation(body)<=.40);
 assert.throws(()=>solGenerationReservation({...body,input:[{content:'x'.repeat(100000)}]}),/cost ceiling/);
 assert.throws(()=>solGenerationReservation({...body,service_tier:'fast'}),/Standard/);
 assert.equal(solGenerationCharge({model:'gpt-6.1-sol',service_tier:'default',usage:{input_tokens:12000,output_tokens:100,
  input_tokens_details:{cached_tokens:4000,cache_write_tokens:7000,cache_write_tokens_details:{ttl_30m_tokens:3000,ttl_12h_tokens:4000}}}}),
  (1000*2+4000*.1+3000*2.5+4000*5+100*10)/1e6);
 assert.equal(solGenerationCharge({model:'gpt-6.1-sol',service_tier:'default',usage:{input_tokens:2,output_tokens:1,
  input_tokens_details:{cached_tokens:1,cache_write_tokens:2,cache_write_tokens_details:{ttl_30m_tokens:2,ttl_12h_tokens:0}}}}),null);
});
