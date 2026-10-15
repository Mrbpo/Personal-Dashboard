import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {prepareDocumentAnswer,validateGroundedDocumentAnswer,resolveGroundedDocumentAnswerReferences,synthesizeDocumentAnswer,DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE,type DocumentAnswerContext} from '../lib/kernel/document-answer.ts';
import {kernel} from '../lib/kernel/service.ts';
import {migrateKernel,kernelPool} from '../lib/kernel/db.ts';
import {after} from 'node:test';

process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'document-answer-empty-vault-'+randomUUID());
process.env.OPENAI_API_KEY='dummy-local-test-never-sent';process.env.AI_BUDGET_TEST_BYPASS='false';
process.env.AI_MONTHLY_BUDGET='5';
after(async()=>{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();});

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const source={documentId:'doc',currentVersionId:'version',sourceVersionId:'source-version',sourceHash:'source-hash'};
const body='The experiment uses two samples.\nThe result remains preliminary.';
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,images:[],parents:[],anchors:[{
 id:'pg:version:1',document_id:'doc',course_id:'course',name:'Original source',origin:'source',origin_key:'source-key',
 source_hash:source.sourceHash,source_version_id:source.sourceVersionId,body,locator:'section:0:paragraph:0',page_number:1,
 evidence_id:'evidence',parser_version:'native-unverified',score:1,evidence_body:'full-page',parser_warnings:['Formula fidelity unverified.']} ]};}
const answer={status:'answered',message:'',claims:[{text:'The study uses two samples.',citations:[{id:'e0',quote:'uses two samples.'}]}]};

test('unique existing text reference repair preserves raw data and strict final rejection boundaries',()=>{
 const c=context();c.anchors.push({...c.anchors[0],id:'pg:version:2',page_number:2,evidence_id:'second-evidence',
  locator:'section:1:paragraph:0',body:'A uniquely supported result.'});
 const prepared=prepareDocumentAnswer('What result is supplied?',c),supports=[...prepared.supports,
  {...prepared.supports[0],id:'i0',kind:'image' as const,text:undefined}];
 const quote='uniquely  supported\nresult.',raw={status:'answered',message:'',claims:[{
  text:'The source reports this result.',citations:[{id:'e0',quote}]}]},before=JSON.stringify(raw);
 assert.throws(()=>validateGroundedDocumentAnswer(raw,supports));
 const result=resolveGroundedDocumentAnswerReferences(raw,supports);
 assert.deepEqual(result.answer,{...raw,claims:[{...raw.claims[0],citations:[{id:'e1',quote}]}]});
 assert.equal(JSON.stringify(raw),before,'never mutate the original provider object');
 assert.equal(result.citationRepairs.length,1);const repair=result.citationRepairs[0];
 assert.deepEqual([repair.claimIndex,repair.citationIndex,repair.originalSupportId,repair.resolvedSupportId],[0,0,'e0','e1']);
 assert.equal(repair.originalEvidence.evidenceId,'evidence');assert.equal(repair.resolvedEvidence.evidenceId,'second-evidence');
 assert.equal(repair.resolvedEvidence.sourceVersionId,source.sourceVersionId);assert.equal(repair.reason,'unique-exact-text-match');
 assert.equal(repair.quoteSha256,hash('uniquely supported result.'));
 assert.deepEqual(validateGroundedDocumentAnswer(result.answer,supports),result.answer);
 const changed=(id:string,quote:string)=>({...raw,claims:[{...raw.claims[0],citations:[{id,quote}]}]});
 for(const invalid of [changed('outside',quote),changed('i0',quote),changed('e0',''),
  changed('e0','a uniquely supported result.'),changed('e0','"uniquely supported result."'),
  {...raw,extra:true},{...raw,claims:[{...raw.claims[0],citations:[{id:'e0',quote,extra:true}]}]},
  {...raw,claims:[{...raw.claims[0],citations:[{id:'e0',quote},{id:'e1',quote}]}]},
  {...raw,status:'conflicting-evidence',claims:[raw.claims[0],{text:'Another claim.',citations:[{id:'e1',quote}]}]}])
  assert.throws(()=>resolveGroundedDocumentAnswerReferences(invalid,supports));
 assert.throws(()=>resolveGroundedDocumentAnswerReferences(raw,[...supports,{...prepared.supports[1],id:'e2'}]),
  'multiple exact text matches are ambiguous');
 assert.deepEqual(resolveGroundedDocumentAnswerReferences(answer,supports).citationRepairs,[]);
 assert.equal(JSON.stringify(raw),before);
});

