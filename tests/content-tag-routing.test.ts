import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {contentTagQueryPlan,contentTagRoutingMode,orderMetadataTaggedCandidates,routeDocumentContentTagCandidates,contentTagAnswerObservation} from '../lib/kernel/content-tag-routing.ts';
import {prepareDocumentAnswer,buildDocumentAnswerRequest,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {classifyContentMetadata} from '../lib/kernel/content-tags.ts';
import {kernelPool,migrateKernel} from '../lib/kernel/db.ts';
import {kernel} from '../lib/kernel/service.ts';

let externalCalls=0;
globalThis.fetch=async()=>{externalCalls++;throw Error('Metadata routing tests forbid external calls');};
after(async()=>{assert.equal(externalCalls,0);if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});
const candidate=(id:string,index=1)=>({document_id:id,page_number:index,source_version_id:'v:'+id,evidence_id:'e:'+id+index,source_hash:'h:'+id,body:'Unchanged evidence',score:10});
const metadata={courseId:null,termId:null,origin:'canvas',originKey:'announcement:1',name:'Syllabus.pdf',mime:'application/pdf'};
function snapshot(id='snapshot'){
 const c=classifyContentMetadata(metadata);
 return {id,metadata,tags:c.tags,classification_sha256:c.classificationSha256};
}
async function enabled<T>(work:()=>Promise<T>){
 const saved=process.env.KERNEL_CONTENT_TAG_ROUTING;process.env.KERNEL_CONTENT_TAG_ROUTING='metadata-priority-v1';
 try{return await work();}finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=saved;}
}

test('controlled aliases keep exact original positions, mixed sources and unknown topics without authorizing filters',()=>{
 const question='🙂 Quercus 课程大纲、Piazza讨论与邮件，compare the gravitational model',p=contentTagQueryPlan(question);
 assert.ok(p.hints.some(h=>h.facet==='source'&&h.key==='canvas'));
 assert.ok(p.hints.some(h=>h.facet==='source'&&h.key==='piazza'));
 assert.ok(p.hints.some(h=>h.facet==='source'&&h.key==='gmail'));
 assert.ok(p.hints.some(h=>h.facet==='document_type'&&h.key==='syllabus'));
 assert.ok(p.hints.every(h=>question.slice(h.start,h.end)===h.alias));
 assert.equal(p.filterAuthorization,false);assert.deepEqual(contentTagQueryPlan(question),p);
 assert.deepEqual(contentTagQueryPlan('How is gravitational force defined?').hints,[]);
 assert.deepEqual(contentTagQueryPlan('canvaswork emailer syllabuses').hints,[]);
 assert.equal(contentTagQueryPlan('not a syllabus; use slides').filterAuthorization,false,'negation does not become a hard filter');
 const saved=process.env.KERNEL_CONTENT_TAG_ROUTING;
 try{delete process.env.KERNEL_CONTENT_TAG_ROUTING;assert.equal(contentTagRoutingMode(),'off');
  process.env.KERNEL_CONTENT_TAG_ROUTING='true';assert.throws(contentTagRoutingMode,/Invalid KERNEL_CONTENT_TAG_ROUTING/);
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=saved;}
});

test('soft priority retains every original candidate and evidence, bounds movement and keeps unknown or wrong tags',()=>{
 const hits=Array.from({length:18},(_,i)=>candidate(String(i))),before=structuredClone(hits),plan=contentTagQueryPlan('course outline'),
  observations=new Map(hits.map((h,i)=>[h.document_id,{matches:i===7||i===17?[{facet:'document_type' as const,key:'syllabus',tagId:'tag:fixture'}]:[],
   snapshotIds:i===2?[]:['snapshot:'+i],reason:i===2?'no-current-tags' as const:i===7||i===17?'matching-current-tags' as const:'no-matching-tags' as const}])),
  result=orderMetadataTaggedCandidates(hits,observations,plan);
 assert.deepEqual(hits,before);assert.equal(result.length,18);assert.equal(result[0].document_id,'7');
 assert.equal(result[16].document_id,'17');
 assert.deepEqual(result.map(h=>h.document_id).sort(),hits.map(h=>h.document_id).sort());
 for(const h of result){const {content_tag_routing:r,...original}=h;
  assert.deepEqual(original,hits.find(x=>x.document_id===h.document_id));
  assert.ok(Math.abs(r.originalRank-r.finalRank)<=7);assert.equal(r.candidateCount,18);assert.equal(r.semanticVerified,false);
  assert.equal(r.filterAuthorization,false);
 }
 assert.equal(new Set(result.map(h=>h.content_tag_routing.candidateSetSha256)).size,1);
 assert.throws(()=>orderMetadataTaggedCandidates([hits[0],hits[0]],observations,plan),/candidate pool/);
});

