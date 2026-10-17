import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KernelService} from '../lib/kernel/service.ts';
import {prepareDocumentAnswer,documentAnswerSettings,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {checkApplicationDocumentCitations,auditDocumentCitationClaim,DocumentCitationCheckError,type DocumentCitationAuditResponse} from '../lib/kernel/document-citation-audit.ts';
process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='unit-never-sent';process.env.AI_BUDGET_TEST_BYPASS='true';
const question='What is the improvement?';
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,parents:[],images:[],anchors:[
 'Accuracy rises from 66.17% to 66.31%.','Grounding improves by 36.4%.'].map((body,i)=>({id:`pg:v${i}:1`,document_id:`doc${i}`,
 course_id:'course',name:`Original ${i}`,origin:'fixture',origin_key:String(i),source_hash:`hash${i}`,source_version_id:`sv${i}`,
 body,locator:'p1',page_number:1,evidence_id:`e${i}`,parser_version:'fixture',score:1,evidence_body:'full-page'}))};}
const response=(value:unknown)=>Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:30},output_text:JSON.stringify(value)});
const diagnostic=(judgment:string,count:number)=>({claimId:'c0',judgment,reason:'Synthetic orchestration fixture.',
 citationFindings:Object.fromEntries(Array.from({length:count},(_,i)=>[`r${i}`,{judgment:i?'unclear':judgment==='supported'?'supports':'does-not-establish',reason:'Fixture.'}])),
 objectUnitScope:{claim:'quantity',evidence:'cited quantity',alignment:'same'}});
const check=(raw:DocumentCitationAuditResponse[],attempts:string[])=>({mode:'selected-once' as const,
 beforeAttempt:async(id:string)=>{attempts.push(id);},recordResponse:async(r:Readonly<DocumentCitationAuditResponse>)=>{raw.push(r);}});
test('application check needs durable callbacks and does not weaken the administrator entry',async()=>{
 const raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],c=context(),p=prepareDocumentAnswer(question,c);
 const binding={inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,
  providerSelections:{status:'answered' as const,message:'',claims:[{text:'Gain.',citations:[{id:p.quoteUnits[0].id}]}]}};
 await assert.rejects(documentAnswerSettings({scope:'application',citationCheck:{mode:'selected-once'} as any}),/citation check policy/);
 await assert.rejects(documentAnswerSettings({scope:'development',citationCheck:check(raw,attempts)}),/citation check policy/);
 await assert.rejects(checkApplicationDocumentCitations(question,async()=>c,binding,{scope:'application'}),/Explicit application/);
 let reads=0;await assert.rejects(auditDocumentCitationClaim(question,async()=>{reads++;return c;},{...binding,claimIndex:0},
  {scope:'application',...check(raw,attempts)} as any),/development policy/);
 assert.equal(reads,0);assert.equal(raw.length,0);
});
test('Kernel stops at unsupported actual citations without partial answer, uncited rescue or retry',async()=>{
 const kernel=new KernelService(),c=context(),p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[];
 (kernel as any).studyAnswerContextReader=async()=>async()=>c;
 const saved=globalThis.fetch;let calls=0;
 globalThis.fetch=async(_url,init)=>{calls++;const request=JSON.parse(String(init?.body));
  if(calls===1)return response({status:'answered',message:'',claims:[
   {text:'Accuracy improves by 0.14 percentage points.',citations:[{id:p.quoteUnits[1].id}]},
   {text:'Grounding improves by 36.4%.',citations:[{id:p.quoteUnits[1].id}]}]});
  const packet=JSON.parse(request.input[1].content[0].text);assert.equal(packet.references.length,1);
  assert.equal(packet.references[0].quote,c.anchors[1].body);assert.ok(!JSON.stringify(request).includes('66.17'));
  return response(diagnostic('unsupported',1));};
 try{await assert.rejects(kernel.answerStudyContent('owner',question,{},
  {scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts)}),
  (e:unknown)=>e instanceof DocumentCitationCheckError&&e.code==='citation-support-not-established');
  assert.equal(calls,2);assert.equal(raw.length,1);assert.equal(attempts.length,1);assert.equal(raw[0].binding?.originalClaimIndex,0);
 }finally{globalThis.fetch=saved;}
});
test('complementary actual citations can pass once; source drift stops after preserving raw',async()=>{
 for(const drift of [false,true]){const c=context(),p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],saved=globalThis.fetch;
  const binding={inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,
   providerSelections:{status:'answered' as const,message:'',claims:[{text:'Two complementary results.',citations:p.quoteUnits.map(u=>({id:u.id}))}]}};
  let calls=0;globalThis.fetch=async()=>{calls++;if(drift)c.anchors[0].body+=' Changed.';return response(diagnostic('supported',2));};
  try{const work=checkApplicationDocumentCitations(question,async()=>c,binding,{scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts)});
   if(drift)await assert.rejects(work,(e:unknown)=>e instanceof DocumentCitationCheckError&&e.code==='citation-check-incomplete');
   else{const result=await work;assert.equal(result.claimCount,1);assert.equal(result.independentlyVerified,false);}
   assert.equal(calls,1);assert.equal(raw.length,1);assert.equal(attempts.length,1);
  }finally{globalThis.fetch=saved;}
 }
});
