import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {validateContentClassification,recordContentClassification,type ContentClassificationInput} from '../lib/kernel/content-classifications.ts';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool,kernelTransaction,migrateKernel} from '../lib/kernel/db.ts';

let externalCalls=0;globalThis.fetch=async()=>{externalCalls++;throw Error('Classification tests forbid external calls');};
after(async()=>{try{assert.equal(externalCalls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const example=():ContentClassificationInput=>({documentId:'doc',versionId:'version',sourceVersionId:'source',sourceHash:hash('original'),
 classifierId:'unified/manual',producerVersion:'v1',method:'manual',model:null,previousId:null,
 tags:[{facet:'topic',key:' Ｂayes   Inference ',confidence:.8,evidence:{kind:'human-judgment'}}]});

test('classification contract normalizes labels without rewriting canonical IDs or source spans',()=>{
 const input=example(),before=structuredClone(input),r=validateContentClassification(input);
 assert.deepEqual(input,before);assert.equal(r.tags[0].key,'bayes inference');
 input.tags.push({facet:'course',key:'CS229-Fall',confidence:1,evidence:{kind:'source-metadata',field:'courseId',value:'CS229-Fall'}});
 assert.equal(validateContentClassification(input).tags[1].key,'CS229-Fall');
 input.tags[0].evidence={kind:'page',pageNumber:2,evidenceId:'e2',startUtf16:3,endUtf16:5,text:'原文'};
 assert.deepEqual(validateContentClassification(input).tags[0].evidence,input.tags[0].evidence);
 assert.deepEqual(validateContentClassification({...input,tags:[]}).tags,[],'Explicit correction can withdraw all proposals');
});

test('classification contract rejects unversioned, unattributed and duplicate proposals',()=>{
 for(const bad of [null,{...example(),sourceHash:'unknown'},{...example(),model:'mini'},
  {...example(),method:'model',model:null},{...example(),extra:true},
  {...example(),method:'model',model:'mini'},
  {...example(),tags:[{...example().tags[0],confidence:1.01}]},
  {...example(),tags:[{...example().tags[0],facet:'truth'}]},
  {...example(),tags:[{...example().tags[0],evidence:{kind:'page',pageNumber:1,evidenceId:'e',startUtf16:0,endUtf16:5,text:'x'}}]},
  {...example(),tags:[example().tags[0],{...example().tags[0],key:'bayes inference'}]}])assert.throws(()=>validateContentClassification(bad));
 const model={...example(),method:'model',model:'mini',tags:[{...example().tags[0],evidence:{kind:'source-metadata',field:'name',value:'Notes'}}]};
 assert.equal(validateContentClassification(model).method,'model');
});

test('classification revisions preserve page proof, CAS corrections, replay and current-source boundaries', {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='classification:'+uid,documentId=hash('doc:'+uid),
  body='😀 Unit 1: Bayesian inference.\nUnit 2: Linear algebra.',
  doc={id:documentId,ownerId:owner,courseId:'',name:'Lab Handout.txt',hash:hash(uid),mime:'text/plain',origin:'upload',originKey:'classification:'+uid};
 await kernel.ingestParsedDocument(doc,[{pageNumber:1,locator:'page 1',text:body}],{parserVersion:'classification-fixture'});
 const current=(await kernelPool().query(`SELECT d.current_version_id version_id,v.source_version_id,p.evidence_id FROM document_texts d
  JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=1 WHERE d.id=$1`,[documentId])).rows[0],
  start=body.indexOf('Bayesian inference'),input:ContentClassificationInput={...example(),documentId,versionId:current.version_id,
   sourceVersionId:current.source_version_id,sourceHash:doc.hash,tags:[{facet:'topic',key:'Bayesian Inference',confidence:.9,
    evidence:{kind:'page',pageNumber:1,evidenceId:current.evidence_id,startUtf16:start,endUtf16:start+18,text:'Bayesian inference'}}]};
 const first=await kernel.recordDocumentClassification(owner,input,'test-admin','Source-bound proposal');
 assert.deepEqual(await kernel.recordDocumentClassification(owner,input,'test-admin','Source-bound proposal'),{...first,replayed:true});
 let rows=await kernel.documentClassifications(owner,documentId);assert.equal(rows.length,1);
 assert.equal(rows[0].assignments[0].scope.kind,'fragment');assert.equal(rows[0].assignments[0].scope.startUtf16,start);
 assert.equal(rows[0].assignments[0].witness.bodySha256,hash(body));assert.equal(rows[0].assignments[0].semanticVerified,false);
 assert.equal(rows[0].filter_authorization,false);assert.ok(rows[0].unknown_facets.includes('course'));
 assert.equal(rows[0].taxonomy_version,'academic-content-tags-v1');assert.equal(rows[0].coverage,'explicit-scopes-only');assert.equal(rows[0].semantic_verified,false);
 await assert.rejects(kernel.recordDocumentClassification('foreign',input,'test-admin','Foreign source'),/current and owned/);
 assert.deepEqual(await kernel.documentClassifications('foreign',documentId),[]);
 await assert.rejects(kernel.recordDocumentClassification(owner,{...input,previousId:first.id,tags:[{...input.tags[0],evidence:{...input.tags[0].evidence,evidenceId:'forged'}}]},'test-admin','Forged evidence'),/page witness/);
 await assert.rejects(kernel.recordDocumentClassification(owner,{...input,tags:[{facet:'topic',key:'emoji',confidence:1,
  evidence:{kind:'page',pageNumber:1,evidenceId:current.evidence_id,startUtf16:0,endUtf16:1,text:body.slice(0,1)}}]},'test-admin','Split character'),/splits a Unicode/);
 await assert.rejects(kernel.recordDocumentClassification(owner,{...input,tags:[{facet:'source',key:'canvas',confidence:1,
  evidence:{kind:'source-metadata',field:'origin',value:'canvas'}}]},'test-admin','Wrong source metadata'),/metadata witness/);
 const attempts=await Promise.allSettled(['corrected-topic','alternative-topic'].map(key=>kernel.recordDocumentClassification(owner,
  {...input,previousId:first.id,tags:[{facet:'topic',key,confidence:1,evidence:{kind:'human-judgment'}}]},'test-admin','Concurrent correction')));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected').length,1);
 const rejected=attempts.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.match(String(rejected.reason),/revision conflict/);
 rows=await kernel.documentClassifications(owner,documentId);const latest=rows[0].id;
 assert.notEqual(latest,first.id);assert.equal(rows[0].previous_id,first.id);
 assert.deepEqual(await kernel.recordDocumentClassification(owner,input,'test-admin','Source-bound proposal'),{id:first.id,replayed:true,current:false});
 assert.equal((await kernel.documentClassifications(owner,documentId))[0].id,latest,'Old replay cannot revert the head');
 await assert.rejects(kernelTransaction(async client=>{
  await recordContentClassification(client,owner,{...input,previousId:latest,tags:[]},'test-admin','Rollback correction');throw Error('Deliberate rollback');
 }),/Deliberate rollback/);
 assert.equal((await kernel.documentClassifications(owner,documentId))[0].id,latest);
 assert.equal((await kernelPool().query('SELECT count(*)::int n FROM document_content_classifications WHERE document_id=$1',[documentId])).rows[0].n,2);
 await assert.rejects(kernelPool().query('INSERT INTO document_content_classification_heads(owner_id,version_id,classifier_id,classification_id) VALUES($1,$2,$3,$4)',
  ['foreign',input.versionId,input.classifierId,first.id]),{code:'23503'});
 const independent=await kernel.recordDocumentClassification(owner,{...input,classifierId:'independent/rule',method:'rule',tags:[{facet:'document_type',key:'notes',confidence:.7,
  evidence:{kind:'source-metadata',field:'name',value:doc.name}}]},'test-worker','Independent source naming rule');
 assert.equal((await kernel.documentClassifications(owner,documentId)).length,2,'No implicit winner across classifiers');
 assert.notEqual(independent.id,latest);
 await kernel.ingestParsedDocument(doc,[{pageNumber:1,locator:'page 1',text:body+' Updated.'}],{parserVersion:'classification-fixture-v2'});
 assert.deepEqual(await kernel.documentClassifications(owner,documentId),[],'Old-version proposals are history, not current labels');
 await assert.rejects(kernel.recordDocumentClassification(owner,input,'test-admin','Old version'),/current and owned/);
 assert.equal((await kernelPool().query('SELECT count(*)::int n FROM document_content_classifications WHERE document_id=$1',[documentId])).rows[0].n,3);
});
