import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {preparePdfStyleSelection,buildPdfStyleSelection,validatePdfStyleSelection,stagePdfStyleSelection,validatePdfStyleStage,type PdfStyleInput} from '../lib/pdf-source-style-staging.ts';
import {nativeHintCanonical,type PdfNativeHints} from '../lib/pdf-native-hints.ts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const prefix='The initial surrounding prose is clear. ',suffix=' The final surrounding prose is distinct.';
const framed=(text:string)=>prefix+text+suffix;
function fixture(text='Original \\(\\Phi_i=\\vec{u}\\cdot\\hat{v}+\\oiint_S w_i^2\\) unchanged.'){
 text=framed(text);
 const sidecar:PdfNativeHints['sidecar']={policy:'poppler-text-runs-v1',granularity:'text-run',status:'available',
  binding:{sourcePdfSha256:'a'.repeat(64),physicalPage:1,png:{sha256:'b'.repeat(64),width:612,height:792},
   frame:{mediaBox:{x:0,y:0,width:612,height:792},cropBox:{x:0,y:0,width:612,height:792},rotationDegrees:0,userUnit:1}},
  producer:{name:'pdftohtml',version:'fixture',argumentsPolicy:'xml-noroundcoord-fontfullname-zoom1-i-nomerge-physical-page-v1'},xmlSha256:'c'.repeat(64),
  coordinateSystem:{origin:'top-left',unit:'point-at-zoom-1',width:612,height:792,pngScaleX:1,pngScaleY:1},
  fonts:[{id:'f0',reportedFullName:'Fixture-Regular',reportedSize:12,color:'#000000',sourceFontFile:null}],
  runs:[{text:'u w',box:{left:10,top:20,width:50,height:12},fontId:'f0',observedSpans:[{text:'u w',boldTagObserved:true,italicTagObserved:false}]},
   {text:'v',box:{left:70,top:20,width:10,height:12},fontId:'f0',observedSpans:[{text:'v',boldTagObserved:false,italicTagObserved:true}]},
   {text:prefix,box:{left:0,top:0,width:300,height:12},fontId:'f0',observedSpans:[{text:prefix,boldTagObserved:false,italicTagObserved:false}]},
   {text:suffix,box:{left:0,top:40,width:300,height:12},fontId:'f0',observedSpans:[{text:suffix,boldTagObserved:false,italicTagObserved:false}]}]};
 const input:PdfStyleInput={baselineText:text,baselineSha256:sha(text),baselineSource:{rawPdfSha256:'a'.repeat(64),physicalPage:1,pngSha256:'b'.repeat(64)},
  nativeHints:{sidecar,sidecarSha256:sha(nativeHintCanonical(sidecar))}};
 return input;
}
function reseal(input:PdfStyleInput){input.nativeHints.sidecarSha256=sha(nativeHintCanonical(input.nativeHints.sidecar));return input;}
function anchoredFixture(text:string,runs:Array<{text:string;top:number;small?:boolean;styled?:boolean}>){
 const input=fixture();input.baselineText=text;input.baselineSha256=sha(text);
 input.nativeHints.sidecar.fonts!.push({id:'small',reportedFullName:'Fixture-Regular',reportedSize:7,color:'#000000',sourceFontFile:null});
 input.nativeHints.sidecar.runs=runs.map(run=>({text:run.text,fontId:run.small?'small':'f0',box:{left:10,top:run.top,width:300,height:run.small?7:12},
  observedSpans:[{text:run.text,boldTagObserved:Boolean(run.styled),italicTagObserved:false}]}));return reseal(input);
}