test('insufficient evidence returns only a neutral status while preserving strict output shapes',()=>{
 const prepared=prepareDocumentAnswer('What is the outcome?',context());
 const raw={status:'insufficient-evidence',message:'The paper never mentions any samples or outcomes.',claims:[]};
 const validated=validateGroundedDocumentAnswer(raw,prepared.supports);
 assert.equal(validated.message,'I cannot provide a sufficiently supported answer.');
 assert.equal(validated.status,'insufficient-evidence');assert.deepEqual(validated.claims,[]);
 assert.equal(raw.message,'The paper never mentions any samples or outcomes.','raw provider data remains unchanged');
 for(const changed of [{...raw,message:''},{...raw,message:'  '},{...raw,message:null},
  {...raw,message:'x'.repeat(3001)},{...raw,claims:answer.claims},
  {...answer,message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE},
  {...answer,status:'conflicting-evidence',message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE},
  {...answer,claims:[{text:'A result.',citations:[{id:'e0',quote:'a conclusive result'}]}]}])
  assert.throws(()=>validateGroundedDocumentAnswer(changed,prepared.supports));
 assert.deepEqual(validateGroundedDocumentAnswer(answer,prepared.supports),answer);
});

test('one statement may cite distinct actual quotes from the same evidence without duplicating a citation',()=>{
 const prepared=prepareDocumentAnswer('What was measured and how certain is the result?',context());
 const combined={status:'answered',message:'',claims:[{text:'Two samples were used and the result is preliminary.',citations:[
  {id:'e0',quote:'uses two samples.'},{id:'e0',quote:'The result remains preliminary.'}]}]};
 assert.deepEqual(validateGroundedDocumentAnswer(combined,prepared.supports),combined);
 for(const quote of ['uses two samples.','uses  two samples.','a conclusive result'])
  assert.throws(()=>validateGroundedDocumentAnswer({...combined,claims:[{...combined.claims[0],citations:[
   combined.claims[0].citations[0],{id:'e0',quote}]}]},prepared.supports));
 const duplicateImage={status:'answered',message:'',claims:[{text:'A supplied image.',citations:[
  {id:'i0',quote:''},{id:'i0',quote:''}]}]};
 assert.throws(()=>validateGroundedDocumentAnswer(duplicateImage,[{id:'i0',kind:'image'}]));
 assert.throws(()=>validateGroundedDocumentAnswer({...combined,status:'conflicting-evidence',claims:[
  combined.claims[0],{text:'A second statement.',citations:[combined.claims[0].citations[1]]}]},prepared.supports));
});

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
 assert.deepEqual(validateGroundedDocumentAnswer(declined,prepared.supports),{...declined,message:DOCUMENT_ANSWER_INSUFFICIENT_MESSAGE});
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
  return Response.json({status:'completed',model:'gpt-5-mini',output_text:JSON.stringify(answer),usage:{input_tokens:100,output_tokens:100}});
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

test('development answers reject a provider model mismatch and never label mini as Astra',async()=>{
 const names=['KERNEL_ADMIN_DEVELOPMENT_RUN','KERNEL_DATABASE_URL','DATABASE_URL','AI_MODEL_RATES'] as const;
 const saved=Object.fromEntries(names.map(name=>[name,process.env[name]])),original=globalThis.fetch;
 let calls=0,attempts=0;
 try{
  process.env.KERNEL_ADMIN_DEVELOPMENT_RUN='true';process.env.KERNEL_DATABASE_URL='postgresql://localhost/pdf_acceptance_20261006';
  process.env.DATABASE_URL='file:/pdf-data/benchmark.sqlite';
  process.env.AI_MODEL_RATES=JSON.stringify({'gpt-6-astra':{input:10,output:50,context:1050000}});
  globalThis.fetch=async()=>{calls++;return Response.json({status:'completed',model:'gpt-5-mini',
   output_text:JSON.stringify(answer),usage:{input_tokens:100,output_tokens:100}});};
  await assert.rejects(synthesizeDocumentAnswer('How many samples?',async()=>context(),{
   scope:'development',model:'gpt-6-astra',reasoningEffort:'high',maxOutputTokens:16384,timeoutMs:120000,
   beforeAttempt:async()=>{attempts++;}}),/different or unverified model/);
  assert.equal(calls,1);assert.equal(attempts,1);
 }finally{globalThis.fetch=original;for(const name of names){if(saved[name]===undefined)delete process.env[name];else process.env[name]=saved[name];}}
});

