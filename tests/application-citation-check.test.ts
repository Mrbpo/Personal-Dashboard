import {test} from 'node:test';
import assert from 'node:assert/strict';
import {KernelService} from '../lib/kernel/service.ts';
import {prepareDocumentAnswer,documentAnswerSettings,type DocumentAnswerContext,type DocumentAnswerPolicy} from '../lib/kernel/document-answer.ts';
import {checkApplicationDocumentCitations,auditDocumentCitationClaim,DocumentCitationCheckError,type DocumentCitationAuditResponse,type DocumentCitationTextRecheck,type DocumentCitationAuditPolicy} from '../lib/kernel/document-citation-audit.ts';
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
function currentNodes(kernel:KernelService,c:DocumentAnswerContext){
 kernel.readDocumentNodes=async(owner,source,ids)=>{
  assert.equal(owner,'owner');const nodes=c.anchors.filter(n=>ids.includes(n.evidence_id));assert.equal(nodes.length,ids.length);
  for(const n of nodes)assert.deepEqual([n.document_id,n.source_version_id,n.source_hash,n.id],
   [source.documentId,source.sourceVersionId,source.sourceHash,`pg:${source.currentVersionId}:${n.page_number}`]);
  return nodes.map(({score,...n})=>{void score;return {...n,reader_selection:'evidence-node-ids',retrieval_mode:'reader-selection',evidence_body:'full-page'};}) as Awaited<ReturnType<KernelService['readDocumentNodes']>>;
 };
}
function contextReader(kernel:KernelService,c:DocumentAnswerContext){
 (kernel as unknown as {studyAnswerContextReader:()=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async()=>async()=>c;
}
test('application check needs durable callbacks and does not weaken the administrator entry',async()=>{
 const raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],c=context(),p=prepareDocumentAnswer(question,c);
 const binding={inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,
  providerSelections:{status:'answered' as const,message:'',claims:[{text:'Gain.',citations:[{id:p.quoteUnits[0].id}]}]}};
 await assert.rejects(documentAnswerSettings({scope:'application',citationCheck:{mode:'selected-once'} as unknown as NonNullable<DocumentAnswerPolicy['citationCheck']>}),/citation check policy/);
 await assert.rejects(documentAnswerSettings({scope:'development',citationCheck:check(raw,attempts)}),/citation check policy/);
 await assert.rejects(checkApplicationDocumentCitations(question,async()=>c,binding,{scope:'application'}),/Explicit application/);
 let reads=0;await assert.rejects(auditDocumentCitationClaim(question,async()=>{reads++;return c;},{...binding,claimIndex:0},
  {scope:'application',...check(raw,attempts)} as unknown as DocumentCitationAuditPolicy),/development policy/);
 assert.equal(reads,0);assert.equal(raw.length,0);
});
test('Kernel stops at unsupported actual citations without partial answer, uncited rescue or retry',async()=>{
 const kernel=new KernelService(),c=context(),p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[];
 currentNodes(kernel,c);
 contextReader(kernel,c);
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

test('ordinary application checks retain discourse without requiring generated literal annotations or borrowing references',async()=>{
 const c=context(),p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],saved=globalThis.fetch;
 const selections={status:'answered' as const,message:'',claims:[
  {text:'The first result concerns accuracy.',citations:[{id:p.quoteUnits[0].id}]},
  {text:'That is distinct from the grounding result.',citations:[{id:p.quoteUnits[1].id}]}]};
 const binding={inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,providerSelections:selections};
 let calls=0;globalThis.fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body)),packet=JSON.parse(request.input[1].content[0].text),index=calls++;
  assert.equal(packet.answerTextContext.targetOriginalIndex,index);assert.equal(packet.answerTextContext.isSourceEvidence,false);
  assert.deepEqual(packet.answerTextContext.claims,selections.claims.map((claim,originalIndex)=>({originalIndex,text:claim.text})));
  assert.equal(packet.claim.text,selections.claims[index].text);assert.equal(packet.references.length,1);
  assert.equal(packet.references[0].source.documentId,c.anchors[index].document_id);
  assert.equal(packet.references[0].quote,c.anchors[index].body);
  assert.equal(request.input[1].content.some((part:{type:string})=>part.type==='input_image'),false);
  return response(diagnostic('supported',1));
 };
 try{
  const result=await checkApplicationDocumentCitations(question,async()=>c,binding,
   {scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts)});
  assert.equal(calls,2);assert.equal(result.claimCount,2);assert.equal(raw.length,2);
  assert.ok(raw.every(r=>r.binding?.answerTextContextSha256));
  assert.deepEqual(binding.providerSelections,selections);
 }finally{globalThis.fetch=saved;}
});

