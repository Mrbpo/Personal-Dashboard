import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareDocumentAnswerForPolicy,buildDocumentAnswerRuntimeRequest,synthesizeDocumentAnswer,
 type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'source-scoped-'+randomUUID());
process.env.OPENAI_API_KEY='test-never-sent';process.env.AI_MONTHLY_BUDGET='5';
const sha=(s:Uint8Array)=>createHash('sha256').update(s).digest('hex');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
const settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000};
const policy={scope:'application' as const,model:'gpt-5.4-mini' as const,maxOutputTokens:3000,timeoutMs:55000,evidenceSelection:'select-then-answer' as const};
const question='What is the sample count?';
function context(pairImage=false):DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],
 anchors:['Original caption.', 'Implementation without the count. outside-912.', 'Other selected prose. outside-823.'].map((body,index)=>({
  id:`pg:va:${index+1}`,document_id:'a',course_id:'course',name:'Original A',origin:'fixture',origin_key:'a',source_hash:'hash-a',
  source_version_id:'sv-a',body,locator:`original:${index+1}`,page_number:index+1,evidence_id:`evidence-${index}`,
  parser_version:'fixture',score:1,evidence_body:'full-page'})),
 images:[{attachmentId:'image-a',assetId:sha(png),captionEvidenceId:pairImage?'evidence-0':'unselected-caption',sha256:sha(png),byteLength:png.length,
  width:1,height:1,mime:'image/png',bytes:png,source:{documentId:'a',currentVersionId:'va',sourceVersionId:'sv-a',sourceHash:'hash-a'}}]};}
const output=(value:unknown)=>new Response(JSON.stringify({id:'response-fixture',status:'completed',model:'gpt-5.4-mini-2026-03-17',
 usage:{input_tokens:100,output_tokens:20},output_text:JSON.stringify(value)}),{status:200});
const insufficient={status:'insufficient-evidence',message:'This unit does not establish the requested answer.',claims:[]};
const answered=(id:string)=>({status:'answered',message:'',claims:[{text:'The count is two.',citations:[{id}]}]});
const packet=(request:any)=>JSON.parse(request.input.at(-1).content[0].text);
const ids=(request:any):string[]=>request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum;
const originals=(c:DocumentAnswerContext)=>prepareDocumentAnswerForPolicy(question,c,policy);

test('source-scoped: unique full answer retains every claim and actual visual unit without outside prose',async()=>{
 const c=context(true),p=originals(c),selected=[p.quoteUnits[1].id,'i0',p.quoteUnits[2].id],requests:any[]=[],saved=globalThis.fetch;
 const winner={...answered('i0'),claims:[...answered('i0').claims,{text:'The sample is current.',citations:[{id:'i0'}]}]};
 try{globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));requests.push(request);
  return output(requests.length===1?{referenceIds:selected}:ids(request)[0]==='i0'?winner:insufficient);};
  const result=await synthesizeDocumentAnswer(question,async()=>c,policy);
  assert.equal(requests.length,4);assert.ok('sourceScopedGeneration' in result);
  assert.equal(result.sourceScopedGeneration?.mode,'unique-unit-answer');assert.deepEqual(result.providerSelections,winner);
  assert.deepEqual(result.selectedUnits.map(unit=>unit.selectionId),['i0','i0']);
  assert.deepEqual(requests.slice(1).map(ids),selected.map(id=>[id]));
  for(const request of requests.slice(1)){assert.equal(packet(request).question,question);
   assert.equal(request.input[0].content,buildDocumentAnswerRuntimeRequest(p,settings,policy).input[0].content);}
  const visual=requests[2].input.at(-1).content;
  assert.equal(visual.filter((item:any)=>item.type==='input_image').length,1);assert.match(JSON.stringify(visual),/Original caption/);
  assert.doesNotMatch(JSON.stringify(visual),/outside-912|outside-823/);
  assert.deepEqual(result.sourceScopedGeneration?.attempts.map(a=>a.answerStatus),['insufficient-evidence','answered','insufficient-evidence']);
  assert.equal(result.sourceScopedGeneration?.attempts.reduce((sum,a)=>sum+(a.usage as {input_tokens:number}).input_tokens,0),300);
  assert.ok(result.sourceScopedGeneration?.attempts.every(a=>a.state==='completed'&&a.providerRequestSha256.length===64));
 }finally{globalThis.fetch=saved;}
});

