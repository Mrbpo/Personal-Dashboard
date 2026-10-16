import {createHash} from 'node:crypto';
import {nativeHintCanonical,type PdfNativeHints} from './pdf-native-hints.ts';

const policy='native-prose-interval-v1';
type Box={left:number;top:number;width:number;height:number};
type Leaf={id:string;start:number;end:number;atom:string};
type Native={id:string;runIndex:number;atom:string;runBox:Box};
type Word={value:string;start:number;end:number};
type Occurrence={count:number;first:{group:number;word:number;start:number;end:number;length:number}};
export type ProseAnchor={id:string;runIndex:number;sourceStart:number;sourceEnd:number;sourceText:string;runBox:Box;reportedSize:number;
 baselineStart:number;baselineEnd:number;baselineText:string;normalizedWords:string[];sourceMatchCount:1;baselineMatchCount:1};
export type ProseInterval={id:string;leftAnchorId:string;rightAnchorId:string;baselineStart:number;baselineEnd:number;nativeStyleSpanIds:string[]};
export type AnchoredPair={textSpanId:string;nativeStyleSpanId:string;intervalId:string};
const sha=(x:unknown)=>createHash('sha256').update(nativeHintCanonical(x)).digest('hex');
const validBox=(b:Box)=>Object.values(b).every(Number.isFinite)&&b.width>0&&b.height>0;
const words=(text:string):Word[]=>[...text.matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)]
 .map(m=>({value:m[0].normalize('NFC').replaceAll('’',"'"),start:m.index!,end:m.index!+m[0].length}));
