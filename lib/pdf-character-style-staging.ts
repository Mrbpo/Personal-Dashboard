import {createHash} from 'node:crypto';
import {nativeHintCanonical} from './pdf-native-hints.ts';
import {preparePdfStyleSelection,type PdfStyleInput} from './pdf-source-style-staging.ts';
import {visualMathStructureIssue} from './pdf-visual-structure.ts';

const policy='pdf-character-style-staging-v3.3';
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const same=(a:unknown,b:unknown)=>nativeHintCanonical(a)===nativeHintCanonical(b);
const isSha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
type Box={left:number;top:number;width:number;height:number};
type Character={charIndex:number;unicode:string|null;unicodeCodepoint:number|null;bbox:number[]|null;origin:number[]|null;matrix:number[]|null;
 fontSize:number|null;fontWeight:number|null;fontInfo:{reportedName:string;descriptorFlags:number;sourceFontFile:null}|null;isGenerated:boolean|null;hasUnicodeMapError:boolean|null};
type CharacterSidecar={policy:string;binding:{sourcePdfSha256:string;physicalPage:number;existingPngSha256:string};
 page:{cropBox:number[];mediaBox:number[];rotation:number;size:number[]};producer:{pypdfium2:string;pdfium:string};characters:Character[]};
export type PdfCharacterStyleInput=PdfStyleInput&{characterSidecar:{rawJson:string;rawSha256:string}};
type Declined={scope:string;reason:string};
type DecodedCharacter=Character&{unicode:string;unicodeCodepoint:number};
type LocatedCharacter={record:DecodedCharacter;box:Box;scale:number};
type RunEvidence={runIndex:number;text:string;box:Box;characters:LocatedCharacter[];observedBold:boolean;observedItalic:boolean;
 fontAssociation:{reportedPopplerFullName:string;reportedPdfiumName:string;normalization:'six-uppercase-subset-prefix-only'}};
type Anchor={id:string;runIndex:number|null;sourceText:string;baselineStart:number;baselineEnd:number;box:Box;charIndices:number[];effectiveScale:number;
 match:'whole-native-run-unique-phrase'|'continuous-style-transition-word-window'|'complete-continuous-physical-segment';sourceMatchCount:1;baselineMatchCount:1};
type Target={id:string;start:number;end:number;text:string;kind:'math-leaf'|'prose';atom:string|null};
type Native={id:string;runIndex:number;sourceText:string;charIndices:number[];box:Box;observedBold:boolean;observedItalic:boolean;
 atom:string|null;effectiveScale:number;association:'exact-run-decoding-and-font-geometry';encodingVerification:'not-certified';fontAssociation:RunEvidence['fontAssociation']};
type AllowedPair={textSpanId:string;nativeStyleSpanId:string;alignment:'double-prose-anchor-interval'|'unique-native-prose-phrase'|'anchored-native-prose-phrase';
 leftAnchorId:string|null;rightAnchorId:string|null};
export type PdfCharacterStylePlan={policy:typeof policy;input:PdfCharacterStyleInput;binding:{rawCharacterSidecarSha256:string;parsedCharacterSidecarSha256:string;producerReportedSidecarSha256:string|null};
 anchors:Anchor[];textSpans:Target[];nativeSpans:Native[];allowedPairs:AllowedPair[];declined:Declined[];status:'available'|'unavailable';
 alignmentVerification:'unverified';sourceProven:false;planSha256:string};
type Selection={pairs:Array<{textSpanId:string;nativeStyleSpanId:string}>};
type Operation={start:number;end:number;before:string;after:string;opening:string;closing:string;textSpanId:string;nativeStyleSpanId:string;
 kind:'owned-positive-native-style-wrapper';targetKind:Target['kind'];sourceCharIndices:number[]};