test('pure style staging retains every symbol, arrow, integral, script, delimiter and original byte on inversion',()=>{
 const input=fixture(),plan=preparePdfStyleSelection(input),again=preparePdfStyleSelection(input);
 assert.equal(plan.planSha256,again.planSha256);assert.equal(Object.isFrozen(plan),true);
 const pairs=['u','v','w'].map(atom=>({textSpanId:plan.textSpans.find(span=>span.atom===atom)!.id,nativeStyleSpanId:plan.nativeSpans.find(span=>span.atom===atom)!.id}));
 const stage=stagePdfStyleSelection(plan,{pairs});
 assert.equal(stage.text,framed('Original \\(\\Phi_i=\\vec{\\mathbf{u}}\\cdot\\hat{\\mathit{v}}+\\oiint_S \\mathbf{w}_i^2\\) unchanged.'));
 assert.equal(stage.sourceProven,false);assert.equal(stage.requiresManualReview,true);assert.equal(stage.notForApplyPageRepair,true);
 assert.equal(stage.alignmentVerification,'unverified');assert.equal(stage.invariants.inverseByteEqual,true);
 let inverse=stage.text;for(const insertion of [...stage.insertions].reverse())inverse=inverse.slice(0,insertion.start)+inverse.slice(insertion.end);
 assert.ok(Buffer.from(inverse).equals(Buffer.from(input.baselineText)));validatePdfStyleStage(plan,structuredClone(stage));
 assert.ok(stage.operations.every(op=>op.after===op.opening+op.before+op.closing));
 assert.equal(plan.textSpans.some(span=>['i','S'].includes(span.text)),false,'script fields cannot be restyled');
});

test('compound text offsets never divide the source box; repeats remain unverified and model output is IDs only',()=>{
 const input=fixture('\\(u+u+w\\)');input.nativeHints.sidecar.runs!.push(structuredClone(input.nativeHints.sidecar.runs![0]));reseal(input);
 const plan=preparePdfStyleSelection(input);
 const compound=plan.nativeSpans.filter(span=>span.runIndex===0);
 assert.equal(compound.length,2);assert.deepEqual(compound.map(span=>span.textOffset),[{start:0,end:1},{start:2,end:3}]);
 assert.ok(compound.every(span=>span.text==='u w'&&nativeHintCanonical(span.runBox)===nativeHintCanonical(input.nativeHints.sidecar.runs![0].box)));
 assert.ok(compound.every(span=>span.granularity==='text-run'&&span.encodingVerification==='not-certified'&&span.repeatedAtom));
 const one={textSpanId:plan.textSpans.find(span=>span.atom==='u')!.id,nativeStyleSpanId:compound[0].id};
 assert.equal(plan.status,'unavailable');assert.equal(buildPdfStyleSelection(plan),null);
 assert.throws(()=>stagePdfStyleSelection(plan,{pairs:[one]}),/double-prose-anchor/,'repeated occurrences cannot be resolved by model choice');
 const unique=preparePdfStyleSelection(fixture()),request=buildPdfStyleSelection(unique)!;
 const chosen=unique.proseAlignment.allowedPairs[0];
 assert.equal('start' in request.textSpans[0],false);assert.equal('end' in request.textSpans[0],false);
 assert.deepEqual(request.schema.properties.pairs.items.required,['textSpanId','nativeStyleSpanId']);
 const pair={textSpanId:chosen.textSpanId,nativeStyleSpanId:chosen.nativeStyleSpanId};
 assert.throws(()=>validatePdfStyleSelection(unique,{pairs:[pair],text:'replacement'}),/Only bounded ID/);
 assert.throws(()=>validatePdfStyleSelection(unique,{pairs:[{...pair,style:'bold'}]}),/exact pair/);
 assert.throws(()=>validatePdfStyleSelection(unique,{pairs:[{...pair,textSpanId:'unknown'}]}),/Unknown/);
 assert.throws(()=>validatePdfStyleSelection(unique,{pairs:[pair,pair]}),/duplicate/);
});

test('changed symbols/arrows/integrals/scripts/boundaries or overlap cannot masquerade as a validated style receipt',()=>{
 const plan=preparePdfStyleSelection(fixture()),pair={textSpanId:plan.textSpans.find(span=>span.atom==='u')!.id,nativeStyleSpanId:plan.nativeSpans.find(span=>span.atom==='u')!.id};
 const stage=stagePdfStyleSelection(plan,{pairs:[pair]});
 for(const [from,to] of [['\\vec','\\hat'],['\\oiint','\\iint'],['_i','_j'],['^2','^3'],['\\(','$'],['u','z']]){
  const changed=structuredClone(stage);changed.text=changed.text.replace(from,to);changed.derivedTextSha256=sha(changed.text);
  assert.throws(()=>validatePdfStyleStage(plan,changed),/exact insertion-only/);
 }
 const overlap=structuredClone(stage);overlap.operations.push({...overlap.operations[0]});assert.throws(()=>validatePdfStyleStage(plan,overlap),/exact insertion-only/);
 const moved=structuredClone(stage);moved.operations[0].start++;assert.throws(()=>validatePdfStyleStage(plan,moved),/exact insertion-only/);
 const anchor=structuredClone(stage);anchor.proseAlignment.anchors[0].sourceText+='x';assert.throws(()=>validatePdfStyleStage(plan,anchor),/exact insertion-only/);
 const changedPlan=structuredClone(plan);changedPlan.textSpans[0].start++;assert.throws(()=>stagePdfStyleSelection(changedPlan,{pairs:[pair]}),/plan changed/);
});