test('application discourse rejects an invalid explicit mode before model work',async()=>{
 const c=context(),p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[];
 await assert.rejects(checkApplicationDocumentCitations(question,async()=>c,{inputFingerprint:p.fingerprint,
  quoteUnitManifestSha256:p.quoteUnitManifestSha256,providerSelections:{status:'answered',message:'',claims:[]},
  answerTextContext:'other' as 'bound-answer-v1'},
  {scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts)}),/Invalid application discourse/);
 assert.deepEqual(attempts,[]);assert.deepEqual(raw,[]);
});

test('opt-in explicit quantity mismatch preserves generation evidence and refuses before citation calls; off keeps the existing path',async()=>{
 for(const enabled of [false,true]){
  const kernel=new KernelService(),q='How long did training take?',c=context();c.anchors[0].body='Each model was trained for 100 epochs.';
  currentNodes(kernel,c);
  const prepared=prepareDocumentAnswer(q,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],saved=globalThis.fetch;
  contextReader(kernel,c);
  let calls=0;globalThis.fetch=async()=>{calls++;return calls===1?response({status:'answered',message:'',claims:[
   {text:'Each model was trained for 100 epochs.',citations:[{id:prepared.quoteUnits[0].id}]}]}):response(diagnostic('supported',1));};
  try{const result=await kernel.answerStudyContent('owner',q,{},
   {scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts),...(enabled?{quantityConsistency:'explicit-unit-v1' as const}:{})});
   if(enabled){assert.equal(result.answer.status,'insufficient-evidence');assert.deepEqual(result.selectedUnits,[]);
    assert.equal(calls,1);assert.equal(raw.length,0);assert.equal(attempts.length,0);
    assert.ok('quantityConsistency' in result);const receipt=result.quantityConsistency;
    assert.equal(receipt?.status,'explicit-incompatible-quantity');assert.equal(receipt?.originalAnswer?.claims[0].text,'Each model was trained for 100 epochs.');
    assert.equal(receipt?.originalSelectedUnits?.length,1);assert.equal(receipt?.inputFingerprint,result.inputFingerprint);
   }else{assert.equal(result.answer.status,'answered');assert.equal(calls,2);assert.equal(raw.length,1);assert.equal('quantityConsistency' in result,false);}
  }finally{globalThis.fetch=saved;}
 }
});

test('release withholds only an individually rejected citation, keeping claims, unclear evidence and other claims citing that source',async()=>{
 const kernel=new KernelService(),c=context();c.anchors.push({...c.anchors[0],id:'pg:v2:1',document_id:'doc2',evidence_id:'e2',
  source_version_id:'sv2',source_hash:'hash2',body:'Additional potentially complementary context.'});
 currentNodes(kernel,c);
 const p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],saved=globalThis.fetch;
 contextReader(kernel,c);
 const selections={status:'answered',message:'',claims:[{text:'A combined result.',citations:p.quoteUnits.map(u=>({id:u.id}))},
  {text:'Grounding improves by 36.4%.',citations:[{id:p.quoteUnits[1].id}]}]},original=JSON.stringify(selections);
 let calls=0;globalThis.fetch=async()=>{calls++;if(calls===1)return response(selections);
  const d=diagnostic('supported',calls===2?3:1);if(calls===2)d.citationFindings.r1.judgment='does-not-establish';return response(d);};
 try{
  const result=await kernel.answerStudyContent('owner',question,{}, {scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts)});
  assert.equal(calls,3,'One generation and the same two original-claim audits, without repair calls');
  assert.equal(JSON.stringify(result.providerSelections),original,'The original provider selection history remains intact');
  assert.deepEqual(result.answer.claims.map(c=>c.text),selections.claims.map(c=>c.text));
  assert.deepEqual(result.selectedUnits.map(u=>[u.claimIndex,u.citationIndex,u.selectionId]),[
   [0,0,p.quoteUnits[0].id],[0,1,p.quoteUnits[2].id],[1,0,p.quoteUnits[1].id]]);
  const release=result.citationCheck?.citationRelease;assert.ok(release);assert.equal(release.claimsUnchanged,true);
  assert.equal(release.semanticVerified,false);assert.equal(release.removed.length,1);
  assert.equal(release.removed[0].selectionId,p.quoteUnits[1].id);assert.equal(release.removed[0].claimIndex,0);
  assert.equal(release.removed[0].auditBindingSha256,result.citationCheck?.audits[0].bindingSha256);
  assert.equal(result.citationCheck?.audits[0].binding.citations.length,3,'Original joint evidence is still audited and retained');
  assert.equal('released'in result.citationCheck!,false,'Do not duplicate a derived answer in public audit metadata');
 }finally{globalThis.fetch=saved;}
});