test('Kernel study answers use actual PG parent/image evidence and refuse sources hidden during generation',
 {skip:!process.env.KERNEL_DATABASE_URL},async()=>{
 await migrateKernel();const tag=randomUUID(),owner='answer-owner-'+tag,id='answer-doc-'+tag,title='Study answer source '+tag;
 const bodies=[body,'Both samples are compared under identical conditions.','Figure 1: Comparison of two samples.'];
 await kernel.ingestParsedDocument({id,ownerId:owner,courseId:'',name:title,hash:hash(JSON.stringify(bodies)),mime:'text/plain',
  origin:'answer-fixture',originKey:id},bodies.map((text,index)=>({pageNumber:index+1,locator:'original-node:'+index,text})),
  {parserVersion:'answer-fixture-v1',warnings:['Formula fidelity unverified.']});
 const resolution=await kernel.resolveDocumentSource(owner,{selectedDocumentTitle:title});assert.equal(resolution.status,'resolved');
 if(resolution.status!=='resolved')throw new Error('Source unresolved');
 const expected={...resolution.document,courseId:''},nodes=(await kernel.readDocumentSourcePages(owner,expected)).nodes;
 await kernel.registerDocumentStructure(owner,expected,{rawSourceHash:expected.sourceHash,parserVersion:'original-structure-v1',
  parents:[{id:'section',heading:'Experimental conditions'}],nodes:nodes.map((node,index)=>({evidenceId:node.evidenceId,
   locator:node.locator,ordinal:index,kind:index===2?'caption':'paragraph',parentId:index===2?null:'section',bodySha256:node.bodySha256}))});
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=','base64');
 await kernel.registerDocumentImage(owner,expected,{captionEvidenceId:nodes[2].evidenceId,originalReference:'figure.png',
  provenance:{sourceUrl:'https://example.edu/original/figure.png',revision:'fixture-v1'},bytes});
 const original=globalThis.fetch;let calls=0,hide=false;
 globalThis.fetch=async(_url,init)=>{
  calls++;const request=JSON.parse(String(init?.body)),content=request.input[1].content,
   input=JSON.parse(content[0].text),support=input.evidence.find((item:{text?:string})=>item.text?.includes('uses two samples.'));
  assert.ok(support);assert.equal(content.filter((item:{type:string})=>item.type==='input_image').length,1);
  if(hide)await kernel.hideParsedDocument(owner,id);
  return Response.json({status:'completed',model:'gpt-5-mini',usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify({
   status:'answered',message:'',claims:[{text:'The experiment uses two samples.',citations:[{id:support.id,quote:'uses two samples.'}]}]})});
 };
 try{
  const options={sourceHint:{selectedDocumentTitle:title},semantic:false,aiRerank:false,includeParents:true,includeImages:true};
  const result=await kernel.answerStudyContent(owner,'How many samples?',options);
  assert.equal(result.answer.status,'answered');assert.equal(result.imageEvidenceCount,1);assert.equal(result.textEvidenceCount,3);
  assert.deepEqual(result.warnings,['Formula fidelity unverified.']);assert.equal(calls,1);
  hide=true;await assert.rejects(kernel.answerStudyContent(owner,'How many samples?',options),/no longer current|Selected document/);
  assert.equal(calls,2,'a changed source is rejected without a model retry');
 }finally{globalThis.fetch=original;}
});
