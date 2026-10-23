import {test} from 'node:test';import assert from 'node:assert/strict';
import {prepareDocumentAnswer,normalizeDocumentAnswerSelections,resolveDocumentAnswerSelections} from '../lib/kernel/document-answer.ts';
const p=prepareDocumentAnswer('What are the results?',{sourceContentIsUntrusted:true,parents:[],images:[],anchors:['A','B'].map((body,i)=>({
 id:`pg:v${i}:1`,document_id:`d${i}`,course_id:'',name:`Paper${i}`,origin:'test',origin_key:`o${i}`,source_hash:`h${i}`,source_version_id:`sv${i}`,
 body:'Original result '+body,locator:'第 1 页',page_number:1,evidence_id:`e${i}`,parser_version:'test',score:1,evidence_body:'full-page' as const}))});
const [a,b]=p.quoteUnits.map(q=>q.id),raw={status:'answered',message:'',claims:[{text:'First claim.',citations:[{id:a},{id:a},{id:b}]},{text:'Second claim.',citations:[{id:a}]}]};
test('model-boundary normalization preserves all distinct evidence and raw claims while strict resolution stays strict',()=>{
 const before=JSON.stringify(raw),r=normalizeDocumentAnswerSelections(raw,[a,b]);assert.equal(JSON.stringify(raw),before);
 assert.deepEqual(r.selections.claims.map(c=>c.citations.map(x=>x.id)),[[a,b],[a]]);
 assert.deepEqual(r.selections.claims.map(c=>c.text),raw.claims.map(c=>c.text));
 assert.deepEqual(r.normalization?.duplicates,[{claimIndex:0,citationIndex:1,firstCitationIndex:0,id:a}]);
 assert.notEqual(r.normalization?.providerSelectionsSha256,r.normalization?.normalizedSelectionsSha256);
 assert.throws(()=>resolveDocumentAnswerSelections(raw,p.supports),/ungrounded/);
 assert.equal(resolveDocumentAnswerSelections(r.selections,p.supports).selectedUnits.length,3);
});
test('unknown/unoffered IDs are rejected before dedup; distinct claims and valid nonduplicate output are unchanged',()=>{
 for(const id of ['q:unknown',b])assert.throws(()=>normalizeDocumentAnswerSelections({status:'answered',message:'',claims:[{text:'x',citations:[{id:a},{id},{id}]}]},[a]));
 const valid={status:'answered',message:'',claims:[{text:'x',citations:[{id:a}]},{text:'y',citations:[{id:a}]}]},r=normalizeDocumentAnswerSelections(valid,[a]);
 assert.deepEqual(r.selections,valid);assert.equal(r.normalization,undefined);
 assert.throws(()=>normalizeDocumentAnswerSelections({...valid,extra:'not in schema'},[a]));
});