test('all-rejected and contradictory references cannot be rescued by citation withholding; release also rechecks current source',async()=>{
 for(const mode of ['all-rejected','contradiction','drift']as const){
  const c=context(),p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],saved=globalThis.fetch;
  const binding={inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,
   providerSelections:{status:'answered' as const,message:'',claims:[{text:'A supported result.',citations:p.quoteUnits.map(u=>({id:u.id}))}]}};
  let calls=0,reads=0;globalThis.fetch=async()=>{calls++;const d=diagnostic('supported',2);
   d.citationFindings.r1.judgment='does-not-establish';
   if(mode==='all-rejected')d.citationFindings.r0.judgment='does-not-establish';
   if(mode==='contradiction')d.citationFindings.r0.judgment='contradicts';
   return response(d);};
  try{await assert.rejects(checkApplicationDocumentCitations(question,async()=>{reads++;if(mode==='drift'&&reads===4)c.anchors[0].body+=' changed';return c;},
   binding,{scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts)}),
   (e:unknown)=>e instanceof DocumentCitationCheckError&&e.code===(mode==='all-rejected'?'citation-support-not-established':'citation-check-incomplete'));
   assert.equal(calls,1);assert.equal(raw.length,1);
  }finally{globalThis.fetch=saved;}
 }
});

test('focused current-node checks retain per-call and final whole-context validation without changing audit requests',async()=>{
 const saved=globalThis.fetch;
 try{
  for(const mode of ['valid','body','title','version','unrelated-final'] as const){
   const c=context(),kernel=new KernelService();currentNodes(kernel,c);
   const recheck=(kernel as unknown as {citationTextRecheck:(owner:string)=>DocumentCitationTextRecheck}).citationTextRecheck('owner');
   const p=prepareDocumentAnswer(question,c),raw:DocumentCitationAuditResponse[]=[],attempts:string[]=[],requests:unknown[]=[];
   let fullReads=0,nodeReads=0;const originalNodes=kernel.readDocumentNodes;
   kernel.readDocumentNodes=async(...args)=>{nodeReads++;
    const nodes=await originalNodes(...args);
    if(mode==='body')nodes[0]={...nodes[0],body:nodes[0].body+' changed'};
    if(mode==='title')nodes[0]={...nodes[0],name:'Other document'};
    if(mode==='version')throw new Error('Current node version changed');
    return nodes;
   };
   const binding={inputFingerprint:p.fingerprint,quoteUnitManifestSha256:p.quoteUnitManifestSha256,
    providerSelections:{status:'answered' as const,message:'',claims:[0,1].map(()=>({text:'Accuracy gain.',citations:[{id:p.quoteUnits[0].id}]}))}};
   globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));
    if(mode==='unrelated-final'&&requests.length===2)c.anchors[1].body+=' changed after final model response';
    return response(diagnostic('supported',1));
   };
   const work=checkApplicationDocumentCitations(question,async()=>{fullReads++;return c;},binding,
    {scope:'application',model:'gpt-5.4-mini',citationCheck:check(raw,attempts)},recheck);
   if(mode==='valid'){
    const result=await work;assert.equal(result.claimCount,2);assert.equal(requests.length,2);
    assert.equal(fullReads,2,'initial and final whole-context reads');assert.equal(nodeReads,4,'before and after each model call');
    assert.equal(raw.length,2);assert.equal(attempts.length,2);
   }else{
    await assert.rejects(work,(error:unknown)=>error instanceof DocumentCitationCheckError&&error.code==='citation-check-incomplete');
    assert.equal(requests.length,mode==='unrelated-final'?2:0,'changed original text/title/version cannot reach a model; unrelated final drift cannot release an answer');
   }
  }
 }finally{globalThis.fetch=saved;}
});
