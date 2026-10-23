import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {withDocumentScopeOutput,bindDocumentScopeAnnotations} from '../lib/kernel/document-scope-annotations.ts';
const text='😀 Scope: pilot participants. Other cohorts were not measured.';
const unit={id:'q:original',text,selectable:true,startUtf16:31,quoteSha256:createHash('sha256').update(text).digest('hex')};
const base={status:'answered',message:'',claims:[{text:'The improvement was observed.',citations:[{id:unit.id}],
 scope:{kind:'source-limited',referenceId:unit.id,literal:'pilot participants'}}]};
const bind=(v:unknown,u=[unit])=>bindDocumentScopeAnnotations(v,u,'Insufficient.');

test('scope binding preserves original claims and binds unique literal with UTF-16 page offsets',()=>{
 const before=structuredClone(base),r=bind(base);
 assert.deepEqual(base,before);assert.equal(r.originalSelections.claims[0].text,base.claims[0].text);
 assert.equal(r.selections.claims[0].text,'Source scope: pilot participants\nThe improvement was observed.');
 assert.deepEqual(r.bindings[0].binding,{referenceId:unit.id,quoteSha256:unit.quoteSha256,
  locationPolicy:'all-exact-occurrences-v1',locationStatus:'unique',startUtf16:41,endUtf16:59,
  literalSpans:[{startUtf16:41,endUtf16:59}],semanticScopeVerified:false});
 assert.equal(r.semanticScopeVerified,false);
});
test('scope literal cannot be borrowed from an uncited unit or bind to guessed text or altered bytes',()=>{
 for(const scope of [{kind:'source-limited',referenceId:'q:other',literal:'pilot participants'},
  {kind:'source-limited',referenceId:unit.id,literal:'all participants'},
  {kind:'not-applicable',referenceId:unit.id,literal:null}]){
  const v=structuredClone(base);Object.assign(v.claims[0].scope,scope);assert.throws(()=>bind(v),/Invalid literal/);
 }
 for(const other of [{...unit,selectable:false},{...unit,quoteSha256:'wrong'}])
  assert.throws(()=>bind(base,[other]),/Invalid literal/);
});
test('repeated experiment labels preserve all exact locations without selecting or semantically verifying one',()=>{
 const text='😀 In Exp. 5.1, and 5.2 in Table 1, we see the results. Exp. 5.1 shows that decreasing decoder layers does not hurt performance.';
 const source={...unit,text,quoteSha256:createHash('sha256').update(text).digest('hex')};
 const v=structuredClone(base);v.claims[0].scope.literal='Exp. 5.1';
 const r=bind(v,[source]),binding=r.bindings[0].binding!;
 assert.equal(binding.locationStatus,'multiple-exact-occurrences');
 assert.equal(binding.startUtf16,null);assert.equal(binding.endUtf16,null);
 assert.deepEqual(binding.literalSpans,[{startUtf16:37,endUtf16:45},{startUtf16:87,endUtf16:95}]);
 for(const span of binding.literalSpans)assert.equal(text.slice(span.startUtf16-source.startUtf16,span.endUtf16-source.startUtf16),'Exp. 5.1');
 assert.equal(binding.semanticScopeVerified,false);assert.equal(r.semanticScopeVerified,false);
 assert.equal(r.selections.claims[0].text,'Source scope: Exp. 5.1\nThe improvement was observed.');
 assert.deepEqual(r.originalSelections.claims[0].citations,base.claims[0].citations);
});
test('all locations include overlaps and a bounded catalog rejects excessive literal matches',()=>{
 const make=(text:string)=>({...unit,text,quoteSha256:createHash('sha256').update(text).digest('hex')});
 const v=structuredClone(base);v.claims[0].scope.literal='aa';
 assert.deepEqual(bind(v,[make('aaa')]).bindings[0].binding!.literalSpans,[{startUtf16:31,endUtf16:33},{startUtf16:32,endUtf16:34}]);
 v.claims[0].scope.literal='a';
 assert.equal(bind(v,[make('a'.repeat(64))]).bindings[0].binding!.literalSpans.length,64);
 assert.throws(()=>bind(v,[make('a'.repeat(65))]),/Invalid literal/);
});
test('unknown necessary scope yields neutral insufficient evidence and retains original claim for diagnostics',()=>{
 const v=structuredClone(base);Object.assign(v.claims[0].scope,{kind:'not-established',referenceId:null,literal:null});
 const r=bind(v);assert.deepEqual(r.selections,{status:'insufficient-evidence',message:'Insufficient.',claims:[]});
 assert.equal(r.originalSelections.claims.length,1);assert.equal(r.necessaryScopeUnknown,true);
 assert.throws(()=>bind({...v,status:'invalid'}),/Invalid literal/);
});
test('not-applicable keeps the original selection unchanged and extra fields are rejected',()=>{
 const v=structuredClone(base);Object.assign(v.claims[0].scope,{kind:'not-applicable',referenceId:null,literal:null});
 const r=bind(v);assert.deepEqual(r.selections,r.originalSelections);assert.equal(r.bindings[0].binding,null);
 assert.throws(()=>bind({...v,unexpected:true}),/Invalid literal/);
 assert.throws(()=>bind({...v,claims:[{...v.claims[0],extra:true}]}),/Invalid literal/);
});
test('scope output modifies only a cloned generation contract and retains exact original evidence',()=>{
 const request={input:[{role:'developer',content:'Generate.'},{role:'user',content:[{type:'input_text',text:'Original source bytes.'}]}],
  text:{format:{schema:{properties:{claims:{items:{properties:{text:{type:'string'}},required:['text']}}}}}}};
 const before=structuredClone(request),r=withDocumentScopeOutput(request,[unit]);
 assert.deepEqual(request,before);assert.deepEqual(r.input[1],before.input[1]);
 assert.deepEqual(r.text.format.schema.properties.claims.items.required,['text','scope']);
 assert.throws(()=>withDocumentScopeOutput(request,[unit,unit]),/Invalid scope annotation catalog/);
});