type Insertion={start:number;end:number;text:string};
type Stage={kind:'source-character-style-derived-staging';transformVersion:typeof policy;planSha256:string;baselineSha256:string;sourceEvidenceSha256:string;
 selection:Selection;operations:Operation[];insertions:Insertion[];text:string;derivedTextSha256:string;sourceProven:false;requiresManualReview:true;
 notForApplyPageRepair:true;alignmentVerification:'unverified';invariants:{inverseByteEqual:true;baselineMathBodiesSha256:string};warning:string};
const finite=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const validBox=(box:Box)=>Object.values(box).every(finite)&&box.width>0&&box.height>0;
const centerInside=(small:Box,large:Box)=>small.left+small.width/2>=large.left&&small.left+small.width/2<=large.left+large.width&&
 small.top+small.height/2>=large.top&&small.top+small.height/2<=large.top+large.height;
const union=(chars:LocatedCharacter[]):Box=>({left:Math.min(...chars.map(c=>c.box.left)),top:Math.min(...chars.map(c=>c.box.top)),
 width:Math.max(...chars.map(c=>c.box.left+c.box.width))-Math.min(...chars.map(c=>c.box.left)),
 height:Math.max(...chars.map(c=>c.box.top+c.box.height))-Math.min(...chars.map(c=>c.box.top))});
// A whole-box geometric partial order, not proof of columns or logical reading order.
const before=(a:Box,b:Box)=>(a.top<b.top+b.height&&b.top<a.top+a.height&&a.left+a.width<=b.left)||
 (a.left<b.left+b.width&&b.left<a.left+a.width&&a.top+a.height<=b.top);
const median=(numbers:number[])=>[...numbers].sort((a,b)=>a-b)[Math.floor(numbers.length/2)];
const unsafeFont=(name:string)=>!name.trim()||/symbol|extra|dingbat|type3/i.test(name);
// PDF subset tags have exactly six uppercase ASCII letters plus '+'. No family/style aliases are inferred.
const baseFontName=(name:string)=>name.replace(/^[A-Z]{6}\+/,'');
const atom=(value:string)=>/^[A-Za-z\u0370-\u03ff]$/u.test(value)?value:null;
const word=(value:string|undefined)=>Boolean(value&&/[\p{L}\p{N}]/u.test(value));
const verticalOverlap=(a:Box,b:Box)=>a.top<b.top+b.height&&b.top<a.top+a.height;
const decoded=(c:Character):c is DecodedCharacter=>c.unicode!==null&&c.unicodeCodepoint!==null;
const validUnicodePair=(c:Character)=>c.unicode===null?(c.unicodeCodepoint===null||c.unicodeCodepoint===0):
 typeof c.unicode==='string'&&Number.isInteger(c.unicodeCodepoint)&&c.unicodeCodepoint!==null&&c.unicodeCodepoint>=0&&c.unicodeCodepoint<=0x10ffff&&
 c.unicode===String.fromCodePoint(c.unicodeCodepoint);

function mathRanges(text:string){return [...text.matchAll(/\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]/g)].map(match=>({start:match.index!,end:match.index!+match[0].length,body:match[0].slice(2,-2)}));}
function proseRanges(text:string){const ranges:Array<{start:number;end:number}>=[];let cursor=0;
 for(const range of mathRanges(text)){ranges.push({start:cursor,end:range.start});cursor=range.end;}ranges.push({start:cursor,end:text.length});return ranges;}
function canonicalText(text:string){let value='';const offsets:Array<{start:number;end:number}>=[];
 for(const match of text.matchAll(/\s+|[^\s]/gu)){const next=/^\s+$/u.test(match[0])?' ':match[0];value+=next;for(let i=0;i<next.length;i++)offsets.push({start:match.index!,end:match.index!+match[0].length});}
 return {value,offsets};}
function occurrences(text:string,phrase:string,ranges:Array<{start:number;end:number}>){const result:Array<{start:number;end:number}>=[];
 const needle=canonicalText(phrase.trim()).value;if(!needle)return result;
 for(const range of ranges){const hay=canonicalText(text.slice(range.start,range.end));let from=0,index:number;
  while((index=hay.value.indexOf(needle,from))>=0){from=index+1;
   if(word(needle[0])&&word(hay.value[index-1])||word(needle.at(-1))&&word(hay.value[index+needle.length]))continue;
   result.push({start:range.start+hay.offsets[index].start,end:range.start+hay.offsets[index+needle.length-1].end});
  }}return result;}
