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
 assert.deepEqual(r.bindings[0].binding,{referenceId:unit.id,quoteSha256:unit.quoteSha256,startUtf16:41,endUtf16:59,semanticScopeVerified:false});
 assert.equal(r.semanticScopeVerified,false);
});
test('scope literal cannot be borrowed from an uncited unit or bind to guessed text, duplicate spans or altered bytes',()=>{
 for(const scope of [{kind:'source-limited',referenceId:'q:other',literal:'pilot participants'},
  {kind:'source-limited',referenceId:unit.id,literal:'all participants'},
  {kind:'not-applicable',referenceId:unit.id,literal:null}]){
  const v=structuredClone(base);Object.assign(v.claims[0].scope,scope);assert.throws(()=>bind(v),/Invalid literal/);
 }
 for(const other of [{...unit,selectable:false},{...unit,quoteSha256:'wrong'},
  {...unit,text:'pilot participants; pilot participants',quoteSha256:createHash('sha256').update('pilot participants; pilot participants').digest('hex')}])
  assert.throws(()=>bind(base,[other]),/Invalid literal/);
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
