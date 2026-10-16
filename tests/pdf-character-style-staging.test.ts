import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeHintCanonical} from '../lib/pdf-native-hints.ts';
import {preparePdfCharacterStyles,buildPdfCharacterStyles,stagePdfCharacterStyles,validatePdfCharacterStyleStage,validatePdfCharacterStyleSelection,
 stagePdfCharacterGeometry,type PdfCharacterStyleInput,type PdfCharacterGeometryEvidence} from '../lib/pdf-character-style-staging.ts';

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

test('derived geometry preserves actual lines, unique UTF16 associations, grids, font sizes and a bounded integral lower relation',()=>{
 const input=fixture('Header left\nHeader center\nHeader right\nRow one label    Row one value\nRow two label    Row two value\nBefore math relation\n\\[\\iint_T x\\]\nAfter math relation\nFooter left\nFooter right',[
  {text:'Header left',left:0,top:0,style:'bold'},{text:'Header center',left:70,top:0,style:'bold'},{text:'Header right',left:140,top:0,style:'bold'},
  {text:'Row one label',left:0,top:20},{text:'Row one value',left:100,top:20},{text:'Row two label',left:0,top:40},{text:'Row two value',left:100,top:40},
  {text:'Before math relation',left:0,top:60},{text:'∫∫',left:60,top:85},{text:'T',left:61,top:100,small:true},{text:'After math relation',left:0,top:125},
  {text:'Footer left',left:0,top:170},{text:'Footer right',left:140,top:170}]);
 input.nativeHints.sidecar.binding.png.width=400;input.nativeHints.sidecar.binding.png.height=600;
 input.nativeHints.sidecar.coordinateSystem!.pngScaleX=2;input.nativeHints.sidecar.coordinateSystem!.pngScaleY=3;
 input.nativeHints.sidecarSha256=sha(nativeHintCanonical(input.nativeHints.sidecar));
 const plan=preparePdfCharacterStyles(input),stage=stagePdfCharacterStyles(plan,{pairs:[]}),geometry=stagePdfCharacterGeometry(plan,stage,
  {existingLayout:{source:input.baselineSource,manifestSha256:null,layout:null}});
 if(!('lines' in geometry)||!('grids' in geometry)||!('mathLinks' in geometry))throw Error('Missing geometry');
 assert.equal(geometry.basis,'derived-native-geometry');assert.equal(geometry.lines[0].segments.length,3);
 const first=geometry.lines[0].segments[0];assert.equal(first.pngBox.width,first.box.width*2);assert.equal(first.pngBox.height,first.box.height*3);
 assert.equal(first.candidate?.text,'Header left');assert.equal(first.fontObservations[0].matrixScalePt,12);
 assert.equal(geometry.grids.length,1);assert.equal(geometry.grids[0].lineIndices.length,2);assert.equal(geometry.grids[0].columns,2);
 assert.equal(geometry.mathLinks.length,1);assert.equal(geometry.mathLinks[0].lowerLimit.existingText,'T');assert.equal(geometry.mathLinks[0].lowerLimit.matrixScalePt,6);
 assert.equal(geometry.authorHeadingLevels,null);assert.equal(geometry.authorTableSemantics,null);assert.equal(geometry.textModified,false);assert.equal(stage.text,input.baselineText);
 assert.equal(geometry.sourceProven,false);assert.equal(geometry.notForApplyPageRepair,true);assert.equal(geometry.requiresManualReview,true);
});