test('default off and queries without aliases do no tag SQL; source drift rejects instead of trusting tag identities',async()=>{
 const hits=[candidate('a')],pool={query:async()=>{throw Error('Unexpected metadata SQL');}} as unknown as Pool;
 const saved=process.env.KERNEL_CONTENT_TAG_ROUTING;
 try{delete process.env.KERNEL_CONTENT_TAG_ROUTING;assert.equal(await routeDocumentContentTagCandidates(pool,'owner','syllabus',hits),hits);}
 finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAG_ROUTING;else process.env.KERNEL_CONTENT_TAG_ROUTING=saved;}
 await enabled(async()=>{
  assert.equal(await routeDocumentContentTagCandidates(pool,'owner','gravitational force',hits),hits);
  for(const rows of [[],[{...hits[0],source_hash:'changed',tag_sets:[snapshot()]}]]){
   await assert.rejects(routeDocumentContentTagCandidates({query:async()=>({rows})} as unknown as Pool,'owner','syllabus',hits),/changed|stale/i);
  }
 });
});

test('answer diagnostics identify only observed anchors and never change provider input or claim full-pool coverage',()=>{
 const hits=Array.from({length:12},(_,i)=>({...candidate(String(i)),id:'pg:version:'+i})),p=contentTagQueryPlan('syllabus'),
  observations=new Map(hits.map(h=>[h.document_id,{matches:[],snapshotIds:[],reason:'no-current-tags' as const}])),
  routed=orderMetadataTaggedCandidates(hits,observations,p),subset=[routed[0],routed[1],hits[2]],receipt=contentTagAnswerObservation(subset)!;
 assert.equal(contentTagAnswerObservation(hits),undefined);assert.equal(receipt.observedAnchors,3);
 assert.equal(receipt.routedAnchors,2);assert.equal(receipt.unroutedAnchors,1);assert.equal(receipt.pools[0].candidateCount,12);
 assert.equal(receipt.pools[0].observedAnchors,2);assert.equal(receipt.eligibleCorpusDocuments,null);assert.equal(receipt.scoredDocuments,null);
 assert.equal(receipt.semanticVerified,false);assert.equal(receipt.answerCorrectness,'unassessed');
 assert.equal(receipt.anchors[0].sourceHash,hits[0].source_hash);
 receipt.anchors[0].receipt.snapshotIds.push('changed diagnostic copy');assert.deepEqual(routed[0].content_tag_routing.snapshotIds,[]);
 const base={...hits[0],id:'pg:version:1',evidence_body:'full-page' as const,course_id:'',name:'Original notes',origin:'canvas',origin_key:'file:1',locator:'page 1',parser_version:'fixture'},
  context:DocumentAnswerContext={anchors:[base],parents:[],images:[],sourceContentIsUntrusted:true},
  tagged:DocumentAnswerContext={...context,anchors:[{...base,content_tag_routing:routed[0].content_tag_routing}]},
  settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000};
 assert.deepEqual(prepareDocumentAnswer('Explain gravity',context),prepareDocumentAnswer('Explain gravity',tagged));
 assert.deepEqual(buildDocumentAnswerRequest(prepareDocumentAnswer('Explain gravity',context),settings),
  buildDocumentAnswerRequest(prepareDocumentAnswer('Explain gravity',tagged),settings));
});

