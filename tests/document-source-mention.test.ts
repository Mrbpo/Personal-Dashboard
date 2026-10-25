import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Pool} from 'pg';
import {documentTitleMention,findMentionedDocumentSources,mentionedOtherDocumentSources,resolveDocumentSource,type ResolvedDocumentSource} from '../lib/kernel/document-source.ts';
import {focusedDocumentTextQuery} from '../lib/kernel/document-focused-text.ts';

const doc=(documentId:string,title:string):ResolvedDocumentSource=>({documentId,title,currentVersionId:`v-${documentId}`,
 sourceVersionId:`s-${documentId}`,sourceHash:`h-${documentId}`});
function metadata(rows:ResolvedDocumentSource[]){
 const calls:Array<{sql:string;args:unknown[]}>=[];
 return {calls,pool:{query:async(sql:string,args:unknown[])=>{calls.push({sql,args});return {rows};}} as unknown as Pool};
}
test('literal TeX accents match Unicode titles in either direction while preserving exact question spans',()=>{
 const tex=String.raw`Generaci\'on autom\'atica de frases literarias en espa\~nol`;
 const natural='Generación automática de frases literarias en español';
 for(const [name,surface]of [[tex+'.pdf',natural],[natural+'.pdf',tex]]){
  const question='😀 About “'+surface+'”, what metrics were measured?',match=documentTitleMention(question,name)!;
  assert.ok(match);assert.equal(match.text,surface);assert.equal(match.start,question.indexOf(surface));assert.equal(match.end,question.indexOf(surface)+surface.length);
  const focus=focusedDocumentTextQuery(question,name)!;
  assert.ok(focus.startsWith('😀 About'));assert.ok(focus.endsWith('what metrics were measured?'));assert.ok(!focus.includes(surface));
 }
 for(const [name,surface]of [[String.raw`Caf\'e sampling methods.pdf`,'Café sampling methods'],
  [String.raw`M{\"u}ller evaluation guide.pdf`,'Müller evaluation guide'],
  [String.raw`Generaci\'{o}n de espa{\~n}ol.pdf`,'Generación de español']])
  assert.equal(documentTitleMention('Use “'+surface+'”.',name)?.text,surface);
});
test('accent equivalence does not strip accents, expand unknown/malformed TeX or admit embedded titles',()=>{
 for(const [name,question]of [[String.raw`Caf\'e sampling methods.pdf`,'Use Cafe sampling methods.'],
  [String.raw`Caf\'e sampling methods.pdf`,'Use café sampling methods.'],
  [String.raw`Caf\'e sampling methods.pdf`,'preCafé sampling methodsSuffix'],
  [String.raw`Caf\'e sampling methods.pdf`,'Café sampling methods.pdf.txt'],
  [String.raw`Caf\'{ee} sampling methods.pdf`,'Café sampling methods'],
  [String.raw`Notes on \alpha methods.pdf`,'Notes on α methods']])assert.equal(documentTitleMention(question,name),null);
 assert.equal(documentTitleMention(String.raw`Long source \~t`, 'Long source t.pdf'),null,'a combining mark still participates in the word boundary');
});
test('typographic discovery keeps canonical identity, ambiguity and multi-source guards without loading bodies',async()=>{
 const tex=doc('tex',String.raw`Caf\'e sampling methods.pdf`),natural=doc('natural','Café sampling methods.pdf'),question='Compare Café sampling methods with the selected source.';
 const db=metadata([tex]);assert.deepEqual(await findMentionedDocumentSources(db.pool,'alice',question,{courseId:'math',routingScope:{documentIds:['tex']}}),{status:'resolved',matches:[tex]});
 assert.equal(db.calls[0].args[0],'alice');assert.equal(db.calls[0].args[2],'math');assert.equal(db.calls[0].args[3],question);assert.deepEqual(db.calls[0].args[4],['tex']);
 assert.match(db.calls[0].sql,/d\.owner_id=\$1 AND NOT d\.hidden/);assert.match(db.calls[0].sql,/strpos\(d\.name,chr\(92\)\)/);
 assert.doesNotMatch(db.calls[0].sql,/document_text_pages|\.body\b|embedding|\bLIMIT\b/i);
 assert.deepEqual(await findMentionedDocumentSources(metadata([tex,natural]).pool,'alice',question),{status:'ambiguous',matches:[tex,natural]});
 const other=metadata([tex]);assert.deepEqual(await mentionedOtherDocumentSources(other.pool,'alice',question,'selected'),[tex]);assert.equal(other.calls[0].args[3],question);
});