// Whole real run boxes give partial-order hints, not proof of columns or logical reading order. Never use array index as proof.
function before(a:Box,b:Box){
 const overlapY=Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top);
 const overlapX=Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left);
 return overlapY>0&&a.left+a.width<=b.left||overlapX>0&&a.top+a.height<=b.top;
}
function windows(groups:Word[][],visit:(key:string,where:Occurrence['first'],tokens:Word[])=>void){
 for(const [group,tokens]of groups.entries())for(let word=0;word<tokens.length;word++)for(let length=4;length<=8&&word+length<=tokens.length;length++){
  const slice=tokens.slice(word,word+length);
  if(slice.filter(w=>/^\p{L}{2}/u.test(w.value)).length<3)continue;
  visit(JSON.stringify(slice.map(w=>w.value)),{group,word,start:slice[0].start,end:slice.at(-1)!.end,length},slice);
 }
}
/** Bounded correspondence evidence, not a claim that source reading order, glyph decoding or mathematics is proven. */
export function prepareProseAlignment(text:string,ranges:Array<{start:number;end:number}>,hints:PdfNativeHints,leaves:Leaf[],native:Native[]){
 const runs=hints.sidecar.runs||[],declined:Array<{scope:string;reason:string}>=[],anchors:ProseAnchor[]=[],intervals:ProseInterval[]=[],pairs:AnchoredPair[]=[];
 const empty=(reason:string)=>({policy,anchors:[],intervals:[],allowedPairs:[],declined:[{scope:'alignment',reason}]});
 const prose:Word[][]=[];let cursor=0;
 for(const range of ranges){prose.push(words(text.slice(cursor,range.start-2)).map(w=>({...w,start:w.start+cursor,end:w.end+cursor})));cursor=range.end+2;}
 prose.push(words(text.slice(cursor)).map(w=>({...w,start:w.start+cursor,end:w.end+cursor})));
 const source=runs.map(run=>words(run.text));
 if(prose.flat().length>8192||source.flat().length>8192||runs.length>512)return empty('prose-anchor-input-limit');
 const baseline=new Map<string,Occurrence>(),original=new Map<string,Occurrence>();
 for(const [groups,index]of [[prose,baseline],[source,original]]as const)windows(groups,(key,where)=>{
  const existing=index.get(key);if(existing)existing.count++;else index.set(key,{count:1,first:where});
 });
 if(baseline.size>65536||original.size>65536)return empty('prose-anchor-window-limit');
 const candidates=new Map<number,Array<{source:Occurrence['first'];baseline:Occurrence['first'];tokens:Word[]}>>();
 windows(source,(key,where,tokens)=>{const match=baseline.get(key);if(original.get(key)?.count!==1||match?.count!==1)return;
  const items=candidates.get(where.group)||[];items.push({source:where,baseline:match.first,tokens});candidates.set(where.group,items);});
 for(const [runIndex,items]of candidates){
  const run=runs[runIndex],font=hints.sidecar.fonts?.find(font=>font.id===run.fontId);
  if(!validBox(run.box)||!font||!Number.isFinite(font.reportedSize)||font.reportedSize<=0||/symbol|extra|dingbat|type3/i.test(font.reportedFullName))continue;
  // All uniquely matched windows of this run must agree, rather than choosing whichever match looks convenient.
  if(new Set(items.map(x=>x.baseline.group+':'+(x.baseline.word-x.source.word))).size!==1){declined.push({scope:`anchor:${runIndex}`,reason:'prose-run-mapping-disagrees'});continue;}
  items.sort((a,b)=>b.source.length-a.source.length||a.source.start-b.source.start);const chosen=items[0];
  const value={runIndex,sourceStart:chosen.source.start,sourceEnd:chosen.source.end,sourceText:run.text.slice(chosen.source.start,chosen.source.end),runBox:{...run.box},reportedSize:font.reportedSize,
   baselineStart:chosen.baseline.start,baselineEnd:chosen.baseline.end,baselineText:text.slice(chosen.baseline.start,chosen.baseline.end),normalizedWords:chosen.tokens.map(w=>w.value),sourceMatchCount:1 as const,baselineMatchCount:1 as const};
  anchors.push({...value,id:'a:'+sha(value).slice(0,24)});
 }
 if(anchors.length>256)return empty('prose-anchor-count-limit');
 for(const span of native){
  const reject=(reason:string)=>declined.push({scope:span.id,reason});
  if(!validBox(span.runBox)){reject('invalid-native-run-box');continue;}
  const left=anchors.filter(a=>a.runIndex!==span.runIndex&&before(a.runBox,span.runBox)).sort((a,b)=>b.baselineEnd-a.baselineEnd);
  const right=anchors.filter(a=>a.runIndex!==span.runIndex&&before(span.runBox,a.runBox)).sort((a,b)=>a.baselineStart-b.baselineStart);
  const l=left[0],r=right[0];
  if(!l||!r||l.baselineEnd>=r.baselineStart||!before(l.runBox,r.runBox)||left[1]?.baselineEnd===l.baselineEnd||right[1]?.baselineStart===r.baselineStart){reject('no-unique-double-prose-anchor-interval');continue;}
  const font=hints.sidecar.fonts?.find(font=>font.id===runs[span.runIndex].fontId);
  if(!font||!Number.isFinite(font.reportedSize)||font.reportedSize<=0||font.reportedSize<.8*Math.min(l.reportedSize,r.reportedSize)){reject('unknown-or-script-like-native-size');continue;}
  const intervalId='p:'+sha({left:l.id,right:r.id}).slice(0,24);
  let interval=intervals.find(item=>item.id===intervalId);
  if(!interval){interval={id:intervalId,leftAnchorId:l.id,rightAnchorId:r.id,baselineStart:l.baselineEnd,baselineEnd:r.baselineStart,nativeStyleSpanIds:[]};intervals.push(interval);}
  interval.nativeStyleSpanIds.push(span.id);
  const matches=leaves.filter(leaf=>leaf.start>=interval.baselineStart&&leaf.end<=interval.baselineEnd&&leaf.atom===span.atom);
  if(matches.length!==1){reject('no-unique-math-leaf-in-interval');continue;}
  pairs.push({textSpanId:matches[0].id,nativeStyleSpanId:span.id,intervalId});
 }
 // A unique target inside a broad interval still cannot choose between competing source occurrences.
 const allowedPairs=pairs.filter(pair=>{if(pairs.filter(other=>other.textSpanId===pair.textSpanId).length===1)return true;
  declined.push({scope:pair.nativeStyleSpanId,reason:'competing-native-occurrences'});return false;});
 if(!allowedPairs.length)declined.push({scope:'alignment',reason:'no-eligible-double-prose-anchor-correspondence'});
 return {policy,anchors,intervals,allowedPairs,declined};
}