test('unknown encoding/font, words, ambiguous math and existing styles are skipped without rewriting',()=>{
 const input=fixture('Existing \\(\\mathbf{u}+\\unknown{w}\\) and \\(\\vec u\\).');
 const plan=preparePdfStyleSelection(input);assert.equal(plan.status,'unavailable');assert.equal(buildPdfStyleSelection(plan),null);
 assert.ok(plan.declined.some(item=>item.reason==='unsupported-math-structure'));
 assert.ok(plan.declined.some(item=>item.reason==='unsupported-unbraced-command'));
 assert.equal(stagePdfStyleSelection(plan,{pairs:[]}).text,input.baselineText);
 const bad=fixture();bad.nativeHints.sidecar.fonts![0].reportedFullName='Unknown-Type3-Symbol';
 assert.equal(preparePdfStyleSelection(reseal(bad)).nativeSpans.length,0);
 for(const text of ['unknown','constructor','toString']){
  const word=fixture();word.nativeHints.sidecar.runs![0].observedSpans[0].text=text;word.nativeHints.sidecar.runs![0].text=text;
  assert.equal(preparePdfStyleSelection(reseal(word)).nativeSpans.some(span=>span.runIndex===0),false,'ordinary words are not Greek atoms: '+text);
 }
 const styled=preparePdfStyleSelection(fixture('\\(\\mathbf{u}+w\\)'));assert.equal(styled.textSpans.some(span=>span.text==='u'),false);
 const literal=fixture('\\(\\alpha\\)');literal.nativeHints.sidecar.runs![0].text='\\alpha';literal.nativeHints.sidecar.runs![0].observedSpans[0].text='\\alpha';
 assert.equal(preparePdfStyleSelection(reseal(literal)).nativeSpans.some(span=>span.atom==='\\alpha'),false,'printed literal TeX is not native Greek evidence');
 literal.nativeHints.sidecar.runs![0].text='α';literal.nativeHints.sidecar.runs![0].observedSpans[0].text='α';
 const actualGreek=preparePdfStyleSelection(reseal(literal));
 assert.equal(stagePdfStyleSelection(actualGreek,{pairs:[{textSpanId:actualGreek.textSpans[0].id,nativeStyleSpanId:actualGreek.nativeSpans.find(span=>span.atom==='\\alpha')!.id}]}).text,framed('\\(\\boldsymbol{\\alpha}\\)'));
 const variants=['varepsilon','vartheta','varkappa','varphi','varrho','varpi','varsigma'].map(name=>'\\'+name),body='\\('+variants.join('+')+'+u\\)';
 const opaque=preparePdfStyleSelection(fixture(body));assert.deepEqual(opaque.textSpans.map(span=>span.text),['u']);
 const preserved=stagePdfStyleSelection(opaque,{pairs:[{textSpanId:opaque.textSpans[0].id,nativeStyleSpanId:opaque.nativeSpans.find(span=>span.atom==='u')!.id}]});
 assert.equal(preserved.text,framed('\\('+variants.join('+')+'+\\mathbf{u}\\)'),'opaque variants stay byte-identical and do not block neighboring leaves');
});

test('baseline/sidecar/PNG identity changes reject; different source pages require an explicitly unverified map',()=>{
 const changed=fixture();changed.baselineText+='x';assert.throws(()=>preparePdfStyleSelection(changed),/baseline/);
 const png=fixture();png.baselineSource.pngSha256='d'.repeat(64);assert.throws(()=>preparePdfStyleSelection(png),/identity/);
 const sidecar=fixture();sidecar.nativeHints.sidecar.producer.version='changed';assert.throws(()=>preparePdfStyleSelection(sidecar),/identity/);
 const mapped=fixture();mapped.baselineSource.rawPdfSha256='e'.repeat(64);assert.throws(()=>preparePdfStyleSelection(mapped),/explicit unverified/);
 mapped.baselineSource.pageMap={reference:'frozen-public-source-page-map',sha256:'f'.repeat(64)};
 const plan=preparePdfStyleSelection(mapped);assert.equal(plan.pageMapping,'declared-needs-review');assert.equal(plan.alignmentVerification,'unverified');
});