test('full NFKC title resolves only current owner/course metadata and preserves the source tuple',async()=>{
 const source=doc('one','Finite Ｆield Methods for Students'),db=metadata([source]);
 const result=await findMentionedDocumentSources(db.pool,'alice','Please use “Finite Field Methods for Students” to explain the construction.',{courseId:'math'});
 assert.deepEqual(result,{status:'resolved',matches:[source]});
 assert.deepEqual(db.calls[0].args,['alice','Please use “Finite Field Methods for Students” to explain the construction.','math']);
 const sql=db.calls[0].sql;
 assert.match(sql,/d\.owner_id=\$1 AND NOT d\.hidden/);assert.match(sql,/d\.course_id=\$3/);
 assert.match(sql,/v\.id=d\.current_version_id AND v\.document_id=d\.id/);assert.match(sql,/newer\.owner_id=d\.owner_id/);
 assert.match(sql,/newer\.origin=d\.origin AND newer\.origin_key=d\.origin_key AND NOT newer\.hidden/);
 assert.doesNotMatch(sql,/document_text_pages|\.body\b|\bLIMIT\b/i,'no bodies or pre-boundary LIMIT');
});

test('short names, partial titles, case changes and embedded words do not select a source',async()=>{
 const title='Reliable inference methods',db=metadata([doc('short','Learning'),doc('single','Generalization'),doc('exam','Final exam'),doc('full',title)]);
 for(const question of ['Learning and Generalization before the Final exam','Reliable inference','reliable inference methods','preReliable inference methodsSuffix'])
  assert.deepEqual(await findMentionedDocumentSources(db.pool,'alice',question),{status:'not-mentioned',matches:[]});
 assert.equal((await findMentionedDocumentSources(db.pool,'alice',`pre${title}Suffix; now “${title}”.`)).status,'resolved','later bounded occurrence is still found');
});

test('different current documents with the same normalized title and multiple named sources stay ambiguous; at most two return',async()=>{
 const a=doc('a','Reliable inference methods'),b=doc('b','Reliable inference methods'),c=doc('c','Practical matrix calculations');
 const result=await findMentionedDocumentSources(metadata([a,b,c]).pool,'alice',`Compare “${a.title}” with “${c.title}”.`);
 assert.deepEqual(result,{status:'ambiguous',matches:[a,b]});
 const distinct=await findMentionedDocumentSources(metadata([a,c]).pool,'alice',`Compare “${a.title}” with “${c.title}”.`);
 assert.deepEqual(distinct,{status:'ambiguous',matches:[a,c],uniqueTitleSources:[a,c]});
});

test('multiple title attribution requires every matching row to have its own non-overlapping span and stays bounded',async()=>{
 const a=doc('a','Independent Evaluation Methods.pdf'),b=doc('b','Practical Matrix Calculations.pdf'),
  c=doc('c','Reliable Inference Experiments.pdf'),question=`Compare “${a.title}”, “${b.title}” and “${c.title}”.`;
 assert.deepEqual((await findMentionedDocumentSources(metadata([a,b,c]).pool,'alice',question)).uniqueTitleSources,[a,b,c]);
 assert.equal((await findMentionedDocumentSources(metadata([a,b,c,{...b,documentId:'later-duplicate'}]).pool,'alice',question)).uniqueTitleSources,undefined,
  'a duplicate after the legacy first two results must invalidate the complete set');
 const short=doc('short','Probability Lecture Notes.pdf'),long=doc('long','Advanced Probability Lecture Notes.pdf');
 assert.equal((await findMentionedDocumentSources(metadata([short,long]).pool,'alice',`Use “${long.title}”.`)).uniqueTitleSources,undefined);
 const many=Array.from({length:9},(_,i)=>doc('d'+i,`Independent Source Number ${i}.pdf`)),q=many.map(d=>`“${d.title}”`).join(' versus ');
 const result=await findMentionedDocumentSources(metadata(many).pool,'alice',q);
 assert.equal(result.status,'ambiguous');assert.equal(result.matches.length,2);assert.equal(result.uniqueTitleSources,undefined,'no truncated set is certified');
});

