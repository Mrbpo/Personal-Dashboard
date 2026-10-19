import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pdfVisualCanonical} from '../lib/kernel/pdf-visual-evidence.ts';
import {PDF_NAVIGATION_TEXT_POLICY} from '../lib/kernel/pdf-navigation-text.ts';
import {PDF_NAVIGATION_PROJECTION_POLICY,assertPdfNavigationContext,projectPdfNavigationRequest,pdfNavigationProjectionEnabled,
 withPdfNavigationContext,type PdfNavigationPage,type PdfNavigationContext} from '../lib/kernel/pdf-navigation-projection.ts';
import {prepareDocumentAnswer,synthesizeDocumentAnswer,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'navigation-test-'+randomUUID());
process.env.OPENAI_API_KEY='test-never-sent';process.env.AI_MONTHLY_BUDGET='5';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const body='Method [7] is compared. Named network [7] is described.';
const source={documentId:'doc',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:sha('original')};
function signed(value:Omit<PdfNavigationPage,'observationSha256'>):PdfNavigationPage{
 return {...value,observationSha256:sha(pdfVisualCanonical(value))};
}
function fixture(){
 const page=signed({policy:PDF_NAVIGATION_TEXT_POLICY,status:'available',source,physicalPage:1,pageEvidenceId:'evidence',
  pageBodySha256:sha(body),parserVersion:'fixture',visualManifestSha256:sha('manifest'),result:{} as PdfNavigationPage['result'],
  compatibleOriginalFrame:true,omittedLinks:0,sourceBindingVerified:true,textFaithfulnessVerified:false,sourceContentIsUntrusted:true,
  wordLevelLinkPositionVerified:false,semanticRelationsVerified:false,
  observations:[{status:'candidate',wordLevelLinkPositionVerified:false,semanticRelationsVerified:false,
   link:{sourcePageNumber:1,annotationIndex:0,annotationReference:'10 0 R',sourceRect:[10,10,20,20],coordinateSpace:'original-pdf-default-user-space',
    destinationName:'cite.native',target:{status:'resolved-page',physicalPageNumber:3,view:'XYZ',parameters:[1,2,null]}},
   container:{nodeReference:'#/texts/0',bbox:{l:0,b:0,r:100,t:100,coord_origin:'BOTTOMLEFT'},startUtf16:0,endUtf16:body.length,textSha256:sha(body)}}]});
 const context:PdfNavigationContext={policy:PDF_NAVIGATION_PROJECTION_POLICY,pages:[page],omittedPages:0,unavailablePages:0};
 const support={id:'e0',kind:'text' as const,documentId:source.documentId,documentVersionId:source.currentVersionId,
  sourceVersionId:source.sourceVersionId,sourceHash:source.sourceHash,evidenceId:'evidence',sha256:sha(body),text:body};
 const units=[{id:'q:one',supportId:'e0',startUtf16:0,endUtf16:23,text:body.slice(0,23),quoteSha256:sha(body.slice(0,23))},
  {id:'q:two',supportId:'e0',startUtf16:23,endUtf16:body.length,text:body.slice(23),quoteSha256:sha(body.slice(23))}];
 const request={model:'same-model',input:[{role:'user',content:[{type:'input_text',text:JSON.stringify({question:'Which method?',quoteUnits:units})}]}],
  text:{format:{schema:{enum:['q:one','q:two']}}}};
 return {page,context,support,units,request};
}
function answerContext():DocumentAnswerContext{
 return {sourceContentIsUntrusted:true,parents:[],images:[],anchors:[{id:'pg:version:1',document_id:'doc',course_id:'course',name:'Original',origin:'fixture',
  origin_key:'original',source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:'original:1',page_number:1,
  evidence_id:'evidence',parser_version:'fixture',score:1,evidence_body:'full-page'}]};
}

