import{test,after}from'node:test';import assert from'node:assert/strict';import{randomUUID,createHash}from'node:crypto';
import{kernel}from'../lib/kernel/service.ts';import{kernelPool,migrateKernel}from'../lib/kernel/db.ts';
import{validateDocumentQuestionNameRequest,DocumentNameBindingError}from'../lib/kernel/document-name-binding.ts';
let fetches=0;globalThis.fetch=async()=>{fetches++;throw Error('Name binding fixture forbids fetch');};
after(async()=>{try{assert.equal(fetches,0);}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}});
const sha=(v:string)=>createHash('sha256').update(v).digest('hex'),span=(body:string,text:string,start=0)=>{
 const at=body.indexOf(text,start);assert.ok(at>=0);return{startUtf16:at,endUtf16:at+text.length,text};};

test('question name spans cannot be rewritten, extended, split across Unicode characters or granted authority',()=>{
 const q='Compare 😀 Method A.',base={role:'comparator',questionName:span(q,'Method A'),candidate:{evidenceId:'e',span:span('Method A','Method A')}};
 assert.deepEqual(validateDocumentQuestionNameRequest(q,base),base);
 for(const value of[{...base,semanticIdentityVerified:true},{...base,questionName:{...base.questionName,text:'Method B'}},
  {...base,questionName:{startUtf16:8,endUtf16:9,text:q.slice(8,9)}},{...base,definition:null}])assert.throws(()=>validateDocumentQuestionNameRequest(q,value),DocumentNameBindingError);
});

test('Kernel binds current source-name observations, local declared aliases and unresolved comparators without global merging',{skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const uid=randomUUID(),owner='name-owner:'+uid,id=sha(uid),body='Expectation Maximization (EM) is described here. A different later use of EM is not rebound. Baseline Local Search is a separate named method. EM+Prune is another written name. A fused xExpectation Maximization (EM) is ambiguous.',
  doc={id,ownerId:owner,courseId:'',name:'Source.txt',hash:sha('raw'+uid),mime:'text/plain',origin:'upload',originKey:uid},parser={parserVersion:'name-fixture-plain-text-v1',extractionMethod:'plain-text'};
 await kernel.ingestParsedDocument(doc,[{locator:'page 1',pageNumber:1,text:body}],parser);
 const sourceRow=(await kernelPool().query('SELECT d.current_version_id,v.source_version_id,p.evidence_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id JOIN document_text_pages p ON p.version_id=v.id WHERE d.id=$1',[id])).rows[0],
  source={documentId:id,currentVersionId:sourceRow.current_version_id,sourceVersionId:sourceRow.source_version_id,sourceHash:doc.hash,courseId:''},
  evidenceId=sourceRow.evidence_id,definition={evidenceId,longName:span(body,'Expectation Maximization'),shortName:span(body,'EM')};
 const bind=(q:string,requested:string,label:string,extra:Record<string,unknown>={})=>kernel.bindDocumentQuestionName(owner,source,q,
  {role:'comparator',questionName:span(q,requested),candidate:{evidenceId,span:span(body,label)},...extra});
 const literal=await bind('Compare Baseline Local Search.','Baseline Local Search','Baseline Local Search');
 assert.equal(literal.status,'observed-literal');assert.equal(literal.sourceLabel.bodySha256,sha(body));assert.equal(literal.semanticIdentityVerified,false);
 assert.equal(literal.globalEntityMergeAuthorized,false);assert.equal(literal.unknownProvesUnanswerable,false);
 const q='Describe Expectation Maximization.',alias=await bind(q,'Expectation Maximization','EM',{definition});
 assert.equal(alias.status,'observed-initialism');assert.deepEqual(alias.definition,{evidenceId,bodySha256:sha(body),longName:definition.longName,shortName:definition.shortName});
 assert.equal((await bind('Describe EM.','EM','Expectation Maximization',{definition})).status,'observed-initialism');
 assert.equal((await bind('Compare simple EM algorithm.','simple EM algorithm','Baseline Local Search',{definition})).status,'unresolved');
 assert.equal((await bind('Describe simple EM.','simple EM','EM',{definition})).status,'unresolved','Do not discard the simple qualifier');
 assert.equal((await bind('Describe em.','em','EM')).status,'unresolved','Do not case-fold identifiers');
 const shortQuestion='Describe EM.',compound=span(body,'EM',body.indexOf('EM+Prune'));
 assert.equal((await kernel.bindDocumentQuestionName(owner,source,shortQuestion,{role:'comparator',questionName:span(shortQuestion,'EM'),candidate:{evidenceId,span:compound}})).status,'unresolved','A prefix of a compound source name is not an independent name');
 assert.equal((await bind('Describe EM+Prune.','EM','EM')).status,'unresolved','A query name prefix must not stand in for the whole requested compound');
 assert.equal((await bind('Describe EM+Prune.','EM+Prune','EM+Prune')).status,'observed-literal');
 const later=span(body,'EM',definition.shortName.endUtf16),late=await kernel.bindDocumentQuestionName(owner,source,q,
  {role:'comparator',questionName:span(q,'Expectation Maximization'),candidate:{evidenceId,span:later},definition});
 assert.equal(late.status,'unresolved','A definition is not permission to merge a later occurrence');
 const cooccurs=await bind(q,'Expectation Maximization','Baseline Local Search',{definition:{...definition,shortName:span(body,'Baseline Local Search')}});
 assert.equal(cooccurs.status,'unresolved');
 const fusedLong=span(body,'Expectation Maximization',body.indexOf('xExpectation')),fusedShort=span(body,'EM',fusedLong.endUtf16);
 const fused=await kernel.bindDocumentQuestionName(owner,source,q,{role:'comparator',questionName:span(q,'Expectation Maximization'),
  candidate:{evidenceId,span:fusedShort},definition:{evidenceId,longName:fusedLong,shortName:fusedShort}});
 assert.equal(fused.status,'unresolved','Do not manufacture a long-form boundary when extraction has fused adjoining text');
 const again=await bind(q,'Expectation Maximization','EM',{definition});assert.equal(again.observationSha256,alias.observationSha256);
 const request={role:'comparator',questionName:span(q,'Expectation Maximization'),candidate:{evidenceId,span:{...span(body,'EM'),text:'XY'}}};
 await assert.rejects(kernel.bindDocumentQuestionName(owner,source,q,request),DocumentNameBindingError);
 await assert.rejects(kernel.bindDocumentQuestionName('foreign-owner',source,q,{role:'comparator',questionName:span(q,'Expectation Maximization'),candidate:{evidenceId,span:span(body,'EM')}}));
 await kernel.ingestParsedDocument(doc,[{locator:'page 1',pageNumber:1,text:body+' New source version.'}],parser);
 await assert.rejects(bind(q,'Expectation Maximization','EM',{definition}),/no longer current/);
 assert.equal((await kernelPool().query('SELECT count(*)::int n FROM document_text_versions WHERE document_id=$1',[id])).rows[0].n,2);
});