test('conservative Han-title boundary, rejected early substrings and empty input do not conceal a unique full title',async()=>{
 const han=doc('han','高等数学课程学习资料'),one=doc('one','Reliable inference methods'),two=doc('two','Practical matrix calculations');
 assert.deepEqual(await findMentionedDocumentSources(metadata([han]).pool,'alice',`请用《${han.title}》解释。`),{status:'resolved',matches:[han]});
 assert.equal((await findMentionedDocumentSources(metadata([han]).pool,'alice',`请用${han.title}解释。`)).status,'not-mentioned','unseparated Han text keeps retrieval');
 const result=await findMentionedDocumentSources(metadata([one,two,han]).pool,'alice',`pre${one.title}X pre${two.title}X 《${han.title}》`);
 assert.deepEqual(result,{status:'resolved',matches:[han]});
 const empty=metadata([]);assert.deepEqual(await findMentionedDocumentSources(empty.pool,'alice',' '),{status:'not-mentioned',matches:[]});assert.equal(empty.calls.length,0);
});

test('a complete PDF filename or its NFKC stem resolves without changing canonical metadata or explicit hints',async()=>{
 const source=doc('pdf','Probability Ｌecture Notes.PDF'),db=metadata([source]);
 for(const mention of ['Probability Lecture Notes.PDF','Probability Lecture Notes']){
  const question=`Explain “${mention}”.`,result=await findMentionedDocumentSources(db.pool,'alice',question,{courseId:'math'});
  assert.deepEqual(result,{status:'resolved',matches:[source]});assert.equal(result.matches[0].title,source.title);
  assert.equal(documentTitleMention(question,source.title)?.text,mention);
 }
 assert.match(db.calls[0].sql,/regexp_replace\(normalize\(d\.name,NFKC\),'\[\.\]\[pP\]\[dD\]\[fF\]\$',''\)/);
 const exact=metadata([]);await resolveDocumentSource(exact.pool,'alice',{selectedDocumentTitle:'Probability Lecture Notes'});
 assert.match(exact.calls[0].sql,/normalize\(d\.name,NFKC\)=\$2/);assert.doesNotMatch(exact.calls[0].sql,/regexp_replace/);
 const other=metadata([source]);assert.deepEqual(await mentionedOtherDocumentSources(other.pool,'alice','Compare “Probability Lecture Notes”.','selected'),[source]);
 assert.deepEqual(other.calls[0].args,['alice','selected','Compare “Probability Lecture Notes”.']);
 assert.doesNotMatch(other.calls[0].sql,/\bLIMIT\b/i,'boundary rejection happens before the two-source cap');
});

test('PDF stem collisions stay ambiguous and abbreviated, short or embedded mentions remain unselected',async()=>{
 const stem='Probability Lecture Notes',pdf=doc('pdf',stem+'.pdf'),plain=doc('plain',stem),copy=doc('copy',stem+'.PDF');
 assert.deepEqual(await findMentionedDocumentSources(metadata([pdf,plain,copy]).pool,'alice',`Use “${stem}”.`),
  {status:'ambiguous',matches:[pdf,plain]});
 for(const question of ['Use Probability Lecture','Use probability Lecture Notes',`pre${stem}Suffix`,`Use ${stem}.txt`,`Use ${stem}.pdf.backup`])
  assert.deepEqual(await findMentionedDocumentSources(metadata([pdf]).pool,'alice',question),{status:'not-mentioned',matches:[]});
 assert.equal(documentTitleMention('Use “Probability Lecture Notes”.',stem+'.txt'),null,'only .pdf may be omitted');
 for(const title of ['Learning.pdf','Final exam.pdf'])assert.equal((await findMentionedDocumentSources(metadata([doc('short',title)]).pool,'alice',`Use ${title.slice(0,-4)}.`)).status,'not-mentioned','apply the automatic minimum to the actual stem mention');
 assert.equal((await findMentionedDocumentSources(metadata([pdf]).pool,'alice',`pre${stem}Suffix; then “${stem}”.`)).status,'resolved');
});

