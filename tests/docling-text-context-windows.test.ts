import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {prepareDoclingTextContextWindows,assertPreparedDoclingTextContextWindows,
 type DoclingTextContextWindowsInput} from '../lib/kernel/docling-source-regions.ts';
import {prepareDocumentAnswer,resolveDocumentAnswerSelections,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';

const temporaryRoot=resolve(tmpdir()),directory=await mkdtemp(join(temporaryRoot,'study-docling-text-context-'));
const previousLibrary=process.env.LIBRARY_DIR;process.env.LIBRARY_DIR=directory;
after(async()=>{
 if(previousLibrary===undefined)delete process.env.LIBRARY_DIR;else process.env.LIBRARY_DIR=previousLibrary;
 assert.equal(dirname(directory),temporaryRoot);assert.ok(directory.startsWith(join(temporaryRoot,'study-docling-text-context-')));
 await rm(directory,{recursive:true,force:true});
});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const ref=(reference:string)=>({$ref:reference});
const text=(value:string,extra:Record<string,unknown>={})=>({label:'text',parent:ref('#/body'),children:[],text:value,orig:value,
 prov:[{page_no:1}],...extra});
function document(texts:Record<string,unknown>[],children=texts.map((_,i)=>ref('#/texts/'+i)),extra:Record<string,unknown>={}){
 return {pages:{1:{page_no:1,size:{width:600,height:800}}},body:{children},texts,pictures:[],tables:[],...extra};
}
async function saved(doc:Record<string,unknown>,body:string):Promise<DoclingTextContextWindowsInput>{
 const identity={owner:'window-owner',documentId:'window-document',sourceHash:hash('source'),totalPages:2,
  inputHash:hash('derived'),optionsHash:hash('options'),copyIndices:[1],start:2,end:2};
 const bytes=JSON.stringify({identity,result:{status:'success',document:{json_content:doc}}}),resultBlobSha256=hash(bytes);
 await writeFile(join(directory,resultBlobSha256),bytes);
 return {owner:identity.owner,documentId:identity.documentId,currentVersionId:'current-version',sourceVersionId:'source-version',
  sourceHash:identity.sourceHash,pageCount:2,physicalPage:2,evidenceId:'page-evidence',parserVersion:'docling-text-fixture',body,progress:null,
  layout:{status:'unavailable',regions:[],pageSizes:[],resultReferences:[{resultBlobSha256,derivedInputSha256:identity.inputHash,copyIndices:[1]}]}};
}

test('literal adjacent root text windows retain unknown geometry and exact current source binding',async()=>{
 const left='For the high-resource dataset, both regularizers',right='performed below the baseline.',axis='axis ticks';
 const doc=document([text(left),text(right),text(axis,{parent:ref('#/pictures/0')})],
  [ref('#/pictures/0'),ref('#/texts/0'),ref('#/texts/1')],
  {pictures:[{parent:ref('#/body'),children:[ref('#/texts/2')],prov:[{page_no:1}]}]});
 const body=axis+'\n\n'+left+'\n\n'+right,input=await saved(doc,body),before=JSON.stringify(input);
 const prepared=await prepareDoclingTextContextWindows(input);assert.ok(prepared);
 assert.equal(prepared.windows.length,1);const window=prepared.windows[0];
 assert.equal(body.slice(window.startUtf16,window.endUtf16),left+'\n\n'+right);
 assert.equal(window.quoteSha256,hash(left+'\n\n'+right));
 assert.deepEqual(window.references.map(n=>n.reference),['#/texts/0','#/texts/1']);
 assert.deepEqual(window.references.map(n=>n.ordinal),[2,3]);
 assert.deepEqual(window.references.map(n=>n.geometry),[
  {status:'unknown',reason:'bbox-unavailable'},{status:'unknown',reason:'bbox-unavailable'}]);
 assert.deepEqual(window.references.map(n=>n.physicalPageNumbers),[[2],[2]]);
 assert.equal(prepared.derivedPage,1);assert.deepEqual(prepared.result.copyIndices,[1]);
 assert.equal(prepared.result.optionsHash,hash('options'));assert.equal(prepared.binding.bodySha256,hash(body));
 assert.equal(prepared.binding.currentVersionId,input.currentVersionId);assert.equal(prepared.binding.evidenceId,input.evidenceId);
 assert.equal(prepared.semanticRelationsVerified,false);assert.equal(window.semanticRelationsVerified,false);
 assert.equal(prepared.readingOrderVerified,false);assert.equal(prepared.textFaithfulnessVerified,false);
 assert.equal(prepared.visibilityVerified,false);assert.ok(Object.isFrozen(window.references[0].raw));
 assertPreparedDoclingTextContextWindows(prepared,prepared.binding);assert.equal(JSON.stringify(input),before);
});

test('picture/table descendants and heading/formula items never become adjacent body text windows',async()=>{
 const values=['Root passage','Picture child','Table child','Heading','x squared','Last passage'];
 const doc=document(values.map((v,i)=>text(v,i===1?{parent:ref('#/pictures/0')}:i===2?{parent:ref('#/tables/0')}:
  i===3?{label:'section_header'}:i===4?{label:'formula'}:{})),
  [ref('#/texts/0'),ref('#/pictures/0'),ref('#/tables/0'),ref('#/texts/3'),ref('#/texts/4'),ref('#/texts/5')],
  {pictures:[{children:[ref('#/texts/1')],prov:[{page_no:1}]}],
   tables:[{prov:[{page_no:1}],data:{table_cells:[{ref:ref('#/texts/2')}]}}]});
 const prepared=await prepareDoclingTextContextWindows(await saved(doc,values.join('\n\n')));assert.ok(prepared);
 assert.deepEqual(prepared.windows,[]);
});

test('literal non-whitespace gaps and reordered body matches cannot be joined',async()=>{
 const left='First experimental object',right='Second experimental object',doc=document([text(left),text(right)]);
 for(const body of [left+'\n\nUnrepresented content\n\n'+right,right+'\n\n'+left]){
  const prepared=await prepareDoclingTextContextWindows(await saved(doc,body));assert.ok(prepared);assert.deepEqual(prepared.windows,[]);
 }
});

test('repeated text, copied prepared JSON and foreign/stale source bindings cannot acquire authority',async()=>{
 const left='Repeated passage',right='Unique passage',doc=document([text(left),text(right)]);
 const repeated=await prepareDoclingTextContextWindows(await saved(doc,left+'\n\n'+right+'\n\n'+left));assert.ok(repeated);
 assert.deepEqual(repeated.windows,[]);
 const input=await saved(doc,left+'\n\n'+right),prepared=await prepareDoclingTextContextWindows(input);assert.ok(prepared);
 assert.throws(()=>assertPreparedDoclingTextContextWindows(structuredClone(prepared),prepared.binding),/staging/);
 for(const binding of [{...prepared.binding,currentVersionId:'stale'},{...prepared.binding,evidenceId:'another-page'},
  {...prepared.binding,bodySha256:hash(input.body+' drift')}])
  assert.throws(()=>assertPreparedDoclingTextContextWindows(prepared,binding),/staging/);
 await assert.rejects(prepareDoclingTextContextWindows({...input,owner:'foreign'}),/owner\/source/);
 await assert.rejects(prepareDoclingTextContextWindows({...input,sourceHash:hash('foreign PDF')}),/owner\/source/);
});

test('pair windows overlap explicitly, remain at most 1200 UTF16 and stop at the page candidate limit',async()=>{
 const values=['a'.repeat(595),'b'.repeat(603)],body=values.join('\n\n');
 const exact=await prepareDoclingTextContextWindows(await saved(document(values.map(v=>text(v))),body));assert.ok(exact);
 assert.equal(exact.windows[0].endUtf16-exact.windows[0].startUtf16,1200);
 values[1]+='b';const oversized=await prepareDoclingTextContextWindows(await saved(document(values.map(v=>text(v))),values.join('\n\n')));
 assert.ok(oversized);assert.deepEqual(oversized.windows,[]);
 const overlap=['One dataset result','Another configuration','A final qualification'];
 const paired=await prepareDoclingTextContextWindows(await saved(document(overlap.map(v=>text(v))),overlap.join('\n\n')));assert.ok(paired);
 assert.equal(paired.windows.length,2);assert.ok(paired.windows[0].endUtf16>paired.windows[1].startUtf16);
 const many=Array.from({length:66},(_,i)=>'Unique block '+String(i).padStart(2,'0')+' ends.');
 await assert.rejects(prepareDoclingTextContextWindows(await saved(document(many.map(v=>text(v))),many.join('\n\n'))),/windows exceed page limit/);
});

test('answer selection offers literal context windows without changing legacy IDs or expanding chosen citations',async()=>{
 const axis='axis '.repeat(120).trim(),left='The training dataset is German-English. '+'Left context. '.repeat(30),
  right='These experiments use training subsets of 200K and 1M pairs. '+'Right context. '.repeat(30),
  body=axis+'\n\n'+left+'\n\n'+right,
  doc=document([text(left),text(right),text(axis,{parent:ref('#/pictures/0')})],
   [ref('#/pictures/0'),ref('#/texts/0'),ref('#/texts/1')],
   {pictures:[{parent:ref('#/body'),children:[ref('#/texts/2')],prov:[{page_no:1}]}]}),
  input=await saved(doc,body),hint=await prepareDoclingTextContextWindows(input);
 assert.ok(hint);assert.equal(hint.windows.length,1);
 const context:DocumentAnswerContext={sourceContentIsUntrusted:true,parents:[],images:[],anchors:[{
  id:`pg:${input.currentVersionId}:2`,document_id:input.documentId,source_version_id:input.sourceVersionId,source_hash:input.sourceHash,
  course_id:'',name:'Window fixture',origin:'fixture',origin_key:'fixture',body,locator:'page:2',page_number:2,
  evidence_id:input.evidenceId,parser_version:input.parserVersion,score:1,evidence_body:'full-page'}]},
  legacy=prepareDocumentAnswer('What are the training data sizes?',context),
  prepared=prepareDocumentAnswer('What are the training data sizes?',{...context,textContextWindows:[hint]});
 for(const unit of legacy.quoteUnits){
  const current=prepared.quoteUnits.find(candidate=>candidate.id===unit.id)!;assert.ok(current);
  assert.deepEqual({...current,selectable:unit.selectable,contextWindowCoverage:undefined},{...unit,contextWindowCoverage:undefined});
 }
 const window=prepared.quoteUnits.find(unit=>unit.contextWindow);assert.ok(window);
 assert.equal(window.text,left+'\n\n'+right);assert.equal(window.contextWindow!.semanticRelationsVerified,false);
 assert.deepEqual(window.contextWindow!.references,['#/texts/0','#/texts/1']);
 const choose=(id:string)=>resolveDocumentAnswerSelections({status:'answered',message:'',
  claims:[{text:'A test claim.',citations:[{id}]}]},prepared.supports);
 assert.equal(choose(window.id).answer.claims[0].citations[0].quote,window.text);
 const covered=prepared.quoteUnits.find(unit=>unit.contextWindowCoverage);assert.ok(covered);
 assert.equal(covered.contextWindowCoverage!.windowId,window.id);assert.equal(covered.selectable,false);
 assert.equal(legacy.quoteUnits.find(unit=>unit.id===covered.id)!.selectable,true);
 assert.throws(()=>choose(covered.id),/ungrounded/); // Explicitly unavailable; never silently redirected.
 const original=legacy.quoteUnits.find(unit=>prepared.quoteUnits.find(candidate=>candidate.id===unit.id)!.selectable)!;
 assert.equal(choose(original.id).answer.claims[0].citations[0].quote,original.text);
 assert.notEqual(original.text,window.text); // No late citation expansion.
 assert.throws(()=>prepareDocumentAnswer('Question',{...context,textContextWindows:[structuredClone(hint)]}),/staging/);
 assert.throws(()=>prepareDocumentAnswer('Question',{...context,anchors:[{...context.anchors[0],id:'pg:other-version:2'}],textContextWindows:[hint]}),/binding/);
});
