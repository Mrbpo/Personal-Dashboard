import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {KernelService} from '../lib/kernel/service.ts';
import {prepareDocumentAnswer,buildDocumentEvidenceSelectionRequest,buildSelectedDocumentAnswerRequest,
 resolveDocumentAnswerSelections,documentAnswerSettings,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {assertSourceTextCitation,prepareSourceTextCitations} from '../lib/kernel/document-source-text-citation.ts';
import type {DocumentTextSourceManifest} from '../lib/kernel/document-context.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),canonical=(v:unknown)=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)
 ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:2000};
const question='In Scope.pdf, which listed topic is not elaborated?';
function fixture():DocumentAnswerContext{
 const source={documentId:'scope-doc',currentVersionId:'version',sourceVersionId:'sv',sourceHash:sha('immutable original')},
  bodies=['Topics: rivers, forests and deserts.','Rivers flow toward the sea.','Forests contain trees. 😀',''],
  anchors=bodies.map((body,i)=>({id:`pg:version:${i+1}`,document_id:source.documentId,course_id:'',name:'Scope.pdf',origin:'fixture',origin_key:'fixture',
   source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:`page:${i+1}`,page_number:i+1,evidence_id:`node-${i+1}`,
   parser_version:'fixture',score:1,evidence_body:'full-page' as const})),
  unsigned={method:'current-persisted-text-v1' as const,nodeOrder:'persisted-source-order' as const,textCoverage:'all-current-persisted-nodes' as const,
   source,sourceNodeCount:4,returnedNodeCount:4,sourceBodyCodepoints:bodies.reduce((n,b)=>n+Array.from(b).length,0),
   sourceBodyUtf8Bytes:bodies.reduce((n,b)=>n+Buffer.byteLength(b),0),orderedTextSha256:sha(canonical(bodies)),structureManifestSha256:sha('structure'),
   originalFileCompletenessVerified:false as const,visualCompletenessVerified:false as const,parserWarnings:[]};
 const persistedTextProof:DocumentTextSourceManifest={...unsigned,manifestSha256:sha(canonical(unsigned))};
 return {anchors,parents:[],images:[],sourceContentIsUntrusted:true,persistedTextProof};
}
const packet=(r:{input:Array<{content:unknown}>})=>JSON.parse((r.input.at(-1)!.content as {text:string}[])[0].text);
test('source citation is offered only for actually supplied complete text; default and selector wire stay unchanged',()=>{
 const c=fixture(),old=prepareDocumentAnswer(question,c),p=prepareDocumentAnswer(question,{...c,sourceTextCitationPolicy:'current-source-view-v1'}),
  units=p.quoteUnits.filter(u=>u.selectable),ids=units.map(u=>u.id),id=p.sourceTextCitations[0].id;
 assert.deepEqual(old.sourceTextCitations,[]);assert.notEqual(p.fingerprint,old.fingerprint);
 assert.deepEqual(buildDocumentEvidenceSelectionRequest(old,settings),buildDocumentEvidenceSelectionRequest(p,settings));
 const request=buildSelectedDocumentAnswerRequest(p,ids,settings),body=packet(request);
 assert.equal(body.sourceTextCitations[0].id,id);
 assert.deepEqual(body.quoteUnits,packet(buildSelectedDocumentAnswerRequest(old,ids,settings)).quoteUnits);
 assert.ok(request.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum.includes(id));
 const missing=units.filter(u=>u.supportId!==p.supports.find(s=>s.evidenceId==='node-2')!.id).map(u=>u.id),
  partial=buildSelectedDocumentAnswerRequest(p,missing,settings);
 assert.equal(packet(partial).sourceTextCitations,undefined);
 assert.ok(!partial.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum.includes(id));
 assert.throws(()=>resolveDocumentAnswerSelections({status:'answered',message:'',claims:[{text:'Missing.',citations:[{id}]}]},p.supports));
});
test('source citations bind real nodes, reject mutation and never invent a node ID or original quotation',()=>{
 const c={...fixture(),sourceTextCitationPolicy:'current-source-view-v1' as const},p=prepareDocumentAnswer(question,c),scope=p.sourceTextCitations[0],
  result=resolveDocumentAnswerSelections({status:'answered',message:'',claims:[{text:'Deserts are not elaborated in the supplied text.',citations:[{id:scope.id}]}]},p.supports,p.sourceTextCitations),
  selected=result.selectedUnits[0];
 assert.equal(result.answer.claims[0].citations[0].quote,'');assert.equal(selected.kind,'source-text');
 assert.equal('evidenceId' in selected.evidence,false);assert.equal(selected.startUtf16,null);assert.equal(selected.quoteSha256,sha(''));
 assert.deepEqual(scope.view.nodes.map(n=>n.body),c.anchors.map(a=>a.body));
 assert.equal(scope.view.textFaithfulness,'unassessed');assert.equal(scope.view.originalFileCompletenessVerified,false);
 for(const mutate of [(s:typeof scope)=>{s.view.nodes[0].body+='invented';},(s:typeof scope)=>{s.view.source.sourceVersionId='stale';},
  (s:typeof scope)=>{s.id='source-text:'+sha('foreign');}]){const changed=structuredClone(scope);mutate(changed);assert.throws(()=>assertSourceTextCitation(changed));}
 const changed=structuredClone(c);changed.anchors[0].body+='changed';assert.throws(()=>prepareSourceTextCitations(changed));
 assert.deepEqual(prepareSourceTextCitations({...c,persistedTextProof:undefined}),[]);
 const large=fixture();large.anchors[0].body='x'.repeat(32769);
 // A valid oversize proof cannot turn into a hidden truncated source reference.
 const bodies=large.anchors.map(a=>a.body),{manifestSha256:_,...unsigned}=large.persistedTextProof!;
 const updated={...unsigned,sourceBodyCodepoints:bodies.reduce((n,b)=>n+Array.from(b).length,0),sourceBodyUtf8Bytes:bodies.reduce((n,b)=>n+Buffer.byteLength(b),0),orderedTextSha256:sha(canonical(bodies))};
 large.persistedTextProof={...updated,manifestSha256:sha(canonical(updated))};
 assert.deepEqual(prepareSourceTextCitations({...large,sourceTextCitationPolicy:'current-source-view-v1'}),[]);
});
test('source reference needs the ordinary application selector and existing one-shot audit',async()=>{
 for(const policy of [{scope:'development'},{scope:'application',evidenceSelection:'off'},
  {scope:'application',evidenceSelection:'select-then-answer',citationCheck:{mode:'selected-once',beforeAttempt:async()=>{},recordResponse:async()=>{}},scopeAnnotations:'claim-scope-v1'}])
  await assert.rejects(documentAnswerSettings({...policy,sourceTextCitations:'current-source-view-v1'} as never));
});
test('Kernel generation and existing audit receive the same complete view without hidden local-quote expansion',async()=>{
 process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='unit-never-sent';process.env.AI_BUDGET_TEST_BYPASS='true';
 const c=fixture(),kernel=new KernelService(),prepared=prepareDocumentAnswer(question,{...c,sourceTextCitationPolicy:'current-source-view-v1'}),
  scope=prepared.sourceTextCitations[0],ids=prepared.quoteUnits.filter(u=>u.selectable).map(u=>u.id),saved=globalThis.fetch,raw:unknown[]=[],attempts:string[]=[];
 (kernel as unknown as {studyAnswerContextReader:()=>Promise<()=>Promise<DocumentAnswerContext>>}).studyAnswerContextReader=async()=>async()=>c;
 kernel.readDocumentNodes=async()=>{throw Error('A whole-source reference must recheck the full context, not a few nodes');};
 let calls=0;
 globalThis.fetch=async(_url,init)=>{
  const request=JSON.parse(String(init?.body)),input=packet(request);calls++;
  let value:unknown;
  if(calls===1){assert.equal(input.sourceTextCitations,undefined);value={referenceIds:ids};}
  else if(calls===2){assert.equal(input.sourceTextCitations[0].id,scope.id);value={status:'answered',message:'',
   claims:[{text:'Deserts are listed but not elaborated in the supplied document text.',citations:[{id:scope.id}]}]};}
  else{assert.equal(calls,3);assert.deepEqual(input.references[0].view,scope.view);assert.equal(input.references[0].kind,'source-text');
   assert.equal('evidenceId' in input.references[0].source,false);
   value={claimId:'c0',judgment:'supported',reason:'Synthetic orchestration fixture, not content acceptance.',retainedReferenceIds:['r0'],
    citationFindings:{r0:{judgment:'supports',reason:'Entire supplied text.'}},objectUnitScope:{claim:'supplied text',evidence:'supplied text',alignment:'same'}};}
  return Response.json({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:30},output_text:JSON.stringify(value)});
 };
 try{
  const result=await kernel.answerStudyContent('owner',question,{}, {scope:'application',model:'gpt-5.4-mini',evidenceSelection:'select-then-answer',
   sourceTextCitations:'current-source-view-v1',citationCheck:{mode:'selected-once',beforeAttempt:async id=>{attempts.push(id);},recordResponse:async r=>{raw.push(r);}}});
  assert.equal(calls,3);assert.equal(raw.length,1);assert.equal(attempts.length,1);assert.equal(result.answer.status,'answered');
  assert.equal(result.selectedUnits[0].evidence.kind,'source-text');
 }finally{globalThis.fetch=saved;}
});
