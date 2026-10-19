import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {freezeDocumentQuestionTarget,validateDocumentQuestionTarget,assertDocumentQuestionTarget,
 normalizeDocumentQuestionTargetAnswer} from '../lib/kernel/document-question-target.ts';
import {prepareDocumentAnswer,buildSelectedDocumentAnswerRequest,buildDocumentEvidenceSelectionRequest,
 planDocumentQueryScope,documentAnswerSettings,type DocumentAnswerContext,type DocumentAnswerPolicy} from '../lib/kernel/document-answer.ts';
import {buildDocumentQueryScopeRequest,validateDocumentQueryScope} from '../lib/kernel/document-source.ts';

process.env.DATABASE_URL=':memory:';process.env.OPENAI_API_KEY='target-fixture-never-sent';
process.env.SERVICE_VAULT_DIR=join(tmpdir(),'question-target-'+randomUUID());process.env.AI_MONTHLY_BUDGET='5';
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const question='According to Original research, how long did training take?';
const target={questionSpan:'how long did training take?',subject:'the model',attribute:'training elapsed time',unit:null};
const frozen=()=>freezeDocumentQuestionTarget(question,target,hash('actual-scope-request'),hash('actual-scope-raw'));
const source={documentId:'doc',title:'Original research.pdf',currentVersionId:'v1',sourceVersionId:'sv1',sourceHash:hash('original')};
const policy:DocumentAnswerPolicy={scope:'application',model:'gpt-5.4-mini',maxOutputTokens:3000,evidenceSelection:'select-then-answer',
 questionTarget:'explicit-attribute-v1',sourceRouting:{mode:'question-scope',beforeAttempt:async()=>{},recordResponse:async()=>{}},
 citationCheck:{mode:'selected-once',beforeAttempt:async()=>{},recordResponse:async()=>{}}};
function context():DocumentAnswerContext{return {sourceContentIsUntrusted:true,images:[],parents:[],anchors:[{
 id:'pg:v1:1',document_id:'doc',course_id:'',name:source.title,origin:'upload',origin_key:'source',source_hash:source.sourceHash,
 source_version_id:'sv1',body:'Each model trains for 100 epochs. No duration is specified.',locator:'page:1',page_number:1,
 evidence_id:'evidence',parser_version:'native-unverified',score:1,evidence_body:'full-page',parser_warnings:[]}]};}

test('question-only target preserves unknown and exact spans, without certifying interpretation',()=>{
 assert.equal(validateDocumentQuestionTarget(question,null),null);
 assert.deepEqual(validateDocumentQuestionTarget(question,target),target);
 for(const v of [{...target,questionSpan:'not in question'},{...target,attribute:''},{...target,answer:'100 epochs'}])
  assert.throws(()=>validateDocumentQuestionTarget(question,v),/target/);
 assert.throws(()=>validateDocumentQuestionTarget('same same',{...target,questionSpan:'same'}),/target/);
 const t=frozen();assert.equal(t.startUtf16,question.indexOf(target.questionSpan));assert.equal(t.semanticVerified,false);
 assert.throws(()=>assertDocumentQuestionTarget(question,{...t}),/Unbound/);
 assert.throws(()=>assertDocumentQuestionTarget(question+' changed',t),/Unbound/);
});

test('scope opt-in keeps original default and binds target to the actual question-only provider request',async()=>{
 const legacy=buildDocumentQueryScopeRequest(question,source,'gpt-5.4-mini'),candidate=buildDocumentQueryScopeRequest(question,source,'gpt-5.4-mini',true);
 assert.equal(legacy.max_output_tokens,600);assert.equal(candidate.max_output_tokens,1000);
 assert.deepEqual(candidate.input[1],legacy.input[1]);
 assert.equal(validateDocumentQueryScope({scope:'unknown',reason:'Unclear.',answerTarget:null},question).answerTarget,null);
 const old=globalThis.fetch;let sent:any,calls=0;const retained:any[]=[];
 try{globalThis.fetch=async(_url,init)=>{calls++;sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({status:'completed',
   model:'gpt-5.4-mini-2026-03-17',usage:{input_tokens:100,output_tokens:60},
   output_text:JSON.stringify({scope:'named-document',reason:'Single source.',answerTarget:target})}));};
  const result=await planDocumentQueryScope(question,source,{...policy,sourceRouting:{...policy.sourceRouting!,recordResponse:async r=>{retained.push(r);}}},async()=>{});
  assert.equal(calls,1);assert.equal(result.requestTarget!.providerRequestSha256,hash(JSON.stringify(sent)));
  assert.equal(result.requestTarget!.rawResponseSha256,retained[0].rawSha256);
  assertDocumentQuestionTarget(question,result.requestTarget!);
 }finally{globalThis.fetch=old;}
});

