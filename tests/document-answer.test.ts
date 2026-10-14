import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareDocumentAnswer,validateGroundedDocumentAnswer,synthesizeDocumentAnswer,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'document-answer-empty-vault-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-local-test-never-sent';process.env.AI_BUDGET_TEST_BYPASS='false';
process.env.AI_MONTHLY_BUDGET='5';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const source={documentId:'doc',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:'source-hash'};
const body='The experiment uses two samples.\nThe result remains preliminary.';
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,images:[],parents:[],anchors:[{
 id:'pg:version:1',document_id:'doc',course_id:'course',name:'Original source',origin:'source',origin_key:'source-key',
 source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:'section:0:paragraph:0',page_number:1,
 evidence_id:'evidence',parser_version:'native-unverified',score:1,evidence_body:'full-page',parser_warnings:['Formula fidelity unverified.']} ]};}
const answer={status:'answered',message:'',claims:[{text:'The study uses two samples.',citations:[{id:'e0',quote:'uses two samples.'}]}]};

test('answers require supplied evidence and reject invented quotes and unreferenced claims',()=>{
 const prepared=prepareDocumentAnswer('How many samples?',context());
 assert.deepEqual(validateGroundedDocumentAnswer(answer,prepared.supports),answer);
 for(const changed of [
  {...answer,claims:[{text:'Three samples.',citations:[{id:'e0',quote:'three samples'}]}]},
  {...answer,claims:[{text:'Two samples.',citations:[{id:'outside-source',quote:'two samples'}]}]},
  {...answer,claims:[{text:'Two samples.',citations:[]}]},
  {...answer,message:'Unreferenced additional facts.'},
  {...answer,extra:'unexpected'}])assert.throws(()=>validateGroundedDocumentAnswer(changed,prepared.supports));
 const declined={status:'insufficient-evidence',message:'No outcome is supplied.',claims:[]};
 assert.deepEqual(validateGroundedDocumentAnswer(declined,prepared.supports),declined);
 assert.throws(()=>validateGroundedDocumentAnswer({...declined,claims:answer.claims},prepared.supports));
 assert.throws(()=>validateGroundedDocumentAnswer({...answer,status:'conflicting-evidence'},prepared.supports));
});

test('a complete parent preserves evidence identities and refuses snippets, truncated parents or changed bodies',()=>{
 const c=context();const node={documentId:'doc',documentVersionId:'version',sourceVersionId:source.sourceVersionId,
  sourceHash:source.sourceHash,evidenceId:'evidence',locator:c.anchors[0].locator,body,bodySha256:hash(body)};
 c.parents=[{parentId:'section-0',status:'available',sourceNodeCount:1,sourceBodyCodepoints:Array.from(body).length,nodes:[node]}];
 assert.equal(prepareDocumentAnswer('What is the result?',c).supports.length,1);
 c.anchors[0].evidence_body=undefined;assert.throws(()=>prepareDocumentAnswer('What?',c),/not snippets/);
 c.anchors[0].evidence_body='full-page';c.parents[0].sourceNodeCount=2;
 assert.throws(()=>prepareDocumentAnswer('What?',c),/incomplete/);
 c.parents[0].sourceNodeCount=1;node.documentVersionId='changed';
 assert.throws(()=>prepareDocumentAnswer('What?',c),/Conflicting/);
});

test('actual PNG bytes are bound to image citations; captions cannot impersonate pixels',()=>{
 // Complete, small public-domain test PNG, not merely a caption or an IHDR stub.
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
 const c=context(),sha=hash(bytes);
 c.images=[{attachmentId:'attachment',assetId:sha,captionEvidenceId:'caption',sha256:sha,byteLength:bytes.length,
  width:1,height:1,mime:'image/png',bytes,source}];
 const prepared=prepareDocumentAnswer('What does the figure show?',c);
 const illustrated={status:'answered',message:'',claims:[{text:'The supplied figure is one pixel.',citations:[{id:'i0',quote:''}]}]};
 assert.deepEqual(validateGroundedDocumentAnswer(illustrated,prepared.supports),illustrated);
 assert.throws(()=>validateGroundedDocumentAnswer({...illustrated,claims:[{text:'A figure.',citations:[{id:'i0',quote:'invented OCR'}]}]},prepared.supports));
 c.images[0].bytes=Buffer.from('only a caption');assert.throws(()=>prepareDocumentAnswer('What?',c),/checksum/);
});

test('answer fingerprints preserve version, parsing warnings and unavailable context',()=>{
 const c=context(),original=prepareDocumentAnswer('What?',c).fingerprint;
 c.anchors[0].id='pg:new-version:1';assert.notEqual(prepareDocumentAnswer('What?',c).fingerprint,original);
 c.anchors[0].id='pg:version:1';c.parents=[{parentId:'large-section',status:'unavailable-size-exceeds-8192',
  sourceNodeCount:20,sourceBodyCodepoints:9000,nodes:[]}];
 const prepared=prepareDocumentAnswer('What?',c);
 assert.notEqual(prepared.fingerprint,original);assert.equal(prepared.supports.length,1);
 assert.deepEqual(prepared.warnings,['Formula fidelity unverified.']);assert.equal(prepared.unavailableParents.length,1);
});

test('synthesis revalidates current sources, rejects incomplete output and makes no paid repair request',async()=>{
 const original=globalThis.fetch;let calls=0,reads=0,attempts=0;
 globalThis.fetch=async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body));
  assert.equal(request.model,'gpt-5-mini');assert.equal(request.store,false);
  assert.equal(request.reasoning.effort,'low');assert.equal(request.max_output_tokens,4000);
  assert.match(request.input[0].content,/untrusted data/);
  assert.match(request.input[0].content,/canonical Kernel facts/);
  return Response.json({status:'completed',output_text:JSON.stringify(answer),usage:{input_tokens:100,output_tokens:100}});
 };
 try{
  const result=await synthesizeDocumentAnswer('How many samples?',async()=>{reads++;return context();},
   {beforeAttempt:async()=>{attempts++;}});
  assert.equal(result.answer.status,'answered');assert.equal(result.model,'gpt-5-mini');
  assert.equal(reads,2);assert.equal(attempts,1);assert.equal(calls,1);
  reads=0;
  await assert.rejects(synthesizeDocumentAnswer('How many samples?',async()=>{
   const c=context();if(++reads===2)c.anchors[0].id='pg:changed:1';return c;
  }),/evidence changed/);
  assert.equal(calls,2);assert.equal(reads,2);
  globalThis.fetch=async()=>{calls++;return Response.json({status:'incomplete',output_text:JSON.stringify(answer)});};
  await assert.rejects(synthesizeDocumentAnswer('How many samples?',async()=>context()),/incomplete/);
  assert.equal(calls,3,'incomplete or stale evidence never triggers an automatic paid retry');
 }finally{globalThis.fetch=original;}
});
