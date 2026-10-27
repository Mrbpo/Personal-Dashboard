import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {focusedDocumentTextQuery,focusedTextQueryHash,explicitDocumentPage,documentQuotedLiteral,locateDocumentQuotedText,
 explicitDocumentFigure,locateDocumentFigureCaption,locateDocumentSectionIntervals} from '../lib/kernel/document-focused-text.ts';
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
test('explicit section lists retain observed sibling intervals and boundary pages without claiming membership',()=>{
 const pages=['Preface.','2.1 Calibration\nOriginal method.','Original continuation.','End.\n2.2 Other method',
  '2.3 Evaluation\nOriginal evaluation.','Continuation.','End.\n2.4 Discussion'].map((body,i)=>({physicalPage:i+1,evidenceId:'p'+i,body})),
  q=`In ${title}, compare Sections 2.1 and 2.3.`,before=JSON.stringify(pages),r=locateDocumentSectionIntervals(q,title,pages)!;
 assert.equal(r.status,'available');assert.deepEqual(r.pages.map(p=>p.physicalPage),[2,3,4,5,6,7]);
 assert.deepEqual(r.ranges.map(r=>[r.label,r.startPage,r.boundaryPage]),[['2.1',2,4],['2.3',5,7]]);
 assert.equal(r.semanticsVerified,false);assert.equal(r.coverage,'unassessed');assert.equal(JSON.stringify(pages),before);
 assert.equal(locateDocumentSectionIntervals(`在《${title}》中比较第2.1节和第2.3节。`,title,pages)?.status,'available');
 assert.equal(locateDocumentSectionIntervals(`In ${title}, compare Section2.1?`,title,pages),undefined);
 assert.equal(locateDocumentSectionIntervals(`In ${title}, explain the methods.`,title,pages),undefined);
 assert.equal(locateDocumentSectionIntervals('Compare Section 2.1 in another paper.',title,pages),undefined);
 for(const changed of [pages.filter(p=>p.physicalPage!==3),pages.map(p=>p.physicalPage===3?{...p,body:p.body+'\n2.1 Duplicate'}:p),
  pages.map(p=>p.physicalPage===4?{...p,body:'2.5 Wrong sibling'}:p),pages.map(p=>p.physicalPage===3?{...p,body:'x'.repeat(32769)}:p)])
  assert.equal(locateDocumentSectionIntervals(q,title,changed)?.status,'unavailable');
 assert.equal(locateDocumentSectionIntervals(`In ${title}, compare Section 2.1-2.3.`,title,pages)?.status,'unavailable');
});

