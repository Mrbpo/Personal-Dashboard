import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeStudyEvidence} from '../lib/kernel/service.ts';
import type {DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
const hit=(id:string,body=id)=>({id,document_id:id,source_version_id:'sv',source_hash:'hash',evidence_id:id,locator:'original',body});
const context=(anchors:unknown[],images:unknown[]=[]):DocumentAnswerContext=>({anchors,images,parents:[],sourceContentIsUntrusted:true}) as DocumentAnswerContext;
test('complete named-source supplementation retains other retrieved sources and rejects changed evidence',()=>{
 const base=context([hit('other'),hit('named')]),added=context([hit('named'),hit('definition')]);
 assert.deepEqual(mergeStudyEvidence(base,added)?.anchors.map(x=>x.id),['other','named','definition']);
 assert.throws(()=>mergeStudyEvidence(base,context([hit('named','changed')])),/changed/i);
 assert.equal(base.anchors.length,2,'original frozen context is not mutated');
});
test('supplementation cannot bypass the existing global image-count budget',()=>{
 const image=(n:number)=>({attachmentId:String(n),assetId:String(n),captionEvidenceId:'c',sha256:'h',byteLength:1,width:32,height:32,
  mime:'image/png',bytes:new Uint8Array([1]),source:{documentId:'d',currentVersionId:'v',sourceVersionId:'s',sourceHash:'h'}});
 assert.equal(mergeStudyEvidence(context([],Array.from({length:64},(_,i)=>image(i))),context([],[image(64)])),null);
});
