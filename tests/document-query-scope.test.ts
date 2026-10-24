import {test} from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {buildDocumentQueryScopeRequest,validateDocumentQueryScope} from '../lib/kernel/document-source.ts';
import {planDocumentQueryScope,documentAnswerSettings,type DocumentAnswerPolicy} from '../lib/kernel/document-answer.ts';

process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='query-scope-fixture-never-sent';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'query-scope-'+randomUUID());process.env.AI_MONTHLY_BUDGET='5';
const source={documentId:'current-source',title:'Original research.pdf',currentVersionId:'v1',sourceVersionId:'sv1',sourceHash:'original-sha'};
const question='According to Original research, which models were tested?';

test('question scope request carries only original question and bound metadata, with bounded mini settings',()=>{
 const r=buildDocumentQueryScopeRequest(question,source,'gpt-5.4-mini'),input=JSON.parse((r.input[1].content as any[])[0].text);
 assert.deepEqual(input,{question,namedSource:source});assert.equal(r.model,'gpt-5.4-mini');
 assert.equal(r.max_output_tokens,600);assert.equal(r.reasoning.effort,'low');assert.equal(r.store,false);
 assert.throws(()=>buildDocumentQueryScopeRequest('Ask another source',source,'gpt-5.4-mini'),/source scope/);
 assert.throws(()=>buildDocumentQueryScopeRequest(question,{...source,sourceHash:''},'gpt-5.4-mini'),/source scope/);
 assert.throws(()=>buildDocumentQueryScopeRequest(question,source,'gpt-6-astra' as any),/source scope/);
});

test('scope schema preserves unknown and cross-source decisions and rejects model-supplied filters',()=>{
 for(const scope of ['named-document','cross-source','unknown'])assert.equal(validateDocumentQueryScope({scope,reason:'Fixture intent.'}).scope,scope);
 for(const value of [{scope:'named-document',reason:'x',documentId:'foreign'},
  {scope:'all',reason:'x'},{scope:'named-document',reason:''}])assert.throws(()=>validateDocumentQueryScope(value),/scope response/);
});

test('one question-only planning request persists raw response and rechecks source before returning a fallible scope',async()=>{
 const old=globalThis.fetch;let calls=0,rechecks=0;const responses:any[]=[];
 const policy:DocumentAnswerPolicy={scope:'application',model:'gpt-5.4-mini',maxOutputTokens:3000,
  sourceRouting:{mode:'question-scope',beforeAttempt:async id=>assert.match(id,/^[a-f0-9]{64}$/),recordResponse:async r=>{responses.push(r);}}};
 try{globalThis.fetch=async(_url,init)=>{
   calls++;const r=JSON.parse(String(init?.body));assert.equal(r.text.format.name,'study_document_query_scope');
   return new Response(JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:20},
    output_text:JSON.stringify({scope:'cross-source',reason:'The question needs other documents.'})}));};
  const result=await planDocumentQueryScope(question,source,policy,async()=>{rechecks++;});
  assert.equal(calls,1);assert.equal(rechecks,3);assert.equal(responses.length,1);
  assert.equal(result.decision.scope,'cross-source');assert.equal(result.fallible,true);
  assert.deepEqual(responses[0].source,source);assert.equal(result.rawResponseSha256,responses[0].rawSha256);
  await assert.rejects(documentAnswerSettings({...policy,scope:'development'}),/source routing policy/);
 }finally{globalThis.fetch=old;}
});

test('source drift retains the raw scope response and stops without retry',async()=>{
 const old=globalThis.fetch;let calls=0,changed=false,retained=0;
 const policy:DocumentAnswerPolicy={scope:'application',model:'gpt-5.4-mini',maxOutputTokens:3000,
  sourceRouting:{mode:'question-scope',beforeAttempt:async()=>{},recordResponse:async()=>{retained++;}}};
 try{globalThis.fetch=async()=>{calls++;changed=true;return new Response(JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',
   usage:{input_tokens:100,output_tokens:20},output_text:JSON.stringify({scope:'named-document',reason:'Fixture.'})}));};
  await assert.rejects(planDocumentQueryScope(question,source,policy,async()=>{if(changed)throw Error('Source changed');}),/Source changed/);
  assert.equal(calls,1);assert.equal(retained,1);
 }finally{globalThis.fetch=old;}
});
