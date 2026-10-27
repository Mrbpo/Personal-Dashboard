import{test,after}from'node:test';import assert from'node:assert/strict';import{createHash,randomUUID}from'node:crypto';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{validateContentTaxonomy,validateStoredContentTaxonomy,contentTaxonomyQueryHints}from'../lib/kernel/content-taxonomy-registry.ts';
import{REGISTERED_TOPIC_VERSION,importControlledTopics}from'../lib/kernel/content-topic-classification.ts';
import{planClassificationBranch}from'../lib/kernel/classification-route-shadow.ts';
let calls=0;globalThis.fetch=async()=>{calls++;throw Error('Taxonomy registry checks forbid provider requests');};
after(async()=>{try{assert.equal(calls,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),entries=[
 {facet:'topic' as const,key:'likelihood',aliases:['ML','最大似然','maximum likelihood']},
 {facet:'topic' as const,key:'machine-learning',aliases:['ML','机器学习']},
 {facet:'chapter' as const,key:'chapter-one',aliases:['Chapter One','第一章']},
];
test('taxonomy schemas preserve original aliases, bound inputs and keep shared aliases ambiguous',()=>{
 const value={previousId:null,entries},before=structuredClone(value),checked=validateContentTaxonomy(value);
 assert.deepEqual(value,before);assert.deepEqual(checked,value);
 const registry={...checked,revisionId:'a'.repeat(64),version:'academic-topic-taxonomy-v1',actor:'admin',reason:'Fixture configuration',semanticVerified:false as const,filterAuthorization:false as const};
 assert.deepEqual(contentTaxonomyQueryHints('ML',registry).map(h=>h.key),['likelihood','machine-learning']);
 assert.deepEqual(contentTaxonomyQueryHints('XHTML',registry),[]);
 assert.deepEqual(contentTaxonomyQueryHints('最大似然与第一章',registry).map(h=>h.facet),['topic','chapter']);
 assert.throws(()=>validateContentTaxonomy({...value,unknown:true}),/Invalid bounded/);
 assert.throws(()=>validateContentTaxonomy({...value,entries:[entries[0],entries[0]]}),/Duplicate/);
 assert.throws(()=>validateContentTaxonomy({...value,entries:[{...entries[0],aliases:['ML','ml']}]}),/Duplicate/);
 assert.throws(()=>validateContentTaxonomy({...value,entries:[{...entries[0],facet:'course'}]}),/Invalid taxonomy entry/);
 assert.throws(()=>validateContentTaxonomy({...value,entries:Array(257).fill(entries[0])}),/Invalid taxonomy revision/);
});
test('registered cold start, fragment import, aliases, corrections and historical replay use the same Kernel',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='registry:'+uid;
 const add=async(key:string,text:string)=>{
  const doc={id:hash(uid+key),ownerId:owner,courseId:'',name:key+'.txt',hash:hash(text),origin:'upload',originKey:uid+key,mime:'text/plain'};
  await kernel.ingestParsedDocument(doc,[{pageNumber:1,locator:'page 1',text}],{parserVersion:'registry-fixture-v1'});return doc;
 };
 const a=await add('likelihood','Chapter One. Maximum likelihood estimates use probabilities.'),b=await add('learning','Machine learning uses statistical models.');
 assert.equal((await kernel.prepareDocumentTopics(owner,a.id)).status,'unavailable');
 assert.deepEqual(await kernel.documentClassifications(owner,a.id),[]);assert.equal(await kernel.contentTaxonomy(owner),null);
 const input={previousId:null,entries},first=await kernel.recordContentTaxonomy(owner,input,'fixture-admin','Initialize approved subjects and aliases');
 assert.deepEqual(await kernel.recordContentTaxonomy(owner,input,'fixture-admin','Initialize approved subjects and aliases'),{id:first.id,replayed:true,current:true});
 const current=await kernel.contentTaxonomy(owner);assert.equal(current!.revisionId,first.id);assert.equal(await kernel.contentTaxonomy('foreign:'+owner),null);
 const stored=(await kernelPool().query('SELECT * FROM content_taxonomy_revisions WHERE id=$1',[first.id])).rows[0];
 assert.deepEqual(validateStoredContentTaxonomy(JSON.parse(JSON.stringify(stored))),input,'JSONB object order is not evidence of corruption');
 assert.throws(()=>validateStoredContentTaxonomy({...stored,actor:'tampered'}),/digest differs/);
 await assert.rejects(kernel.recordContentTaxonomy(owner,input,'fixture-admin','Stale first writer'),/revision conflict/);
 await assert.rejects(kernel.recordContentTaxonomy('foreign:'+owner,{previousId:first.id,entries},'fixture-admin','No cross-owner parent'),/revision conflict/);
 const ready=await kernel.prepareDocumentTopics(owner,a.id);assert.equal(ready.status,'ready');if(ready.status!=='ready')return;
 assert.equal(ready.packet.version,REGISTERED_TOPIC_VERSION);assert.equal(ready.packet.taxonomyRevisionId,first.id);assert.deepEqual(ready.packet.vocabularyRevisionIds,[]);
 assert.deepEqual(ready.packet.labels.map(l=>l.aliases),entries.map(e=>e.aliases));
 assert.deepEqual(await kernel.documentClassifications(owner,a.id),[],'Catalog preparation must not create a fake seed classification');
 const raw=(packet:typeof ready.packet,keys:string[])=>JSON.stringify({status:'completed',model:'gpt-5.4-mini',usage:{input_tokens:1,output_tokens:1},
  output_text:JSON.stringify({labels:keys.map(key=>({labelId:packet.labels.find(l=>l.key===key)!.id,quoteUnitId:packet.quoteUnits[0].id}))})});
 const rawA=raw(ready.packet,['likelihood','chapter-one']),imported=await kernel.importDocumentTopics(owner,ready.packet,rawA,'fixture-admin','Explicit scripted response fixture');
 const row=(await kernel.documentClassifications(owner,a.id))[0];assert.equal(row.id,imported.id);assert.equal(row.filter_authorization,false);
 assert.deepEqual(row.assignments.map((t:{facet:string})=>t.facet),['topic','chapter']);assert.ok(row.assignments.every((t:{scope:{kind:string}})=>t.scope.kind==='fragment'));
 const other=await kernel.prepareDocumentTopics(owner,b.id);assert.equal(other.status,'ready');if(other.status!=='ready')return;
 await kernel.importDocumentTopics(owner,other.packet,raw(other.packet,['machine-learning']),'fixture-admin','Explicit scripted second response');
 const chinese=await planClassificationBranch(kernelPool(),owner,'最大似然',{});assert.deepEqual(chinese.documentIds,[a.id]);assert.equal(chinese.taxonomyRevisionId,first.id);
 assert.deepEqual((await planClassificationBranch(kernelPool(),owner,'ML',{})).documentIds,[a.id,b.id].sort(),'Do not elect one meaning of an ambiguous alias');
 assert.deepEqual((await planClassificationBranch(kernelPool(),owner,'ML',{routingScope:{documentIds:[a.id]}})).documentIds,[a.id]);
 assert.deepEqual((await planClassificationBranch(kernelPool(),'foreign:'+owner,'ML',{})).documentIds,[]);
 // A new, not-yet-imported proposal must fail after a vocabulary revision;
 // an already imported exact historical response remains replayable.
 const pending=await kernel.prepareDocumentTopics(owner,b.id);assert.equal(pending.status,'ready');if(pending.status!=='ready')return;
 const second=await kernel.recordContentTaxonomy(owner,{previousId:first.id,entries:entries.map(e=>({...e,aliases:e.aliases.filter(a=>a!=='ML')}))},'fixture-admin','Withdraw ambiguous alias');
 await assert.rejects(kernel.importDocumentTopics(owner,pending.packet,raw(pending.packet,['machine-learning']),'fixture-admin','Stale scripted proposal'),/vocabulary or correction head changed/);
 assert.equal((await kernel.importDocumentTopics(owner,ready.packet,rawA,'fixture-admin','Explicit scripted response fixture')).replayed,true);
 assert.equal((await planClassificationBranch(kernelPool(),owner,'ML',{})).status,'broad');
 const correction=await kernel.recordDocumentClassification(owner,{documentId:a.id,versionId:row.version_id,sourceVersionId:row.source_version_id,sourceHash:a.hash,
  classifierId:row.classifier_id,producerVersion:'manual-v1',method:'manual',model:null,previousId:row.id,tags:[]},'fixture-admin','Withdraw model topic assignment');
 const replay=await kernel.importDocumentTopics(owner,ready.packet,rawA,'fixture-admin','Explicit scripted response fixture');assert.equal(replay.current,false);
 assert.equal((await kernel.documentClassifications(owner,a.id))[0].id,correction.id);assert.equal((await kernel.prepareDocumentTopics(owner,a.id)).status,'unavailable');
 const withdrawn=await kernel.recordContentTaxonomy(owner,{previousId:second.id,entries:[]},'fixture-admin','Withdraw registry labels');
 assert.equal((await kernel.recordContentTaxonomy(owner,input,'fixture-admin','Initialize approved subjects and aliases')).current,false);
 assert.equal((await kernel.contentTaxonomy(owner))!.revisionId,withdrawn.id);
 const c=await add('remaining','Outside-subject notes remain searchable.');
 const empty=await kernel.prepareDocumentTopics(owner,c.id);assert.equal(empty.status,'unavailable');if(empty.status==='unavailable')assert.equal(empty.reason,'empty-registered-vocabulary');
 assert.equal((await planClassificationBranch(kernelPool(),owner,'likelihood',{})).status,'broad','Withdrawn catalog must not revive old literal topic narrowing');
 const broad=await kernel.searchDocumentText(owner,'outside subject',{semantic:false,hybrid:false,aiRerank:false,relatedDocuments:false,refineAdjacent:false});
 assert.deepEqual(broad.map(h=>h.document_id),[c.id],'Catalog withdrawal does not delete or hide original content');
});
test('competing first taxonomy writers serialize instead of overwriting an absent head',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const owner='registry-race:'+randomUUID(),results=await Promise.allSettled(['first','second'].map(reason=>kernel.recordContentTaxonomy(owner,{previousId:null,entries},'fixture-admin',reason)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.equal(Number((await kernelPool().query('SELECT count(*) n FROM content_taxonomy_revisions WHERE owner_id=$1',[owner])).rows[0].n),1);
});
test('fresh classification import retains its vocabulary lock until the short transaction commits',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const owner='registry-import-lock:'+randomUUID(),id=hash(owner),text='Calculus studies integrals.';
 await kernel.recordContentTaxonomy(owner,{previousId:null,entries:[{facet:'topic',key:'calculus',aliases:[]}]},'fixture-admin','Initialize lock fixture');
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:'Notes.txt',hash:hash(text),origin:'upload',originKey:owner,mime:'text/plain'},
  [{pageNumber:1,locator:'page 1',text}],{parserVersion:'registry-lock-fixture-v1'});
 const prepared=await kernel.prepareDocumentTopics(owner,id);assert.equal(prepared.status,'ready');if(prepared.status!=='ready')return;
 const raw=JSON.stringify({status:'completed',model:'gpt-5.4-mini',usage:{input_tokens:1,output_tokens:1},
  output_text:JSON.stringify({labels:[{labelId:prepared.packet.labels[0].id,quoteUnitId:prepared.packet.quoteUnits[0].id}]})});
 const writer=await kernelPool().connect(),observer=await kernelPool().connect();
 try{
  await writer.query('BEGIN');await observer.query('BEGIN');
  await importControlledTopics(writer,owner,prepared.packet,raw,'fixture-admin','Explicit scripted import lock fixture');
  const attempt=()=>observer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',['content-taxonomy:'+owner]);
  assert.equal((await attempt()).rows[0].acquired,false,'A taxonomy edit cannot pass the fresh import before its commit');
  await writer.query('COMMIT');assert.equal((await attempt()).rows[0].acquired,true,'Import must release the lock at commit');
 }finally{await writer.query('ROLLBACK');await observer.query('ROLLBACK');writer.release();observer.release();}
});