test('off returns identical request; selected union projects intersections without changing schema or evidence',()=>{
 const f=fixture(),before=JSON.stringify(f);
 assert.equal(projectPdfNavigationRequest(f.request,undefined,[f.support],f.units,['q:one']).request,f.request);
 const result=projectPdfNavigationRequest(f.request,f.context,[f.support],f.units,['q:one','q:two']);
 assert.equal(result.receipt?.applied,true);assert.equal(result.receipt?.groups,1);
 const packet=JSON.parse(result.request.input[0].content[0].text),wire=packet.sourceNavigationContainers;
 assert.equal(wire.semantics,'navigation-only');assert.equal(wire.semanticRelationsVerified,false);
 assert.deepEqual(packet.quoteUnits,f.units);assert.deepEqual(result.request.text,f.request.text);
 assert.deepEqual(wire.groups[0].containers[0].members.map((m:any)=>m.intersection),[{startUtf16:0,endUtf16:23},{startUtf16:23,endUtf16:body.length}]);
 assert.equal(JSON.stringify(f),before,'no source, selected unit or original request mutation');
});

test('gaps and incomplete selection omit navigation; foreign IDs, stale source, bad span and tampered hash reject',()=>{
 const f=fixture();
 assert.equal(projectPdfNavigationRequest(f.request,f.context,[f.support],f.units,['q:one']).receipt?.applied,false);
 const gap=structuredClone(f.units);gap[1].startUtf16++;gap[1].text=body.slice(gap[1].startUtf16);gap[1].quoteSha256=sha(gap[1].text);
 assert.equal(projectPdfNavigationRequest(f.request,f.context,[f.support],gap,['q:one','q:two']).receipt?.notCovered,1);
 assert.throws(()=>projectPdfNavigationRequest(f.request,f.context,[f.support],f.units,['q:foreign']),/selected reference/);
 assert.throws(()=>projectPdfNavigationRequest(f.request,f.context,[f.support],f.units,['q:one','q:one']),/selected reference/);
 const stale=structuredClone(f.page);stale.source.currentVersionId='old';const {observationSha256:_,...raw}=stale;
 assert.throws(()=>assertPdfNavigationContext({...f.context,pages:[signed(raw)]},[f.support]),/source\/body/);
 const tampered=structuredClone(f.context);tampered.pages[0].pageBodySha256=sha('other');
 assert.throws(()=>assertPdfNavigationContext(tampered,[f.support]),/source observation/);
 const bad=structuredClone(f.units);bad[0].text='invented';
 assert.throws(()=>projectPdfNavigationRequest(f.request,f.context,[f.support],bad,['q:one']),/quote text differs/);
});

test('only actual selected overlaps become members, excluding text beyond a container',()=>{
 const f=fixture(),raw=structuredClone(f.page);if(raw.observations[0].status!=='candidate')throw Error('fixture');
 raw.observations[0].container.endUtf16=body.length-5;raw.observations[0].container.textSha256=sha(body.slice(0,-5));
 const {observationSha256:_,...value}=raw;
 const out=projectPdfNavigationRequest(f.request,{...f.context,pages:[signed(value)]},[f.support],f.units,['q:one','q:two']);
 const member=JSON.parse(out.request.input[0].content[0].text).sourceNavigationContainers.groups[0].containers[0].members[1];
 assert.equal(member.intersection.endUtf16,body.length-5);assert.equal(member.quoteSha256,f.units[1].quoteSha256);
});

test('Kernel wrapper caches only exact current pages; unavailable observations retain original evidence and bounds',async()=>{
 const f=fixture(),c=answerContext();let calls=0;
 const read=withPdfNavigationContext(async()=>c,async()=>{calls++;return f.page;});
 const first=await read();await read();assert.equal(calls,1);assert.equal(first.anchors,c.anchors);assert.equal(first.pdfNavigation.pages.length,1);
 c.anchors[0].body+='changed';await assert.rejects(read,/anchor binding differs/);assert.equal(calls,2);
 const many=answerContext();many.anchors=Array.from({length:18},(_,i)=>({...many.anchors[0],id:`pg:version:${i+1}`,page_number:i+1}));calls=0;
 const bounded=withPdfNavigationContext(async()=>many,async(s,p)=>{calls++;return {policy:PDF_NAVIGATION_TEXT_POLICY,status:'unavailable',source:s,
  physicalPage:p,reason:'native-navigation-not-recorded',semanticRelationsVerified:false};});
 const out=await bounded();assert.equal(calls,16);assert.equal(out.pdfNavigation.omittedPages,2);assert.equal(out.pdfNavigation.unavailablePages,16);
 assert.equal(pdfNavigationProjectionEnabled('off'),false);assert.equal(pdfNavigationProjectionEnabled(PDF_NAVIGATION_PROJECTION_POLICY),true);
 assert.throws(()=>pdfNavigationProjectionEnabled('typo'),/STUDY_PDF_NAVIGATION/);
});

