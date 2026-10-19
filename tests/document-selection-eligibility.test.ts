import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareDocumentAnswer,buildDocumentEvidenceSelectionRequest,synthesizeDocumentAnswer,documentAnswerSettings,
 validateQuestionEvidenceSelection,type DocumentAnswerContext,type DocumentAnswerPolicy} from '../lib/kernel/document-answer.ts';
import {studySelectionEligibility} from '../lib/study-answer.ts';

process.env.DATABASE_URL=':memory:';process.env.SERVICE_VAULT_DIR=join(tmpdir(),'selection-eligibility-'+randomUUID());
process.env.OPENAI_API_KEY='local-only';process.env.AI_MONTHLY_BUDGET='5';process.env.AI_BUDGET_TEST_BYPASS='false';
const context=():DocumentAnswerContext=>({sourceContentIsUntrusted:true,parents:[],images:[],anchors:[{
 id:'pg:v:1',document_id:'doc',course_id:'',name:'Source',origin:'fixture',origin_key:'source',source_hash:'hash',source_version_id:'sv',
 body:'The experiment used two trials.',locator:'page:1',page_number:1,evidence_id:'evidence',parser_version:'fixture',score:1,evidence_body:'full-page'}]});
const settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000};
const policy:DocumentAnswerPolicy={scope:'application',...settings,evidenceSelection:'select-then-answer',citationCheck:{mode:'selected-once',beforeAttempt:async()=>{},recordResponse:async()=>{}}};
const response=(value:unknown)=>new Response(JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:20},output_text:JSON.stringify(value)}));

test('eligibility opt-in preserves exact evidence/image/user transport and original default selector schema',()=>{
 const p=prepareDocumentAnswer('How many trials?',context()),ordinary=buildDocumentEvidenceSelectionRequest(p,settings,policy),
  candidate=buildDocumentEvidenceSelectionRequest(p,settings,{...policy,selectionEligibility:'question-evidence-v1'});
 assert.deepEqual(candidate.input.slice(1),ordinary.input.slice(1));
 assert.deepEqual(candidate.text.format.schema.properties.referenceIds,ordinary.text.format.schema.properties.referenceIds);
 assert.deepEqual(ordinary.text.format.schema.required,['referenceIds']);
 assert.deepEqual(candidate.text.format.schema.required,['referenceIds','eligibility','reason']);
 assert.equal(studySelectionEligibility('off'),undefined);assert.throws(()=>studySelectionEligibility('other'));
});

test('non-sufficient assessment returns neutral refusal with evidence receipt and source recheck, without generation',async()=>{
 const saved=globalThis.fetch;
 try{for(const eligibility of ['not-established','uncertain']){
  let calls=0,reads=0;globalThis.fetch=async(_url,init)=>{calls++;const b=JSON.parse(String(init?.body)),input=JSON.parse(b.input.at(-1).content[0].text);
   return response({referenceIds:[input.quoteUnits[0].id],eligibility,reason:'The supplied evidence is related but not enough for the requested answer.'});};
  const result=await synthesizeDocumentAnswer('How long did it take?',async()=>{reads++;return context();},{...policy,selectionEligibility:'question-evidence-v1'});
  assert.equal(calls,1);assert.equal(reads,2);assert.equal(result.answer.status,'insufficient-evidence');assert.deepEqual(result.answer.claims,[]);
  assert.equal(result.answer.message,'I cannot provide a sufficiently supported answer.');
  assert.equal(result.evidenceSelection?.eligibility?.decision,eligibility);assert.ok(result.evidenceSelection!.referenceIds.length);
  assert.equal(result.evidenceSelection?.eligibility?.fallible,true);
 }}finally{globalThis.fetch=saved;}
});

test('sufficient selection preserves the ordinary generation wire and source-bound answer',async()=>{
 const saved=globalThis.fetch,run=async(enabled:boolean)=>{
  const requests:any[]=[];globalThis.fetch=async(_url,init)=>{const b=JSON.parse(String(init?.body));requests.push(b);const input=JSON.parse(b.input.at(-1).content[0].text),id=input.quoteUnits[0].id;
   return response(requests.length===1?{referenceIds:[id],...(enabled?{eligibility:'sufficient',reason:'The selected source gives the requested trial count.'}:{})}:
    {status:'answered',message:'',claims:[{text:'Two trials.',citations:[{id}]}]});};
  const result=await synthesizeDocumentAnswer('How many trials?',async()=>context(),{...policy,...(enabled?{selectionEligibility:'question-evidence-v1' as const}:{})});
  assert.equal(requests.length,2);assert.equal(result.answer.claims[0].text,'Two trials.');return requests[1];
 };
 try{assert.deepEqual(await run(true),await run(false));}finally{globalThis.fetch=saved;}
});

test('configuration, malformed sufficiency and stale source evidence fail before generation',async()=>{
 await assert.rejects(documentAnswerSettings({...policy,selectionEligibility:'question-evidence-v1',scope:'development'}),/requires application/);
 assert.throws(()=>validateQuestionEvidenceSelection({referenceIds:[],eligibility:'sufficient',reason:'yes'}));
 const saved=globalThis.fetch;let calls=0,reads=0;
 try{globalThis.fetch=async(_url,init)=>{calls++;const b=JSON.parse(String(init?.body)),v=JSON.parse(b.input.at(-1).content[0].text);
  return response({referenceIds:[v.quoteUnits[0].id],eligibility:'not-established',reason:'not enough'});};
  await assert.rejects(synthesizeDocumentAnswer('How long?',async()=>{const c=context();if(reads++)c.anchors[0].body+=' A new version.';return c;},
   {...policy,selectionEligibility:'question-evidence-v1'}),/evidence changed/);assert.equal(calls,1);
 }finally{globalThis.fetch=saved;}
});