test('section continuation survives selection with foreign evidence; empty and full reference selections are not expanded',()=>{
 const bodies=['Unrelated background.\n'.repeat(1800),'2.1 Calibration\nFirst study.','NECESSARY_CONTINUATION_A',
  'Closing method.\n2.2 Other method','2.3 Evaluation\nDifferent studies.','NECESSARY_CONTINUATION_B','Closing evaluation.\n2.4 Discussion'],
  q=`In ${title}, does Section 2.3 cite more studies than Section 2.1?`,base=fixture().anchors[0],
  anchors=bodies.map((body,i)=>({...base,id:`pg:v:${i+1}`,page_number:i+1,evidence_id:'section-'+i,locator:'original:'+i,body})),
  c:DocumentAnswerContext={anchors:[...anchors,{...fixture().anchors[1],body:'FOREIGN_SELECTED_EVIDENCE'}],parents:[],images:[],sourceContentIsUntrusted:true,
   focusedText:{policy:'bounded-mentioned-source-relevance-v1',source,querySha256:focusedTextQueryHash(focusedDocumentTextQuery(q,title)!),
    pages:[anchors[1],anchors[4]].map(a=>({evidenceId:a.evidence_id,bodySha256:sha(a.body)})),coverage:'unassessed',structureRelationsVerified:false}},
  p=prepareDocumentAnswer(q,c),ids=['e1','e4','e7'].map(id=>p.quoteUnits.find(u=>u.supportId===id)!.id),
  baseline=retainDocumentSelectionContext({referenceIds:ids},{...p,sectionIntervalCandidates:undefined}),
  repaired=retainDocumentSelectionContext({referenceIds:ids},p),needed=p.quoteUnits.find(u=>u.supportId==='e2')!;
 assert.equal(baseline.referenceIds.includes(needed.id),false,'Existing page/focus retention loses unselected continuation.');
 assert.equal(repaired.referenceIds.includes(needed.id),true);assert.ok(ids.every(id=>repaired.referenceIds.includes(id)));
 assert.equal(repaired.sectionTextRetention?.status,'retained');assert.equal(repaired.sectionTextRetention?.structureRelationsVerified,false);
 const wire=JSON.stringify(buildSelectedDocumentAnswerRequest(p,repaired.referenceIds,{model:'gpt-5.4-mini',reasoningEffort:'low',maxOutputTokens:3000}));
 for(const text of ['NECESSARY_CONTINUATION_A','NECESSARY_CONTINUATION_B','FOREIGN_SELECTED_EVIDENCE'])assert.ok(wire.includes(text));
 assert.deepEqual(retainDocumentSelectionContext({referenceIds:[]},p).referenceIds,[]);
 const changed=structuredClone(c);changed.anchors.at(-1)!.body='Other original text.\n'.repeat(4000);
 const large=prepareDocumentAnswer(q,changed),full=large.quoteUnits.filter(u=>u.supportId==='e7').slice(0,64).map(u=>u.id);assert.equal(full.length,64);
 const limited=retainDocumentSelectionContext({referenceIds:full},large);
 assert.equal(limited.sectionTextRetention?.status,'skipped-reference-limit');assert.deepEqual(limited.referenceIds,full);
});

test('supplemental query removes only the verified NFKC title span',()=>{
 assert.equal(focusedDocumentTextQuery('In Ｏriginal Research Paper, what domain?',title),'In  , what domain?');
 assert.equal(focusedDocumentTextQuery('In another paper, what domain?',title),null);
 assert.equal(focusedDocumentTextQuery('Original Research Paper',title),null);
 assert.equal(focusedDocumentTextQuery('Original Research Paper and Original Research Paper: compare?',title),'and Original Research Paper: compare?');
});

test('literal page preference ignores title numbers and refuses ambiguous ranges',()=>{
 assert.equal(explicitDocumentPage(`In ${title}, what does the cartoon on page 25 represent?`,title),25);
 assert.equal(explicitDocumentPage(`关于《${title}》，第２５页的图是什么？`,title),25);
 for(const suffix of ['pages 25 and 26','page 25-26','page 25,26','page 25 to 26','page 25.3','page 25 and page 26','the year 2025'])
  assert.equal(explicitDocumentPage(`In ${title}, ${suffix}?`,title),null,suffix);
 const numberedTitle='Research page 25.pdf';
 assert.equal(explicitDocumentPage(`In ${numberedTitle}, describe the image.`,numberedTitle),null);
 assert.equal(explicitDocumentPage('In another source, page 25?',title),null);
});

test('quoted literal locates lost word spaces as candidates while preserving raw bodies and unknown neighbor relation',()=>{
 const literal='MATRIX FACTORISATION DERIVATION',pages=[{physicalPage:1,evidenceId:'p1',body:'Unrelated introduction.'},
  {physicalPage:2,evidenceId:'p2',body:'F MATRIXFACTORISATIONDERIVATION\nFirst derivation.'},
  {physicalPage:3,evidenceId:'p3',body:'A following page; section membership is unknown.'}],before=JSON.stringify(pages),
  extracted=documentQuotedLiteral(`In "${title}", based on “${literal}”, compare the methods.`,title);
 assert.equal(extracted,literal);const result=locateDocumentQuotedText(extracted!,pages);
 assert.equal(result.status,'available');assert.equal(result.semanticsVerified,false);assert.equal(result.adjacentPageRelationship,'unknown');
 assert.deepEqual(result.pages.map(p=>[p.physicalPage,p.evidenceId,p.role]),[[2,'p2','literal-match-candidate'],[3,'p3','next-page-candidate']]);
 assert.equal(result.pages[0].bodySha256,sha(pages[1].body));assert.equal(JSON.stringify(pages),before);
 assert.equal(locateDocumentQuotedText(literal,pages.slice(0,2)).pages.length,1,'last-page match cannot invent a neighbor');
 assert.equal(documentQuotedLiteral(`关于《${title}》，“线性代数课程学习要求”是什么？`,title),'线性代数课程学习要求');
});