test('geometry refuses ambiguous text, stale layout/source/frame and unbound cross-source maps, while preferring a bound existing layout',()=>{
 const input=fixture('Repeated cell\nRepeated cell',[{text:'Repeated cell',left:0,top:0},{text:'Repeated cell',left:0,top:20}]),
  plan=preparePdfCharacterStyles(input),stage=stagePdfCharacterStyles(plan,{pairs:[]}),evidence:PdfCharacterGeometryEvidence={existingLayout:{source:input.baselineSource,manifestSha256:null,layout:null}};
 const geometry=stagePdfCharacterGeometry(plan,stage,evidence);if(!('lines' in geometry))throw Error('Missing geometry');
 assert.ok(geometry.lines.every(l=>l.segments.every(s=>s.candidate===null)));
 assert.throws(()=>stagePdfCharacterGeometry(plan,stage,{existingLayout:{...evidence.existingLayout,source:{...input.baselineSource,pngSha256:'e'.repeat(64)}}}),/binding/);
 const native={status:'available' as const,regions:[],pageSizes:[{pageNumber:1,width:200,height:200}]},preferred=stagePdfCharacterGeometry(plan,stage,
  {existingLayout:{...evidence.existingLayout,manifestSha256:'f'.repeat(64),layout:native}});
 assert.equal(preferred.basis,'existing-docling-layout');assert.deepEqual(preferred.existingLayout,native);assert.deepEqual(preferred.lines,[]);
 assert.throws(()=>stagePdfCharacterGeometry(plan,stage,{existingLayout:{...evidence.existingLayout,layout:native}}),/manifest/);
 assert.throws(()=>stagePdfCharacterGeometry(plan,stage,{existingLayout:{...evidence.existingLayout,manifestSha256:'f'.repeat(64),layout:{...native,pageSizes:[{pageNumber:1,width:201,height:200}]}}}),/frame/);
 const rotated=structuredClone(input);rotated.nativeHints.sidecar.binding.frame!.rotationDegrees=90;rotated.nativeHints.sidecarSha256=sha(nativeHintCanonical(rotated.nativeHints.sidecar));
 assert.throws(()=>preparePdfCharacterStyles(rotated),/frame/);
 const scaled=structuredClone(input);scaled.nativeHints.sidecar.coordinateSystem!.pngScaleX=2;scaled.nativeHints.sidecarSha256=sha(nativeHintCanonical(scaled.nativeHints.sidecar));
 const sp=preparePdfCharacterStyles(scaled),ss=stagePdfCharacterStyles(sp,{pairs:[]});assert.throws(()=>stagePdfCharacterGeometry(sp,ss,evidence),/frame/);
 const unknown=structuredClone(input);mutateCharacters(unknown,e=>{e.sidecar.characters[0].unicode=null;e.sidecar.characters[0].unicodeCodepoint=null;});
 const up=preparePdfCharacterStyles(unknown),us=stagePdfCharacterStyles(up,{pairs:[]}),unmapped=stagePdfCharacterGeometry(up,us,evidence);
 assert.ok(unmapped.lines.some(l=>l.segments.some(s=>s.untrustedCharacterCount>0&&s.candidate===null)));
 const interleaved=fixture('Left column\nRight column',[{text:'Left column',left:0,top:0},{text:'Right column',left:100,top:0}]);
 mutateCharacters(interleaved,e=>{const left=e.sidecar.characters.filter((c:any)=>c.bbox[0]<50),right=e.sidecar.characters.filter((c:any)=>c.bbox[0]>=50);
  e.sidecar.characters=Array.from({length:Math.max(left.length,right.length)},(_,i)=>[left[i],right[i]]).flat().filter(Boolean).map((c:any,i)=>({...c,charIndex:i}));});
 const ip=preparePdfCharacterStyles(interleaved),is=stagePdfCharacterStyles(ip,{pairs:[]}),ig=stagePdfCharacterGeometry(ip,is,evidence),
  interleavedChars=JSON.parse(interleaved.characterSidecar.rawJson).sidecar.characters;
 assert.equal(ig.lines[0].segments.length,2);
 for(const segment of ig.lines[0].segments){assert.equal(segment.candidate,null,'interleaved source order cannot associate text across spatial columns');
  assert.deepEqual(segment.charIndices,interleavedChars.filter((c:any)=>(c.bbox[0]<50)===(segment.box.left<50)&&c.unicode.trim()).map((c:any)=>c.charIndex));}
 const cross=structuredClone(input);cross.baselineSource.rawPdfSha256='e'.repeat(64);
 const map={source:{sourceHash:cross.baselineSource.rawPdfSha256},upstreamPdfSha256:input.baselineSource.rawPdfSha256,upstreamPhysicalPage:1,authorityPhysicalPage:1,
  visual:{layoutStatus:'unavailable',manifestSha256:'f'.repeat(64),images:[{kind:'pdf-page',physicalPage:1,sha256:input.baselineSource.pngSha256,width:200,height:200,
   provenance:{rawPdfSha256:cross.baselineSource.rawPdfSha256,pageRenderSha256:input.baselineSource.pngSha256,rotation:0,sourcePageCropBox:input.nativeHints.sidecar.binding.frame!.cropBox,pageSizePoints:{width:200,height:200}}}]}},
  raw=JSON.stringify(map);cross.baselineSource.pageMap={reference:'stored-original-page-map',sha256:sha(raw)};
 const cp=preparePdfCharacterStyles(cross),cs=stagePdfCharacterStyles(cp,{pairs:[]}),ce={existingLayout:{source:cross.baselineSource,manifestSha256:'f'.repeat(64),layout:null}};
 assert.throws(()=>stagePdfCharacterGeometry(cp,cs,ce),/page map/);
 assert.throws(()=>stagePdfCharacterGeometry(cp,cs,{...ce,pageMapRawJson:raw+' '}),/page map/);
 const bound=stagePdfCharacterGeometry(cp,cs,{...ce,pageMapRawJson:raw});assert.equal(bound.binding.nativeSourcePdfSha256,input.baselineSource.rawPdfSha256);
 assert.equal(bound.binding.authorityPdfSha256,cross.baselineSource.rawPdfSha256);assert.equal(bound.sourceProven,false);
 assert.equal(bound.binding.pageMapping,'declared-artifact-mapping-not-independent-PDF-proof');
});