test('PDF stem question passes canonical complete/caption proofs and planned focus but cannot replace the canonical proof name',async()=>{
 const [{prepareDocumentAnswer},{COMPLETE_DOCUMENT_SOURCE_LIMITS},{freezeStudyQuestionContract},{studySupplementQueries}]=await Promise.all([
  import('../lib/kernel/document-answer.ts'),import('../lib/kernel/document-context.ts'),
  import('../lib/kernel/document-study-contract.ts'),import('../lib/kernel/document-planned-answer.ts')]);
 const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),canonical=(v:unknown):string=>JSON.stringify(v,(_key,x)=>
  x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
 const stem='Probability Lecture Notes',name=stem+'.pdf',question=`Explain “${stem}”.`,body='The measurements are recorded in the original source.',
  source={documentId:'pdf',currentVersionId:'v-pdf',sourceVersionId:'s-pdf',sourceHash:sha('original'),courseId:''},
  anchor={id:'pg:v-pdf:1',document_id:'pdf',course_id:'',name,origin:'fixture',origin_key:'original',source_hash:source.sourceHash,
   source_version_id:source.sourceVersionId,body,locator:'page 1',page_number:1,evidence_id:'e1',parser_version:'fixture',score:1,evidence_body:'full-page' as const},
  unsigned={method:'complete-current-source' as const,nodeOrder:'original-source' as const,complete:true,reason:null,source,sourceNodeCount:1,returnedNodeCount:1,
   sourceBodyCodepoints:Array.from(body).length,sourceBodyUtf8Bytes:Buffer.byteLength(body),orderedTextSha256:sha(canonical([body])),structureManifestSha256:'f'.repeat(64),
   parserWarnings:[],document:{name,origin:'fixture',originKey:'original',parserVersion:'fixture'},hierarchy:[],
   nodes:[{documentId:'pdf',documentVersionId:'v-pdf',sourceVersionId:'s-pdf',sourceHash:source.sourceHash,evidenceId:'e1',locator:'page 1',ordinal:0,kind:'paragraph' as const,bodySha256:sha(body)}],
   images:[],imageInputTokenUpper:0,limits:COMPLETE_DOCUMENT_SOURCE_LIMITS},manifest={...unsigned,manifestSha256:sha(canonical(unsigned))},
  context={sourceContentIsUntrusted:true as const,anchors:[anchor],parents:[],images:[]},
  proof={policy:'selected-complete-initial-v1' as const,selectedDocumentTitle:name,manifest};
 assert.equal(prepareDocumentAnswer(question,{...context,completeSourceProof:proof}).input.completeSourceProof?.selectedDocumentTitle,name);
 assert.equal(prepareDocumentAnswer(`Explain “${name}”.`,{...context,completeSourceProof:proof}).input.completeSourceProof?.manifest.manifestSha256,manifest.manifestSha256);
 assert.throws(()=>prepareDocumentAnswer(question,{...context,completeSourceProof:{...proof,selectedDocumentTitle:stem}}),/binding changed/);
 const caption={policy:'resolved-title-caption-images-v1' as const,selectedDocumentTitle:name,source,manifestSha256:'f'.repeat(64),totalCaptions:0,captions:[]};
 assert.equal(prepareDocumentAnswer(question,{...context,sourceCaptionProof:caption}).input.sourceCaptionProof?.selectedDocumentTitle,name);
 const contract=freezeStudyQuestionContract(question,{requirements:[{id:'r0',aspect:'Explain the measurements',requestedScope:{subject:stem,attribute:null,unit:null,population:null,stage:null,configuration:null,time:null}}]},'a'.repeat(64)),
  binding={plan:{missing:[],sourceSubscopes:[]}} as unknown as import('../lib/kernel/document-study-contract.ts').StudyContractPlanBinding,
  resolved={scope:'selected-title-scoped' as const,selectedDocumentTitle:name,status:'resolved' as const,document:{...doc('pdf',name),sourceHash:source.sourceHash}},
  queries=studySupplementQueries(question,contract,binding,resolved);
 assert.equal(queries[0].query,'Explain the measurements');assert.equal(queries[0].originalQuery,`Explain the measurements ${stem}`);
 assert.equal(resolved.selectedDocumentTitle,name);assert.equal(proof.manifest.document.name,name);
});