test('repeated symbols stay inside unique prose intervals; source array order cannot authorize a crossing',()=>{
 const left='Alpha boundary before initial expression ',middle='Middle boundary separates both mathematical expressions ',right='Final boundary after subsequent expression ';
 const input=anchoredFixture(left+'\\(x\\) '+middle+'\\(x\\) '+right,
  [{text:'x',top:60,styled:true},{text:left,top:0},{text:right,top:80},{text:'x',top:20,styled:true},{text:middle,top:40}]);
 const plan=preparePdfStyleSelection(input);
 assert.equal(plan.proseAlignment.allowedPairs.length,2);assert.equal(plan.proseAlignment.anchors.length,3);
 const later=plan.nativeSpans.find(span=>span.runIndex===0)!,early=plan.textSpans[0];
 assert.throws(()=>validatePdfStyleSelection(plan,{pairs:[{textSpanId:early.id,nativeStyleSpanId:later.id}]}),/double-prose-anchor/);
 const allowed=plan.proseAlignment.allowedPairs.find(pair=>pair.nativeStyleSpanId===later.id)!;
 assert.equal(allowed.textSpanId,plan.textSpans[1].id);assert.equal(stagePdfStyleSelection(plan,{pairs:[{textSpanId:allowed.textSpanId,nativeStyleSpanId:later.id}]}).sourceProven,false);
 input.nativeHints.sidecar.runs!.push(structuredClone(input.nativeHints.sidecar.runs![1]));
 const duplicateAnchor=preparePdfStyleSelection(reseal(input));
 assert.equal(duplicateAnchor.proseAlignment.allowedPairs.some(pair=>pair.textSpanId===early.id),false,'a repeated source prose anchor cannot lock the earlier interval');
});

test('a scalar in prose cannot supply the same letter inside a later mathematical interval',()=>{
 const left='The scalar context starts right here ',middle='The mathematical context starts down below ',right='The final context ends right here ';
 const plan=preparePdfStyleSelection(anchoredFixture(left+'x '+middle+'\\(x\\) '+right,
  [{text:'x',top:20,styled:true},{text:'x',top:60,styled:true},{text:middle,top:40},{text:left,top:0},{text:right,top:80}]));
 const scalar=plan.nativeSpans.find(span=>span.runIndex===0)!;
 assert.equal(plan.proseAlignment.allowedPairs.length,1);assert.equal(plan.proseAlignment.allowedPairs[0].nativeStyleSpanId,plan.nativeSpans.find(span=>span.runIndex===1)!.id);
 assert.ok(plan.declined.some(item=>item.scope===scalar.id&&item.reason==='no-unique-math-leaf-in-interval'));
 assert.throws(()=>validatePdfStyleSelection(plan,{pairs:[{textSpanId:plan.textSpans[0].id,nativeStyleSpanId:scalar.id}]}),/double-prose-anchor/);
});

test('a small script-like source is declined even when its run is listed before the actual base',()=>{
 const left='The preceding prose fixes this location ',right='The following prose closes this location ';
 const plan=preparePdfStyleSelection(anchoredFixture(left+'\\(\\vec{x}_x\\) '+right,
  [{text:'x',top:25,small:true,styled:true},{text:right,top:50},{text:'x',top:20,styled:true},{text:left,top:0}]));
 const small=plan.nativeSpans.find(span=>span.runIndex===0)!;
 assert.equal(plan.textSpans.length,1,'baseline script fields remain excluded');assert.equal(plan.proseAlignment.allowedPairs.length,1);
 assert.equal(plan.proseAlignment.allowedPairs[0].nativeStyleSpanId,plan.nativeSpans.find(span=>span.runIndex===2)!.id);
 assert.ok(plan.declined.some(item=>item.scope===small.id&&item.reason==='unknown-or-script-like-native-size'));
 assert.throws(()=>validatePdfStyleSelection(plan,{pairs:[{textSpanId:plan.textSpans[0].id,nativeStyleSpanId:small.id}]}),/double-prose-anchor/);
});