test('selected generation carries fixed target but both direct and supplementary citations stay inside selected IDs',()=>{
 const prepared=prepareDocumentAnswer(question,context()),id=prepared.quoteUnits.find(q=>q.selectable)!.id,
  settings={model:'gpt-5.4-mini' as const,reasoningEffort:'low' as const,maxOutputTokens:3000};
 const plain=buildSelectedDocumentAnswerRequest(prepared,[id],settings),bound=buildSelectedDocumentAnswerRequest(prepared,[id],settings,{...policy,requestTarget:frozen()});
 const input=(r:typeof plain)=>JSON.parse((r.input.at(-1)!.content[0] as any).text);
 assert.equal(input(plain).questionTarget,undefined);assert.equal(input(bound).questionTarget.target.attribute,target.attribute);
 assert.deepEqual(input(bound).quoteUnits,input(plain).quoteUnits);
 const schema:any=bound.text.format.schema;
 assert.deepEqual(schema.properties.directAnswer.anyOf[1].properties.parts.items.properties.citations.items.properties.id.enum,[id]);
 assert.deepEqual(schema.properties.claims.items.properties.citations.items.properties.id.enum,[id]);
 const selector=buildDocumentEvidenceSelectionRequest(prepared,settings,{...policy,requestTarget:frozen()});
 assert.equal(JSON.parse((selector.input.at(-1)!.content[0] as any).text).questionTarget,undefined);
});

test('normalization preserves distinct source conditions and supplements; actual audited claims include fixed attribute',()=>{
 const value={status:'answered',message:'',directAnswer:{targetId:'r0',parts:[
  {value:'source A: 2 hours under configuration A',citations:[{id:'q-a'}]},
  {value:'source B: 3 hours under configuration B',citations:[{id:'q-b'}]}]},
 claims:[{text:'The iteration budgets differ.',citations:[{id:'q-a'},{id:'q-b'}]}]};
 const result=normalizeDocumentQuestionTargetAnswer(question,frozen(),value,JSON.stringify(value));
 assert.equal(result.normalizedSelections.claims.length,3);
 assert.match((result.normalizedSelections.claims[0] as any).text,/training elapsed time: source A: 2 hours/);
 assert.match((result.normalizedSelections.claims[1] as any).text,/configuration B/);
 assert.deepEqual((result.normalizedSelections.claims[2] as any).citations,value.claims[0].citations);
 assert.equal(result.receipt.semanticVerified,false);assert.equal(result.receipt.rawOutputText,JSON.stringify(value));
});

test('supplement-only answers, missing direct values and mismatched raw payloads are protocol failures, not correct refusal',()=>{
 const value={status:'answered',message:'',claims:[{text:'100 epochs',citations:[{id:'q-a'}]}],directAnswer:null};
 assert.throws(()=>normalizeDocumentQuestionTargetAnswer(question,frozen(),value,JSON.stringify(value)),/direct question target/);
 assert.throws(()=>normalizeDocumentQuestionTargetAnswer(question,frozen(),value,'{}'),/raw output/);
 const refusal={status:'insufficient-evidence',message:'',claims:[],directAnswer:null};
 assert.equal(normalizeDocumentQuestionTargetAnswer(question,frozen(),refusal,JSON.stringify(refusal)).normalizedSelections.claims.length,0);
});

test('unsupported protocol combinations fail before a model call rather than silently bypassing target binding',async()=>{
 await documentAnswerSettings(policy);
 await assert.rejects(documentAnswerSettings({...policy,sourceRouting:undefined}),/Question target/);
 await assert.rejects(documentAnswerSettings({...policy,sourceValueContract:'difference-v1'}),/Question target/);
 await assert.rejects(documentAnswerSettings({...policy,questionTarget:undefined,requestTarget:frozen()}),/explicit policy/);
});