test('quoted location falls back on ambiguity, missing text, limits or incomplete page sequences',()=>{
 const literal='MATRIX FACTORISATION DERIVATION',page={physicalPage:1,evidenceId:'p1',body:literal};
 assert.equal(documentQuotedLiteral(`In ${title}, "${literal}" and "Probability distribution estimation"?`,title),null);
 assert.equal(documentQuotedLiteral(`In ${title}, "Figure 1"?`,title),null);
 assert.equal(documentQuotedLiteral(`In another source, "${literal}"?`,title),null);
 for(const pages of [[page,{...page,physicalPage:2,evidenceId:'p2'}],[{...page,body:literal+' '+literal}],
  [{...page,physicalPage:2}],[],[{...page,body:'x'.repeat(262145)}],[{...page,body:'Different source text.'}]]){
  const result=locateDocumentQuotedText(literal,pages);assert.equal(result.status,'unavailable');assert.deepEqual(result.pages,[]);
 }
});

test('explicit figure caption locates only the unique literal page, not prose mentions or a verified region',()=>{
 const pages=[{physicalPage:1,evidenceId:'p1',body:'As shown in Figure 1, we compare the methods.'},
  {physicalPage:2,evidenceId:'p2',body:'Background.\n\nFigure1: Tree construction process.\nOriginal diagram labels.'}],before=JSON.stringify(pages);
 assert.equal(explicitDocumentFigure(`In ${title}, Figure 1's demonstration: compare the colors.`,title),1);
 assert.equal(explicitDocumentFigure(`关于《${title}》，图１中的颜色？`,title),1);
 const located=locateDocumentFigureCaption(1,pages);assert.equal(located.status,'available');
 assert.deepEqual(located.pages,[{physicalPage:2,evidenceId:'p2',bodySha256:sha(pages[1].body),role:'caption-match-candidate'}]);
 assert.equal(located.semanticsVerified,false);assert.equal(located.figureRegionRelationship,'unknown');assert.equal(JSON.stringify(pages),before);
 assert.equal(locateDocumentFigureCaption(1,[{...pages[0],body:'Fig. 1. A compact caption.'}]).status,'available');
 assert.equal(locateDocumentFigureCaption(1,[{...pages[0],body:'图１：原始图注'}]).status,'available');
});

test('figure routing falls back on ambiguous labels, duplicate captions, wrong numbers and bounded-source failures',()=>{
 for(const suffix of ['Figure 1 and 2','Figure 1-2','Figure 1.2','Figure 1 and Figure 2','Figure 10000','in 2024'])
  assert.equal(explicitDocumentFigure(`In ${title}, ${suffix}?`,title),null,suffix);
 assert.equal(explicitDocumentFigure('In another source, Figure 1?',title),null);
 assert.equal(explicitDocumentFigure('In Research Figure 1.pdf, describe the diagram.','Research Figure 1.pdf'),null);
 const page={physicalPage:1,evidenceId:'p1',body:'Figure 1: Original caption.'};
 for(const pages of [[],[{...page,body:'As shown in Figure 1: the model works.'}],[{...page,body:'Figure 10: Other caption.'}],
  [{...page,body:'Figure 1.2 More specific object.'}],[page,{...page,physicalPage:2,evidenceId:'p2'}],
  [{...page,body:page.body+'\n'+page.body}],[{...page,physicalPage:2}],[{...page,body:'x'.repeat(262145)}]]){
  const result=locateDocumentFigureCaption(1,pages);assert.equal(result.status,'unavailable');assert.deepEqual(result.pages,[]);
 }
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