test('incompatible or disagreeing current snapshots disable priority, with JSONB key order tolerated',async()=>enabled(async()=>{
 const hits=['a','b','c','d'].map(id=>candidate(id)),s=snapshot(),reordered=JSON.parse(JSON.stringify(s.tags),(_key,v)=>
  v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).reverse()):v),
  other=classifyContentMetadata({...metadata,name:'Lecture Notes.pdf',originKey:'file:9'}),
  rows=[{...hits[0],tag_sets:[]},{...hits[1],tag_sets:[{...s,tags:reordered}]},
   {...hits[2],tag_sets:[{...s,classification_sha256:'invalid'}]},
   {...hits[3],tag_sets:[s,{id:'other',metadata:other.metadata,tags:other.tags,classification_sha256:other.classificationSha256}]}],
  pool={query:async()=>({rows})} as unknown as Pool,
  result=await routeDocumentContentTagCandidates(pool,'owner','syllabus',hits) as Array<typeof hits[number]&{content_tag_routing:any}>;
 assert.equal(result[0].document_id,'b');
 assert.equal(result.find(h=>h.document_id==='a')!.content_tag_routing.reason,'no-current-tags');
 assert.equal(result.find(h=>h.document_id==='c')!.content_tag_routing.reason,'invalid-or-incompatible-tags');
 assert.deepEqual(result.find(h=>h.document_id==='d')!.content_tag_routing.matches,[],'no winner is elected across disagreeing revisions');
}));

test('shared Kernel search consumes current ingestion tags without losing other sources or explicit scope',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>enabled(async()=>{
 await migrateKernel();const uid=randomUUID(),owner='tag-route:'+uid,course='tag-route-course:'+uid,
  saved=process.env.KERNEL_CONTENT_TAGS;
 try{
  process.env.KERNEL_CONTENT_TAGS='metadata-v1';
  await kernel.upsertCourse({id:course,name:'Routing test course',course_code:'ROUTE101'});
  const docs=[['a','canvas','file:a','Lecture Notes.pdf'],['b','gmail','body:b','Mail.txt'],
   ['c','piazza','post:c','Lab clarification.txt'],['d','canvas','file:d','Syllabus.pdf']];
  for(const [suffix,origin,originKey,name]of docs)await kernel.ingestParsedDocument({id:owner+suffix,ownerId:owner,courseId:course,
   name,hash:uid+suffix,mime:'text/plain',origin,originKey},[{pageNumber:1,locator:'page 1',text:'Gravity acts on massive objects.'}],{parserVersion:'tag-route-fixture'});
  const query='课程大纲 gravity',options={limit:20,hybrid:false,aiRerank:false,semantic:false};
  process.env.KERNEL_CONTENT_TAG_ROUTING='off';const before=await kernel.searchDocumentText(owner,query,options);
  process.env.KERNEL_CONTENT_TAG_ROUTING='metadata-priority-v1';const after=await kernel.searchDocumentText(owner,query,options);
  assert.equal(before.length,4);assert.equal(after.length,4);
  assert.equal(after[0].document_id,owner+'d');assert.notEqual(before[0].document_id,after[0].document_id);
  assert.deepEqual(after.map(h=>h.document_id).sort(),before.map(h=>h.document_id).sort());
  for(const hit of after){const {content_tag_routing:_route,...original}=hit;
   assert.deepEqual(original,before.find(b=>b.document_id===hit.document_id),'routing must not rewrite source evidence or scores');}
  assert.ok(after.every(h=>h.content_tag_routing?.filterAuthorization===false));
  assert.deepEqual(await kernel.searchDocumentText('foreign:'+owner,query,options),[]);
  const restricted=await kernel.searchDocumentText(owner,query,{...options,routingScope:{documentIds:[owner+'b']}});
  assert.deepEqual(restricted.map(h=>h.document_id),[owner+'b']);
  // A later parse keeps old snapshots but its missing current tags cannot
  // inherit the old classification or disappear from the search pool.
  process.env.KERNEL_CONTENT_TAGS='off';
  await kernel.ingestParsedDocument({id:owner+'d',ownerId:owner,courseId:course,name:'Syllabus.pdf',hash:uid+'d',
   mime:'text/plain',origin:'canvas',originKey:'file:d'},[{pageNumber:1,locator:'page 1',text:'Gravity acts on massive objects. Revised.'}],{parserVersion:'tag-route-fixture-v2'});
  const changed=await kernel.searchDocumentText(owner,query,options),current=changed.find(h=>h.document_id===owner+'d')!;
  assert.equal(changed.length,4);assert.equal(current.content_tag_routing?.reason,'no-current-tags');
  assert.equal(externalCalls,0);
 }finally{if(saved===undefined)delete process.env.KERNEL_CONTENT_TAGS;else process.env.KERNEL_CONTENT_TAGS=saved;}
}));
