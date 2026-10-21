import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {focusedDocumentTextQuery,focusedTextQueryHash} from '../lib/kernel/document-focused-text.ts';
import {prepareDocumentAnswer,retainDocumentSelectionContext,buildSelectedDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),title='Original Research Paper.pdf',question='In Original Research Paper, what domain was evaluated?';
const source={documentId:'target',currentVersionId:'v',sourceVersionId:'sv',sourceHash:'source-hash'};
function fixture(){
 const anchors=['target','other','target'].map((id,i)=>({id:`pg:${id==='target'?'v':'other-v'}:${i+1}`,document_id:id,course_id:'',
  name:id==='target'?title:'Other Research Paper.pdf',origin:'fixture',origin_key:id,source_hash:id==='target'?source.sourceHash:'other-hash',
  source_version_id:id==='target'?'sv':'other-sv',body:i===2?'Experimental restaurant domain.':'Background introductory context.',
  locator:`page:${i+1}`,page_number:i+1,evidence_id:`ev-${i}`,parser_version:'fixture',score:1,evidence_body:'full-page' as const}));
 const context:DocumentAnswerContext={anchors,parents:[],images:[],sourceContentIsUntrusted:true,
  focusedText:{policy:'bounded-mentioned-source-relevance-v1',source,querySha256:focusedTextQueryHash(focusedDocumentTextQuery(question,title)!),
   pages:[{evidenceId:'ev-2',bodySha256:sha(anchors[2].body)}],coverage:'unassessed',structureRelationsVerified:false}};
 return context;
}
test('supplemental query removes only the verified NFKC title span',()=>{
 assert.equal(focusedDocumentTextQuery('In Ｏriginal Research Paper, what domain?',title),'In  , what domain?');
 assert.equal(focusedDocumentTextQuery('In another paper, what domain?',title),null);
 assert.equal(focusedDocumentTextQuery('Original Research Paper',title),null);
 assert.equal(focusedDocumentTextQuery('Original Research Paper and Original Research Paper: compare?',title),'and Original Research Paper: compare?');
});
test('focused original text survives selection without deleting another selected source',()=>{
 const c=fixture(),p=prepareDocumentAnswer(question,c),other=p.quoteUnits.find(q=>q.supportId==='e1')!,
  retained=retainDocumentSelectionContext({referenceIds:[other.id]},p),focus=p.quoteUnits.find(q=>q.supportId==='e2')!;
 assert.ok(retained.referenceIds.includes(other.id));assert.ok(retained.referenceIds.includes(focus.id));
 assert.deepEqual(retained.focusedTextRetention?.retainedEvidenceIds,['ev-2']);
 const wire=buildSelectedDocumentAnswerRequest(p,retained.referenceIds,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000});
 assert.match(JSON.stringify(wire),/Experimental restaurant domain/);
 assert.equal(retained.coverage,'unassessed');assert.equal(retained.structureRelationsVerified,false);
});
test('focused text cannot rescue empty, invalid or unoffered selector IDs',()=>{
 const p=prepareDocumentAnswer(question,fixture());
 assert.deepEqual(retainDocumentSelectionContext({referenceIds:[]},p).referenceIds,[]);
 assert.throws(()=>retainDocumentSelectionContext({referenceIds:['fake-id']},p));
});
test('focus binding rejects changed hash, version, query, duplicate and foreign evidence',()=>{
 for(const mutate of [
  (c:DocumentAnswerContext)=>{c.focusedText!.pages[0].bodySha256=sha('changed');},
  (c:DocumentAnswerContext)=>{c.focusedText!.source={...source,currentVersionId:'old-v'};},
  (c:DocumentAnswerContext)=>{c.focusedText!.querySha256=sha('different query');},
  (c:DocumentAnswerContext)=>{c.focusedText!.pages.push({...c.focusedText!.pages[0]});},
  (c:DocumentAnswerContext)=>{c.focusedText!.pages[0]={evidenceId:'ev-1',bodySha256:sha(c.anchors[1].body)};},
 ]){const c=fixture();mutate(c);assert.throws(()=>prepareDocumentAnswer(question,c),/Focused|focused/);}
});
test('whole focused pages respect the 32 KiB bound and never evict 64 existing references',()=>{
 const over=fixture();over.anchors[2].body='x'.repeat(32769);over.focusedText!.pages[0].bodySha256=sha(over.anchors[2].body);
 assert.throws(()=>prepareDocumentAnswer(question,over),/budget/);
 const full=fixture();full.anchors[1].body=Array.from({length:66},(_,i)=>`Other-source passage ${i}. `+'x'.repeat(1150)).join('\n\n');
 const p=prepareDocumentAnswer(question,full),ids=p.quoteUnits.filter(q=>q.supportId==='e1').slice(0,64).map(q=>q.id),retained=retainDocumentSelectionContext({referenceIds:ids},p);
 assert.equal(retained.referenceIds.length,64);assert.deepEqual(retained.focusedTextRetention?.skippedEvidenceIds,['ev-2']);
 assert.deepEqual(retained.referenceIds,ids);
});
