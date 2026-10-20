import {test,after} from 'node:test';import assert from 'node:assert/strict';import{createHash,randomUUID}from'node:crypto';
import {literalClassificationMention,planClassificationBranch,classificationShadowAnswerObservation} from '../lib/kernel/classification-route-shadow.ts';
import {validateStoredContentClassification}from'../lib/kernel/content-classifications.ts';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
let providers=0;globalThis.fetch=async()=>{providers++;throw Error('Classification shadow tests forbid provider calls');};
after(async()=>{try{assert.equal(providers,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
test('literal classification mentions normalize text, preserve word boundaries and do not guess aliases',()=>{
 assert.equal(literalClassificationMention('Explain ＢＡＹＥＳＩＡＮ   inference.','bayesian inference'),true);
 assert.equal(literalClassificationMention('Read EM+Prune performance','EM+Prune'),true);
 assert.equal(literalClassificationMention('Read MEM+Prune performance','EM+Prune'),false);
 assert.equal(literalClassificationMention('Bayes theorem','bayesian inference'),false);
 assert.equal(literalClassificationMention('请解释贝叶斯推断的用途','贝叶斯推断'),true);
 assert.throws(()=>validateStoredContentClassification({}));
});
test('shadow observes wrong/unclassified losses without changing returned evidence or escaping explicit scope',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='shadow:'+uid,env=process.env.KERNEL_CONTENT_TAG_ROUTING,docs:Record<string,any>={};
 const put=async(name:string,origin:string,tag?:string,otherOwner=owner)=>{
  const doc={id:hash(uid+name),ownerId:otherOwner,courseId:'',name:name+'.txt',hash:hash('original:'+uid+name),mime:'text/plain',origin,originKey:uid+name};
  await kernel.ingestParsedDocument(doc,[{locator:'page 1',pageNumber:1,text:'Calculus derivative requirements. '+name}],{parserVersion:'shadow-fixture'});
  const row=(await kernelPool().query('SELECT d.current_version_id,v.source_version_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id WHERE d.id=$1',[doc.id])).rows[0];
  if(tag)await kernel.recordDocumentClassification(otherOwner,{documentId:doc.id,versionId:row.current_version_id,sourceVersionId:row.source_version_id,sourceHash:doc.hash,
   classifierId:'shadow/test',producerVersion:'v1',method:'manual',model:null,previousId:null,
   tags:[{facet:'topic',key:tag,confidence:1,evidence:{kind:'human-judgment'}}]},'test-admin','Known isolated test label; not a content score');
  docs[name]={...doc,...row};return doc.id;
 };
 try{
  const a=await put('correct-label','canvas','calculus'),b=await put('wrong-label','piazza','algebra'),u=await put('unclassified','gmail'),foreign=await put('foreign','canvas','calculus','foreign:'+uid);
  const options={semantic:false,hybrid:false,aiRerank:false,refineAdjacent:false,relatedDocuments:false,limit:14};
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';const baseline=await kernel.searchDocumentText(owner,'calculus derivative',options);
  assert.deepEqual(new Set(baseline.map(h=>h.document_id)),new Set([a,b,u]));
  process.env.KERNEL_CONTENT_TAG_ROUTING='classification-shadow-v1';
  const shadow=await kernel.searchDocumentText(owner,'calculus derivative',options),strip=(hits:typeof shadow)=>hits.map(({classification_route_shadow,...h})=>h);
  assert.deepEqual(strip(shadow),baseline,'Shadow must preserve baseline scores, order, text and source identities');
  const r=shadow[0].classification_route_shadow!;assert.equal(r.effect,'observe-only');assert.equal(r.filterAuthorization,false);
  assert.deepEqual(r.plan.documentIds,[a]);assert.ok(!r.plan.documentIds.includes(foreign));assert.equal(r.branchReturned,1);
  assert.equal(r.baselineEvidenceMissingFromBranch,2,'Wrong and absent labels lose valid evidence in the proposed branch');
  assert.equal(r.scoredDocuments,null,'Returned hits are not total scoring work');
  assert.equal(classificationShadowAnswerObservation(shadow)?.receipts.length,1);
  const scoped=await kernel.searchDocumentText(owner,'calculus derivative',{...options,routingScope:{origins:['canvas']}});
  assert.deepEqual(scoped.map(h=>h.document_id),[a]);assert.equal(scoped[0].classification_route_shadow!.baselineEvidenceMissingFromBranch,0);
  const stored=(await kernel.documentClassifications(owner,a))[0];assert.equal(validateStoredContentClassification(stored).documentId,a);
  await kernelPool().query(`UPDATE document_content_classifications SET assignments=jsonb_set(assignments,'{0,confidence}','0.5') WHERE id=$1`,[stored.id]);
  assert.equal((await planClassificationBranch(kernelPool(),owner,'calculus derivative',{})).reason,'invalid-classification');
  const corrupted=await kernel.searchDocumentText(owner,'calculus derivative',options);assert.deepEqual(strip(corrupted),baseline);
  assert.equal(corrupted[0].classification_route_shadow!.branchExecuted,false);
  assert.equal(corrupted[0].classification_route_shadow!.baselineEvidenceMissingFromBranch,null);
  await kernel.ingestParsedDocument(docs['correct-label'],[{locator:'page 1',pageNumber:1,text:'Calculus derivative requirements. Revised source.'}],{parserVersion:'shadow-fixture-v2'});
  assert.equal((await planClassificationBranch(kernelPool(),owner,'calculus derivative',{})).reason,'no-literal-classification','Old version classifications cannot select current sources');
 }finally{if(env===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=env;}
});