function freeze(value:unknown):void{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}}
function seal(plan:Omit<PdfCharacterStylePlan,'planSha256'>):PdfCharacterStylePlan{const result={...plan,planSha256:sha(nativeHintCanonical(plan))};freeze(result);return result;}

function readCharacters(input:PdfCharacterStyleInput){
 const {rawJson,rawSha256}=input.characterSidecar;
 if(typeof rawJson!=='string'||Buffer.byteLength(rawJson)>8*1024*1024||!isSha(rawSha256)||sha(rawJson)!==rawSha256)throw Error('Changed character sidecar bytes');
 const envelope=JSON.parse(rawJson) as {sidecar:CharacterSidecar;sidecarSha256?:unknown},s=envelope.sidecar,h=input.nativeHints.sidecar;
 if(!s||s.policy!=='pdfium-native-character-metadata-v1'||!s.producer?.pypdfium2||!s.producer.pdfium||
  s.binding.sourcePdfSha256!==h.binding.sourcePdfSha256||s.binding.physicalPage!==h.binding.physicalPage||s.binding.existingPngSha256!==h.binding.png.sha256||
  !Array.isArray(s.characters)||s.characters.length>20000||s.characters.some((c,i)=>!c||c.charIndex!==i||!validUnicodePair(c)))throw Error('Character source/page/PNG/index binding differs');
 const frame=h.binding.frame;
 if(!frame||!h.coordinateSystem||s.page.rotation!==0||frame.rotationDegrees!==0||frame.userUnit!==1||
  !same(s.page.mediaBox,[frame.mediaBox.x,frame.mediaBox.y,frame.mediaBox.x+frame.mediaBox.width,frame.mediaBox.y+frame.mediaBox.height])||
  !same(s.page.cropBox,[0,0,h.coordinateSystem!.width,h.coordinateSystem!.height])||!same(s.page.cropBox,s.page.mediaBox)||
  !same(s.page.size,[h.coordinateSystem!.width,h.coordinateSystem!.height]))throw Error('Unsupported or different character page frame');
 // Raw UTF-8 bytes are verified above. The producer's Python-number canonical hash is retained as reported metadata,
 // while this module separately binds its parsed semantic representation; it does not pretend both encodings are equal.
 return {sidecar:s,binding:{rawCharacterSidecarSha256:rawSha256,parsedCharacterSidecarSha256:sha(nativeHintCanonical(s)),
  producerReportedSidecarSha256:isSha(envelope.sidecarSha256)?envelope.sidecarSha256:null}};
}