test('prepared fingerprint binds observations, empty context preserves baseline',()=>{
 const c=answerContext(),f=fixture(),before=prepareDocumentAnswer('Which method?',c);
 assert.notEqual(prepareDocumentAnswer('Which method?',{...c,pdfNavigation:f.context}).fingerprint,before.fingerprint);
 assert.equal(prepareDocumentAnswer('Which method?',{...c,pdfNavigation:{...f.context,pages:[]}}).fingerprint,before.fingerprint);
});

test('already retrieved parent pages receive navigation even when not initial ranked anchors',async()=>{
 const f=fixture(),c=answerContext();c.anchors=[];
 c.parents=[{parentId:'expanded-page',status:'available',sourceNodeCount:1,sourceBodyCodepoints:body.length,nodes:[{
  documentId:source.documentId,documentVersionId:source.currentVersionId,sourceVersionId:source.sourceVersionId,sourceHash:source.sourceHash,
  evidenceId:'evidence',locator:'original:1',ordinal:0,kind:'page',body,bodySha256:sha(body)}]}];
 const calls:number[]=[];
 const read=withPdfNavigationContext(async()=>c,async(_source,page)=>{calls.push(page);return f.page;});
 const context=await read();assert.deepEqual(calls,[1]);assert.equal(context.pdfNavigation.pages.length,1);
 assert.doesNotThrow(()=>prepareDocumentAnswer('Which method?',context));
});

test('large native annotation sets keep bounded wire and explicit omissions',()=>{
 const f=fixture(),{observationSha256:_,...raw}=f.page,first=raw.observations[0];
 raw.observations=Array.from({length:128},(_,i)=>({...structuredClone(first),link:{...structuredClone(first.link),annotationIndex:i,destinationName:'cite.'+i}}));
 const result=projectPdfNavigationRequest(f.request,{...f.context,pages:[signed(raw)]},[f.support],f.units,['q:one','q:two']);
 const groups=JSON.parse(result.request.input[0].content[0].text).sourceNavigationContainers.groups;
 assert.ok(groups.length<=32);assert.ok(Buffer.byteLength(JSON.stringify(groups))<=30000);assert.ok(result.receipt!.omitted>0);
});

test('ordinary and typed fallback actual synthesis transports navigation only to generation, with no new model phase',async()=>{
 const f=fixture(),c={...answerContext(),pdfNavigation:f.context},question='Which method?',prepared=prepareDocumentAnswer(question,c),
  ids=prepared.quoteUnits.filter(u=>u.selectable).map(u=>u.id),saved=globalThis.fetch;
 const output=(value:unknown)=>new Response(JSON.stringify({status:'completed',model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:20},
  output_text:JSON.stringify(value)}),{status:200});
 try{
  for(const typed of [false,true]){
   let calls=0;
   globalThis.fetch=async(_url,init)=>{
    const req=JSON.parse(String(init?.body));calls++;
    if(calls===1){assert.doesNotMatch(JSON.stringify(req),/sourceNavigationContainers/);return output({referenceIds:ids});}
    const packet=JSON.parse(req.input.at(-1).content[0].text),members=packet.sourceNavigationContainers.groups[0].containers[0].members;
    assert.ok(members.every((m:any)=>ids.includes(m.id)));
    assert.deepEqual(req.text.format.schema.properties.claims.items.properties.citations.items.properties.id.enum,ids);
    return output({status:'answered',message:'',claims:[{text:'The source compares a method.',citations:[{id:ids[0]}]}]});
   };
   const result=await synthesizeDocumentAnswer(question,async()=>c,{scope:'application',model:'gpt-5.4-mini',maxOutputTokens:3000,
    evidenceSelection:'select-then-answer',citationCheck:{mode:'selected-once',beforeAttempt:async()=>{},recordResponse:async()=>{}},
    ...(typed?{sourceValueContract:'cell-bindings-v2',recordSourceValueRawResponse:async()=>{},recordSourceValueDerivation:async()=>{}}:{})});
   assert.equal(calls,2);assert.ok('sourceNavigation' in result);assert.equal(result.sourceNavigation?.applied,true);
  }
 }finally{globalThis.fetch=saved;}
});
