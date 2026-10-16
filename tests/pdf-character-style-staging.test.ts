import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeHintCanonical} from '../lib/pdf-native-hints.ts';
import {preparePdfCharacterStyles,buildPdfCharacterStyles,stagePdfCharacterStyles,validatePdfCharacterStyleStage,validatePdfCharacterStyleSelection,
 type PdfCharacterStyleInput} from '../lib/pdf-character-style-staging.ts';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
type Run={text:string;left:number;top:number;style?:'bold'|'italic';small?:boolean;width?:number};
function fixture(text:string,runs:Run[]):PdfCharacterStyleInput{
 const fonts=['Regular','Bold','Italic'].map((name,i)=>({id:'f'+i,reportedFullName:'Fixture-'+name,reportedSize:12,color:'#000000',sourceFontFile:null}));
 const sidecar={policy:'poppler-text-runs-v1' as const,granularity:'text-run' as const,status:'available' as const,
  binding:{sourcePdfSha256:'a'.repeat(64),physicalPage:1,png:{sha256:'b'.repeat(64),width:200,height:200},frame:{mediaBox:{x:0,y:0,width:200,height:200},cropBox:{x:0,y:0,width:200,height:200},rotationDegrees:0,userUnit:1}},
  producer:{name:'pdftohtml' as const,version:'fixture',argumentsPolicy:'xml-noroundcoord-fontfullname-zoom1-i-nomerge-physical-page-v1' as const},xmlSha256:'c'.repeat(64),
  coordinateSystem:{origin:'top-left' as const,unit:'point-at-zoom-1' as const,width:200,height:200,pngScaleX:1,pngScaleY:1},fonts,
  runs:runs.map(r=>({text:r.text,fontId:'f'+(r.style==='bold'?1:r.style==='italic'?2:0),box:{left:r.left,top:r.top,width:r.width||r.text.length*2,height:r.small?4:8},
   observedSpans:[{text:r.text,boldTagObserved:r.style==='bold',italicTagObserved:r.style==='italic'}]}))};
 const chars=runs.flatMap(r=>[...r.text].map((unicode,i)=>({charIndex:0,unicode,unicodeCodepoint:unicode.codePointAt(0)!,
  bbox:[r.left+i*2,200-r.top-(r.small?4:8),r.left+i*2+1.8,200-r.top],origin:[r.left+i*2,200-r.top-(r.small?4:8)],matrix:[r.small?6:12,0,0,r.small?6:12,0,0],
  fontSize:1,fontWeight:r.style==='bold'?700:400,fontInfo:{reportedName:'Fixture-'+(r.style==='bold'?'Bold':r.style==='italic'?'Italic':'Regular'),descriptorFlags:r.style==='italic'?64:0,sourceFontFile:null},isGenerated:false,hasUnicodeMapError:false})))
  .map((c,i)=>({...c,charIndex:i}));
 const characterSidecar={sidecar:{policy:'pdfium-native-character-metadata-v1',binding:{sourcePdfSha256:'a'.repeat(64),physicalPage:1,existingPngSha256:'b'.repeat(64)},
  page:{cropBox:[0,0,200,200],mediaBox:[0,0,200,200],rotation:0,size:[200,200]},producer:{pypdfium2:'fixture',pdfium:'fixture'},characters:chars},sidecarSha256:'d'.repeat(64)};
 const rawJson=JSON.stringify(characterSidecar);
 return {baselineText:text,baselineSha256:sha(text),baselineSource:{rawPdfSha256:'a'.repeat(64),physicalPage:1,pngSha256:'b'.repeat(64)},
  nativeHints:{sidecar,sidecarSha256:sha(nativeHintCanonical(sidecar))},characterSidecar:{rawJson,rawSha256:sha(rawJson)}};
}
const pairs=(plan:ReturnType<typeof preparePdfCharacterStyles>)=>({pairs:plan.allowedPairs.map(({textSpanId,nativeStyleSpanId})=>({textSpanId,nativeStyleSpanId}))});
function mutateCharacters(input:PdfCharacterStyleInput,fn:(envelope:any)=>void){const data=JSON.parse(input.characterSidecar.rawJson);fn(data);
 input.characterSidecar.rawJson=JSON.stringify(data);input.characterSidecar.rawSha256=sha(input.characterSidecar.rawJson);}