/** Pure overlay eligibility only: no PDF read/parse, model, persistence or decoded-source truth claim. */
export function preparePdfCharacterStyles(value:PdfCharacterStyleInput):PdfCharacterStylePlan{
 const input=structuredClone(value),old=preparePdfStyleSelection(input),{sidecar,binding}=readCharacters(input),declined:Declined[]=[],runs=input.nativeHints.sidecar.runs||[];
 const empty=(reason:string)=>seal({policy,input,binding,anchors:[],textSpans:[],nativeSpans:[],allowedPairs:[],declined:[{scope:'page',reason}],status:'unavailable',alignmentVerification:'unverified',sourceProven:false});
 if(old.input.nativeHints.sidecar.status!=='available')return empty('native-runs-unavailable');
 if(runs.length>512)return empty('native-run-limit');
 const height=sidecar.page.size[1],located:LocatedCharacter[]=[],segments:LocatedCharacter[][]=[];let segment:LocatedCharacter[]=[];
 const flush=()=>{if(segment.length)segments.push(segment);segment=[];};
 for(const c of sidecar.characters){
  if(!decoded(c)){declined.push({scope:`char:${c.charIndex}`,reason:'native-unicode-unavailable'});flush();continue;}
  if(c.isGenerated!==false||c.hasUnicodeMapError!==false||!c.fontInfo||unsafeFont(c.fontInfo.reportedName)||/[\u0000-\u001f\u007f-\u009f]/u.test(c.unicode)){flush();continue;}
  const b=c.bbox,m=c.matrix;if(!b||b.length!==4||!b.every(finite)||!m||m.length!==6||!m.every(finite)||m[1]!==0||m[2]!==0||!finite(c.fontSize)||c.fontSize<=0||
   !c.origin||c.origin.length!==2||!c.origin.every(finite)){flush();continue;}
  const box={left:b[0],top:height-b[3],width:b[2]-b[0],height:b[3]-b[1]},scale=c.fontSize*Math.hypot(m[2],m[3]);
  if(!validBox(box)||scale<=0){flush();continue;}
  const current={record:c,box,scale},previous=segment.at(-1);
  // An observed continuous, forward, vertically overlapping text flow only. No line/column order is invented.
  if(previous&&(previous.record.charIndex+1!==c.charIndex||c.origin[0]<=previous.record.origin![0]||!verticalOverlap(previous.box,box)))flush();
  segment.push(current);if(c.unicode.trim())located.push(current);
 }
 flush();
 const evidence:RunEvidence[]=[];
 for(const [runIndex,run] of runs.entries()){
  const font=input.nativeHints.sidecar.fonts?.find(f=>f.id===run.fontId);
  if(!font||unsafeFont(font.reportedFullName)||!validBox(run.box)||!run.observedSpans?.length||run.observedSpans.map(s=>s.text).join('')!==run.text){declined.push({scope:`run:${runIndex}`,reason:'unsupported-native-run'});continue;}
  const chars=located.filter(c=>baseFontName(c.record.fontInfo!.reportedName)===baseFontName(font.reportedFullName)&&centerInside(c.box,run.box));
  // Each box remains on its original charIndex/Unicode record. An exact decoded-run check establishes only
  // a conservative association; no separately extracted text is zipped with a list of rectangles.
  if(!chars.length||new Set(chars.map(c=>c.record.fontInfo!.reportedName)).size!==1||chars.map(c=>c.record.unicode).join('')!==run.text.replace(/\s/gu,'')){
   declined.push({scope:`run:${runIndex}`,reason:'run-character-association-unavailable'});continue;
  }
  const bold=run.observedSpans.every(s=>s.boldTagObserved&&!s.italicTagObserved),italic=run.observedSpans.every(s=>s.italicTagObserved&&!s.boldTagObserved);
  if(bold&&!chars.every(c=>c.record.fontWeight!==null&&c.record.fontWeight>=700)||
   italic&&!chars.every(c=>Boolean(c.record.fontInfo!.descriptorFlags&64)&&/italic|oblique/i.test(c.record.fontInfo!.reportedName))){
   declined.push({scope:`run:${runIndex}`,reason:'native-style-observations-disagree'});continue;
  }
  evidence.push({runIndex,text:run.text,box:union(chars),characters:chars,observedBold:bold,observedItalic:italic,
   fontAssociation:{reportedPopplerFullName:font.reportedFullName,reportedPdfiumName:chars[0].record.fontInfo!.reportedName,normalization:'six-uppercase-subset-prefix-only'}});
 }
 const text=input.baselineText,prose=proseRanges(text),sourceCount=(phrase:string)=>runs.reduce((n,r)=>n+occurrences(r.text,phrase,[{start:0,end:r.text.length}]).length,0);
 const anchors:Anchor[]=[];
 for(const run of evidence){const phrase=run.text.trim(),matches=occurrences(text,phrase,prose);
  if((phrase.match(/[\p{L}\p{N}]+/gu)||[]).length<2||sourceCount(phrase)!==1||matches.length!==1||
   occurrences(text,phrase,[{start:0,end:text.length}]).length!==1)continue;
  const a={runIndex:run.runIndex,sourceText:phrase,baselineStart:matches[0].start,baselineEnd:matches[0].end,box:run.box,
   charIndices:run.characters.map(c=>c.record.charIndex),effectiveScale:median(run.characters.map(c=>c.scale)),match:'whole-native-run-unique-phrase' as const,sourceMatchCount:1 as const,baselineMatchCount:1 as const};
  anchors.push({...a,id:'a3:'+sha(nativeHintCanonical(a)).slice(0,24)});
 }
 // A style split is not a prose boundary. Use only short windows of consecutive original character records,
 // never a stitched native whole page. Pick the longest unique window around each observed font transition;
 // ties use the earliest original character, independently of any prospective math/prose candidate.
 const flows=segments.map(chars=>{let value='';const positions=chars.map(c=>{const position={start:value.length,end:value.length+c.record.unicode.length,c};value+=c.record.unicode;return position;});return {value,positions};});
 for(const flow of flows){
  // Full observed segment, bounded rather than truncated. Its source records are consecutive and pass the
  // same forward/overlap checks above; this is not a claim about columns or whole-page reading order.
  if(Buffer.byteLength(flow.value)>512){declined.push({scope:`segment:${flow.positions[0].c.record.charIndex}`,reason:'physical-segment-text-limit'});continue;}
  if((flow.value.match(/[\p{L}\p{N}]+/gu)||[]).length<2)continue;
  const matches=occurrences(text,flow.value,prose);
  if(matches.length!==1||occurrences(text,flow.value,[{start:0,end:text.length}]).length!==1||
   flows.reduce((n,f)=>n+occurrences(f.value,flow.value,[{start:0,end:f.value.length}]).length,0)!==1)continue;
  const chars=flow.positions.map(p=>p.c),a={runIndex:null,sourceText:flow.value,baselineStart:matches[0].start,baselineEnd:matches[0].end,
   box:union(chars),charIndices:chars.map(c=>c.record.charIndex),effectiveScale:median(chars.map(c=>c.scale)),match:'complete-continuous-physical-segment' as const,
   sourceMatchCount:1 as const,baselineMatchCount:1 as const};
  anchors.push({...a,id:'a3:'+sha(nativeHintCanonical(a)).slice(0,24)});
 }
 for(const flow of flows){
  const words=[...flow.value.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)],windows:Array<{chars:LocatedCharacter[];phrase:string;start:number;end:number;words:number}>=[];
  const cuts=flow.positions.filter((p,i)=>i>0&&p.c.record.fontInfo!.reportedName!==flow.positions[i-1].c.record.fontInfo!.reportedName).map(p=>p.c.record.charIndex);
  if(!cuts.length)continue;
  for(let i=0;i<words.length;i++)for(let count=2;count<=8&&i+count<=words.length;count++){
   const start=words[i].index!,end=words[i+count-1].index!+words[i+count-1][0].length,chars=flow.positions.filter(p=>p.start>=start&&p.end<=end).map(p=>p.c);
   if(!cuts.some(cut=>chars[0].record.charIndex<cut&&chars.at(-1)!.record.charIndex>=cut))continue;
   const phrase=flow.value.slice(start,end),matches=occurrences(text,phrase,prose);
   if(matches.length!==1||occurrences(text,phrase,[{start:0,end:text.length}]).length!==1||
    flows.reduce((n,f)=>n+occurrences(f.value,phrase,[{start:0,end:f.value.length}]).length,0)!==1)continue;
   windows.push({chars,phrase,start:matches[0].start,end:matches[0].end,words:count});
  }
  for(const cut of cuts){const chosen=windows.filter(w=>w.chars[0].record.charIndex<cut&&w.chars.at(-1)!.record.charIndex>=cut)
   .sort((a,b)=>b.words-a.words||a.chars[0].record.charIndex-b.chars[0].record.charIndex)[0];if(!chosen)continue;
   const a={runIndex:null,sourceText:chosen.phrase,baselineStart:chosen.start,baselineEnd:chosen.end,box:union(chosen.chars),charIndices:chosen.chars.map(c=>c.record.charIndex),
    effectiveScale:median(chosen.chars.map(c=>c.scale)),match:'continuous-style-transition-word-window' as const,sourceMatchCount:1 as const,baselineMatchCount:1 as const};
   const id='a3:'+sha(nativeHintCanonical(a)).slice(0,24);if(!anchors.some(a=>a.id===id))anchors.push({...a,id});
  }
 }
 const endpoint=(anchor:Anchor,last:boolean)=>{
  // Matching trims outer whitespace only. Keep every actual box/index on the anchor, but compare the
  // corresponding non-whitespace text boundary when a full segment and a run/window share one edge.
  const indices=anchor.charIndices.filter(index=>sidecar.characters[index].unicode?.trim());return last?indices.at(-1):indices[0];
 };
 const interval=(box:Box,runIndex:number)=>{
  const left=anchors.filter(a=>a.runIndex!==runIndex&&before(a.box,box)).sort((a,b)=>b.baselineEnd-a.baselineEnd),
   right=anchors.filter(a=>a.runIndex!==runIndex&&before(box,a.box)).sort((a,b)=>a.baselineStart-b.baselineStart),l=left[0],r=right[0];
  // Multiple windows can share the exact same source/baseline boundary. They are the same boundary evidence;
  // tied baseline boundaries with different original endpoint characters remain ambiguous and are rejected.
  return !l||!r||l.baselineEnd>=r.baselineStart||!before(l.box,r.box)||
   left.some(a=>a.baselineEnd===l.baselineEnd&&endpoint(a,true)!==endpoint(l,true))||
   right.some(a=>a.baselineStart===r.baselineStart&&endpoint(a,false)!==endpoint(r,false))?null:{l,r};
 };
 const textSpans:Target[]=[],nativeSpans:Native[]=[],proposed:AllowedPair[]=[];
 const add=(target:Omit<Target,'id'>,native:Omit<Native,'id'>,pair:Omit<AllowedPair,'textSpanId'|'nativeStyleSpanId'>)=>{
  const t={...target,id:'t3:'+sha(nativeHintCanonical({baseline:input.baselineSha256,...target})).slice(0,24)},n={...native,id:'n3:'+sha(nativeHintCanonical({raw:binding.rawCharacterSidecarSha256,...native})).slice(0,24)};
  if(!textSpans.some(x=>x.id===t.id))textSpans.push(t);if(!nativeSpans.some(x=>x.id===n.id))nativeSpans.push(n);proposed.push({...pair,textSpanId:t.id,nativeStyleSpanId:n.id});
 };
 for(const run of evidence){
  if(!run.observedBold&&!run.observedItalic)continue;
  const base={runIndex:run.runIndex,observedBold:run.observedBold,observedItalic:run.observedItalic,association:'exact-run-decoding-and-font-geometry' as const,encodingVerification:'not-certified' as const,
   fontAssociation:run.fontAssociation};
  const phrase=run.text.trim(),matches=occurrences(text,phrase,prose),bounds=interval(run.box,run.runIndex);
  const bounded=matches.filter(m=>bounds&&m.start>=bounds.l.baselineEnd&&m.end<=bounds.r.baselineStart),
   unique=sourceCount(phrase)===1&&matches.length===1&&occurrences(text,phrase,[{start:0,end:text.length}]).length===1;
  const chosen=unique?matches[0]:bounded.length===1&&bounds&&
   occurrences(text,phrase,[{start:bounds.l.baselineEnd,end:bounds.r.baselineStart}]).length===1?bounded[0]:null;
  if(chosen&&!/[\\*`<>]/u.test(text.slice(chosen.start,chosen.end))){
   add({...chosen,text:text.slice(chosen.start,chosen.end),kind:'prose',atom:null},{...base,sourceText:phrase,charIndices:run.characters.map(c=>c.record.charIndex),box:run.box,atom:null,effectiveScale:median(run.characters.map(c=>c.scale))},
    {alignment:unique?'unique-native-prose-phrase':'anchored-native-prose-phrase',leftAnchorId:unique?null:bounds!.l.id,rightAnchorId:unique?null:bounds!.r.id});
   continue;
  }
  if(run.observedItalic){declined.push({scope:`run:${run.runIndex}`,reason:'prose-not-uniquely-mapped-or-math-italic-already-default'});continue;}
  for(const c of run.characters){const value=atom(c.record.unicode);if(!value)continue;
   const bounds=interval(c.box,run.runIndex);
   if(!bounds){declined.push({scope:`char:${c.record.charIndex}`,reason:'no-unique-double-prose-anchor-interval'});continue;}
   if(c.scale<.8*Math.min(bounds.l.effectiveScale,bounds.r.effectiveScale)){
    declined.push({scope:`char:${c.record.charIndex}`,reason:'matrix-scale-script-like-or-unknown'});continue;
   }
   const leaves=old.textSpans.filter(t=>t.start>=bounds.l.baselineEnd&&t.end<=bounds.r.baselineStart&&
    (t.atom===value||t.text===value||old.nativeSpans.some(n=>n.fragment===value&&n.atom===t.atom)));
   const competingProse=occurrences(text,c.record.unicode,prose).some(m=>m.start>=bounds.l.baselineEnd&&m.end<=bounds.r.baselineStart);
   if(leaves.length!==1||competingProse){declined.push({scope:`char:${c.record.charIndex}`,reason:'no-unique-math-leaf-in-interval'});continue;}
   const target=leaves[0];add({start:target.start,end:target.end,text:target.text,kind:'math-leaf',atom:target.atom},
    {...base,sourceText:c.record.unicode,charIndices:[c.record.charIndex],box:c.box,atom:target.atom,effectiveScale:c.scale},
    {alignment:'double-prose-anchor-interval',leftAnchorId:bounds.l.id,rightAnchorId:bounds.r.id});
  }
 }
 const allowedPairs=proposed.filter(pair=>{if(proposed.filter(p=>p.textSpanId===pair.textSpanId).length===1&&proposed.filter(p=>p.nativeStyleSpanId===pair.nativeStyleSpanId).length===1)return true;
  declined.push({scope:pair.nativeStyleSpanId,reason:'competing-native-or-baseline-occurrences'});return false;});
 if(textSpans.length>256||nativeSpans.length>256||anchors.length>256)return empty('style-candidate-limit');
 declined.push({scope:'scripts',reason:'upright-script-restoration-not-supported'});
 return seal({policy,input,binding,anchors,textSpans,nativeSpans,allowedPairs,declined,status:allowedPairs.length?'available':'unavailable',alignmentVerification:'unverified',sourceProven:false});
}
function assertPlan(plan:PdfCharacterStylePlan){if(!same(plan,preparePdfCharacterStyles(plan.input)))throw Error('Character style plan changed');}
export function buildPdfCharacterStyles(plan:PdfCharacterStylePlan){assertPlan(plan);return {policy,binding:{planSha256:plan.planSha256,...plan.binding},
 textSpans:plan.textSpans,nativeSpans:plan.nativeSpans,anchors:plan.anchors,allowedPairs:plan.allowedPairs,warning:'Eligibility only; no automatic application or source-proof claim.'};}
export function validatePdfCharacterStyleSelection(plan:PdfCharacterStylePlan,value:unknown):Selection{
 assertPlan(plan);const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v)&&same(Object.keys(v!).sort(),keys.sort());
 if(!exact(value,['pairs'])||!Array.isArray(value.pairs)||value.pairs.length>256)throw Error('Only bounded character style ID pairs accepted');
 const targets=new Set<string>(),sources=new Set<string>();
 for(const pair of value.pairs){if(!exact(pair,['textSpanId','nativeStyleSpanId'])||typeof pair.textSpanId!=='string'||typeof pair.nativeStyleSpanId!=='string'||
  targets.has(pair.textSpanId)||sources.has(pair.nativeStyleSpanId)||!plan.allowedPairs.some(p=>p.textSpanId===pair.textSpanId&&p.nativeStyleSpanId===pair.nativeStyleSpanId))throw Error('Unknown, duplicate or unanchored character style pair');
  targets.add(pair.textSpanId);sources.add(pair.nativeStyleSpanId);}
 return structuredClone(value) as Selection;
}
export function stagePdfCharacterStyles(plan:PdfCharacterStylePlan,value:unknown):Stage{
 const selection=validatePdfCharacterStyleSelection(plan,value),operations:Operation[]=selection.pairs.map<Operation>(pair=>{
  const t=plan.textSpans.find(t=>t.id===pair.textSpanId)!,n=plan.nativeSpans.find(n=>n.id===pair.nativeStyleSpanId)!;
  const opening=t.kind==='math-leaf'?(t.atom!.startsWith('\\')?'\\boldsymbol{':'\\mathbf{'):n.observedBold?'**':'*',closing=t.kind==='math-leaf'?'}':opening;
  return {start:t.start,end:t.end,before:t.text,after:opening+t.text+closing,opening,closing,...pair,kind:'owned-positive-native-style-wrapper',targetKind:t.kind,sourceCharIndices:n.charIndices};
 }).sort((a,b)=>a.start-b.start);
 if(operations.some((op,i)=>op.before!==plan.input.baselineText.slice(op.start,op.end)||i>0&&op.start<operations[i-1].end))throw Error('Overlapping or changed character style targets');
 let text='',cursor=0;const insertions:Insertion[]=[];
 for(const op of operations){text+=plan.input.baselineText.slice(cursor,op.start);insertions.push({start:text.length,end:text.length+op.opening.length,text:op.opening});text+=op.opening+op.before;
  insertions.push({start:text.length,end:text.length+op.closing.length,text:op.closing});text+=op.closing;cursor=op.end;}
 text+=plan.input.baselineText.slice(cursor);let inverse=text;
 for(const insertion of [...insertions].reverse()){if(inverse.slice(insertion.start,insertion.end)!==insertion.text)throw Error('Owned character style wrapper changed');inverse=inverse.slice(0,insertion.start)+inverse.slice(insertion.end);}
 // Only our math wrappers may differ inside the existing math environments. Prose wrappers cannot cross them.
 const oldMath=mathRanges(plan.input.baselineText).map(r=>r.body),newMath=mathRanges(text).map(r=>r.body.replace(/\\(?:mathbf|boldsymbol)\{([^{}]*)\}/g,'$1'));
 if(!Buffer.from(inverse).equals(Buffer.from(plan.input.baselineText))||visualMathStructureIssue(text)||
  !same(mathRanges(inverse).map(r=>r.body),oldMath)||!same(newMath,oldMath.map(body=>body.replace(/\\(?:mathbf|boldsymbol)\{([^{}]*)\}/g,'$1'))))throw Error('Character style-only invariants failed');
 return {kind:'source-character-style-derived-staging',transformVersion:policy,planSha256:plan.planSha256,baselineSha256:plan.input.baselineSha256,
  sourceEvidenceSha256:plan.binding.rawCharacterSidecarSha256,selection,operations,insertions,text,derivedTextSha256:sha(text),sourceProven:false,requiresManualReview:true,
  notForApplyPageRepair:true,alignmentVerification:'unverified',invariants:{inverseByteEqual:true,baselineMathBodiesSha256:sha(nativeHintCanonical(oldMath))},
  warning:'Only owned positive wrappers; char decoding, style observations and alignment remain fallible. Upright scripts are not repaired.'};
}
export function validatePdfCharacterStyleStage(plan:PdfCharacterStylePlan,stage:Stage){if(!same(stage,stagePdfCharacterStyles(plan,stage.selection)))throw Error('Not the exact reversible character style stage');}