test('source-scoped: zero or multiple answers use one untouched joint generation',async()=>{
 const saved=globalThis.fetch;
 try{for(const statuses of [[false,false],[true,true]]){
  const c=context(),p=originals(c),selected=p.quoteUnits.slice(0,2).map(u=>u.id),requests:any[]=[];
  const joint={status:'answered',message:'',claims:[{text:'The combined original evidence answers the question.',citations:selected.map(id=>({id}))}]};
  globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));requests.push(request);
   if(requests.length===1)return output({referenceIds:selected});
   if(requests.length===4)return output(joint);
   return output(statuses[requests.length-2]?answered(ids(request)[0]):insufficient);};
  const result=await synthesizeDocumentAnswer(question,async()=>c,policy);
  assert.equal(requests.length,4);assert.ok('sourceScopedGeneration' in result);assert.equal(result.sourceScopedGeneration?.mode,'joint-fallback');
  assert.deepEqual(result.providerSelections,joint);assert.deepEqual(ids(requests[3]),selected);
  assert.deepEqual(packet(requests[3]).quoteUnits.map((u:any)=>u.text),p.quoteUnits.slice(0,2).map(u=>u.text));
  assert.doesNotMatch(JSON.stringify(requests[3].input),/The count is two|This unit does not establish/);
  assert.deepEqual(result.sourceScopedGeneration?.attempts.map(a=>a.kind),['unit-probe','unit-probe','joint-fallback']);
 }}finally{globalThis.fetch=saved;}
});

test('source-scoped: single, more than three, cross-document and single-pass requests remain joint',async()=>{
 const saved=globalThis.fetch;
 try{for(const variant of ['single','many','cross-document','single-pass']){
  const c=context();if(variant==='cross-document')Object.assign(c.anchors[1],{id:'pg:vb:2',document_id:'b',source_hash:'hash-b',source_version_id:'sv-b'});
  const p=originals(c),selected=variant==='many'?[...p.quoteUnits.map(u=>u.id),'i0']:p.quoteUnits.slice(0,variant==='single'?1:2).map(u=>u.id),requests:any[]=[];
  globalThis.fetch=async(_url,init)=>{const request=JSON.parse(String(init?.body));requests.push(request);
   return output(variant!=='single-pass'&&requests.length===1?{referenceIds:selected}:answered(selected[0]));};
  const {evidenceSelection,...singlePass}=policy,result=await synthesizeDocumentAnswer(question,async()=>c,variant==='single-pass'?singlePass:policy);
  assert.equal(requests.length,variant==='single-pass'?1:2);assert.equal('sourceScopedGeneration' in result,false);
  if(variant!=='single-pass')assert.deepEqual(ids(requests[1]),selected);
 }}finally{globalThis.fetch=saved;}
});

test('source-scoped: invalid conflict, citation escape, source drift and shared deadline stop without another generation',async()=>{
 const saved=globalThis.fetch,realNow=Date.now;
 try{for(const failure of ['conflict','escape','source-change','deadline']){
  const c=context(),p=originals(c),selected=p.quoteUnits.slice(0,2).map(u=>u.id);let calls=0,clock=realNow();Date.now=()=>clock;
  globalThis.fetch=async()=>{calls++;if(calls===1)return output({referenceIds:selected});
   if(failure==='source-change')c.anchors[0].body+=' Source changed.';
   if(failure==='deadline')clock+=55001;
   if(failure==='conflict')return output({status:'conflicting-evidence',message:'',claims:[...answered(selected[0]).claims,...answered(selected[0]).claims]});
   return output(answered(failure==='escape'?selected[1]:selected[0]));};
  await assert.rejects(synthesizeDocumentAnswer(question,async()=>c,policy),(error:any)=>{
   assert.equal(error.sourceScopedGeneration?.mode,'stopped');assert.equal(error.sourceScopedGeneration?.attempts.length,1);return true;});
  assert.equal(calls,2,'never continue other probes or joint generation after failure');Date.now=realNow;
 }}finally{globalThis.fetch=saved;Date.now=realNow;}
});