test('actual character boxes and unique whole short-run anchors constrain compound math without splitting a run box',()=>{
 const input=fixture('Before formula \\(\\vec{E}\\cdot\\vec{A}+\\oiint_S q_i^2\\) After formula',[
  {text:'Before formula',left:0,top:20},{text:'E A',left:30,top:20,width:35,style:'bold'},{text:'After formula',left:60,top:20}]);
 for(const font of input.nativeHints.sidecar.fonts!)font.reportedFullName='ABCDEF+'+font.reportedFullName;
 input.nativeHints.sidecarSha256=sha(nativeHintCanonical(input.nativeHints.sidecar));
 const plan=preparePdfCharacterStyles(input),stage=stagePdfCharacterStyles(plan,pairs(plan));
 assert.equal(plan.allowedPairs.length,2);assert.equal(plan.anchors.length,2);assert.equal(plan.anchors[0].sourceText,'Before formula');
 assert.equal(stage.text,'Before formula \\(\\vec{\\mathbf{E}}\\cdot\\vec{\\mathbf{A}}+\\oiint_S q_i^2\\) After formula');
 assert.deepEqual(plan.nativeSpans.map(n=>n.box.left),[30,34]);assert.ok(plan.nativeSpans.every(n=>n.box.width<2&&n.charIndices.length===1));
 assert.ok(plan.nativeSpans.every(n=>n.effectiveScale===12),'reported fontSize=1 is combined with its actual matrix');
 assert.ok(plan.nativeSpans.every(n=>n.fontAssociation.reportedPopplerFullName==='ABCDEF+Fixture-Bold'&&n.fontAssociation.reportedPdfiumName==='Fixture-Bold'));
 assert.equal(stage.invariants.inverseByteEqual,true);assert.equal(stage.sourceProven,false);assert.equal(stage.notForApplyPageRepair,true);
 assert.equal(stage.requiresManualReview,true);validatePdfCharacterStyleStage(plan,stage);
 assert.equal(buildPdfCharacterStyles(plan).binding.rawCharacterSidecarSha256,input.characterSidecar.rawSha256);
});

test('owned prose wrappers retain exact baseline bytes and scalar prose is separate from later repeated math',()=>{
 const left='Initial context starts ',middle='Mathematical context follows ',right='Final context ends';
 const input=fixture('Title\n'+left+'x '+middle+'\\(\\vec{x}\\) '+right,[
  {text:'Title',left:0,top:0,style:'bold'},{text:left,left:0,top:20},{text:'x',left:0,top:40,style:'italic'},
  {text:middle,left:0,top:60},{text:'x',left:0,top:80,style:'bold'},{text:right,left:0,top:100}]);
 const plan=preparePdfCharacterStyles(input),stage=stagePdfCharacterStyles(plan,pairs(plan));
 assert.equal(stage.text,'**Title**\n'+left+'*x* '+middle+'\\(\\vec{\\mathbf{x}}\\) '+right);
 assert.equal(stage.operations.filter(op=>op.targetKind==='prose').length,2);assert.equal(stage.operations.filter(op=>op.targetKind==='math-leaf').length,1);
 let inverse=stage.text;for(const insertion of [...stage.insertions].reverse())inverse=inverse.slice(0,insertion.start)+inverse.slice(insertion.end);
 assert.equal(inverse,input.baselineText);assert.ok(plan.declined.some(d=>d.reason==='upright-script-restoration-not-supported'));
 const math=plan.allowedPairs.find(p=>plan.textSpans.find(t=>t.id===p.textSpanId)!.kind==='math-leaf')!;
 const scalar=plan.nativeSpans.find(n=>n.observedItalic)!;
 assert.throws(()=>validatePdfCharacterStyleSelection(plan,{pairs:[{textSpanId:math.textSpanId,nativeStyleSpanId:scalar.id}]}),/unanchored/);
});

test('ambiguous source phrases, custom encoding, style disagreement and script matrix scale decline conservatively',()=>{
 const input=fixture('Before formula \\(x\\) After formula',[
  {text:'Before formula',left:0,top:0},{text:'x',left:0,top:20,style:'bold',small:true},{text:'After formula',left:0,top:40}]);
 const small=preparePdfCharacterStyles(input);assert.equal(small.allowedPairs.length,0);assert.ok(small.declined.some(d=>d.reason==='matrix-scale-script-like-or-unknown'));
 const disagree=fixture('Before formula \\(x\\) After formula',[
  {text:'Before formula',left:0,top:0},{text:'x',left:0,top:20,style:'bold'},{text:'After formula',left:0,top:40}]);
 mutateCharacters(disagree,e=>{e.sidecar.characters.find((c:any)=>c.unicode==='x'&&c.fontWeight===700).fontWeight=400;});
 assert.equal(preparePdfCharacterStyles(disagree).allowedPairs.length,0,'flags or a font name cannot overrule conflicting actual weight');
 const repeated=fixture('Repeated heading Repeated heading',[{text:'Repeated heading',left:0,top:0,style:'bold'},{text:'Repeated heading',left:0,top:20,style:'bold'}]);
 assert.equal(preparePdfCharacterStyles(repeated).allowedPairs.length,0);
 const ambiguous=fixture('Before formula x and \\(x\\) After formula',[{text:'Before formula',left:0,top:0},{text:'x',left:0,top:20,style:'bold'},{text:'After formula',left:0,top:40}]);
 assert.equal(preparePdfCharacterStyles(ambiguous).allowedPairs.length,0,'one source cannot choose between prose and math in the same interval');
 const custom=fixture('Before formula \\(x\\) After formula',[{text:'Before formula',left:0,top:0},{text:'x',left:0,top:20,style:'bold'},{text:'After formula',left:0,top:40}]);
 mutateCharacters(custom,e=>{e.sidecar.characters.find((c:any)=>c.unicode==='x'&&c.fontWeight===700).hasUnicodeMapError=true;});
 assert.equal(preparePdfCharacterStyles(custom).allowedPairs.length,0);
 for(const unicodeCodepoint of [null,0]){
  const unknown=structuredClone(disagree);mutateCharacters(unknown,e=>{const c=e.sidecar.characters.find((c:any)=>c.unicode==='x'&&c.fontInfo.reportedName==='Fixture-Bold');
   c.unicode=null;c.unicodeCodepoint=unicodeCodepoint;});
  const unavailable=preparePdfCharacterStyles(unknown);assert.equal(unavailable.allowedPairs.length,0);
  assert.ok(unavailable.declined.some(d=>d.reason==='native-unicode-unavailable'));
 }
 const inconsistent=structuredClone(disagree);mutateCharacters(inconsistent,e=>{e.sidecar.characters[0].unicode='different';});
 assert.throws(()=>preparePdfCharacterStyles(inconsistent),/binding/,'non-null Unicode/codepoint disagreement still rejects');
});

test('changed source/charIndex/bytes, invalid pairs and tampered symbols or owned operations cannot pass validation',()=>{
 const input=fixture('Before formula \\(\\vec{x}+\\oiint_S q_i\\) After formula',[
  {text:'Before formula',left:0,top:0},{text:'x',left:0,top:20,style:'bold'},{text:'After formula',left:0,top:40}]);
 const plan=preparePdfCharacterStyles(input),selection=pairs(plan),stage=stagePdfCharacterStyles(plan,selection);
 const badBytes=structuredClone(input);badBytes.characterSidecar.rawJson+=' ';assert.throws(()=>preparePdfCharacterStyles(badBytes),/bytes/);
 const badSource=structuredClone(input);mutateCharacters(badSource,e=>{e.sidecar.binding.physicalPage=2;});assert.throws(()=>preparePdfCharacterStyles(badSource),/binding/);
 const badIndex=structuredClone(input);mutateCharacters(badIndex,e=>{e.sidecar.characters[0].charIndex=4;});assert.throws(()=>preparePdfCharacterStyles(badIndex),/binding/);
 assert.throws(()=>validatePdfCharacterStyleSelection(plan,{pairs:[...selection.pairs,...selection.pairs]}),/duplicate/);
 assert.throws(()=>validatePdfCharacterStyleSelection(plan,{pairs:[{...selection.pairs[0],textSpanId:'unknown'}]}),/Unknown/);
 for(const [from,to] of [['\\vec','\\hat'],['\\oiint','\\iint'],['_i','_j'],['Before','before']]){
  const changed=structuredClone(stage);changed.text=changed.text.replace(from,to);changed.derivedTextSha256=sha(changed.text);
  assert.throws(()=>validatePdfCharacterStyleStage(plan,changed),/exact reversible/);
 }
 const changed=structuredClone(stage);changed.operations[0].sourceCharIndices=[999];assert.throws(()=>validatePdfCharacterStyleStage(plan,changed),/exact reversible/);
});

test('consecutive native word windows cross real style transitions but never an unknown or generated gap',()=>{
 const input=fixture('Before expression \\(\\vec{v}\\) v distinct boundary follows',[
  {text:'Before expression',left:0,top:0},{text:'v',left:0,top:20,style:'bold'},
  {text:'v ',left:0,top:40},{text:'distinct',left:4,top:40,style:'italic'},{text:' boundary follows',left:20,top:40}]);
 const plan=preparePdfCharacterStyles(input),stage=stagePdfCharacterStyles(plan,pairs(plan));
 assert.equal(stage.operations.filter(op=>op.targetKind==='math-leaf').length,1);
 const windows=plan.anchors.filter(a=>a.match==='continuous-style-transition-word-window');assert.ok(windows.length);
 assert.ok(windows.some(a=>a.sourceText==='v distinct boundary follows'));
 for(const window of windows)assert.ok(window.charIndices.every((index,i)=>i===0||index===window.charIndices[i-1]+1));
 const complete=plan.anchors.filter(a=>a.match==='complete-continuous-physical-segment');assert.ok(complete.some(a=>a.sourceText==='v distinct boundary follows'));
 for(const segment of complete)assert.ok(segment.charIndices.every((index,i)=>i===0||index===segment.charIndices[i-1]+1));
 const gap=structuredClone(input);mutateCharacters(gap,e=>{const characters=e.sidecar.characters,marker=characters.findIndex((c:any)=>c.unicode==='d'&&c.fontInfo.reportedName==='Fixture-Italic');
  characters[marker-1].isGenerated=true;});
 const rejected=preparePdfCharacterStyles(gap);
 assert.equal(rejected.allowedPairs.filter(p=>rejected.textSpans.find(t=>t.id===p.textSpanId)!.kind==='math-leaf').length,0,'a discontinuous source cannot move the prose boundary');
});
