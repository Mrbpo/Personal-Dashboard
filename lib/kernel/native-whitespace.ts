import{createHash}from'node:crypto';import type{DoclingPage}from'./docling-result.ts';import type{NativePdfReadingObservation}from'../local-ocr.ts';
export const NATIVE_WHITESPACE_VERSION='source-observed-whitespace-v1';
export function nativeWhitespaceMode(){const value=process.env.DOCLING_NATIVE_WHITESPACE??'off';
 if(value!=='off'&&value!=='source-v1')throw Error('Invalid DOCLING_NATIVE_WHITESPACE');return value;}
/** Stable provenance participates in identity even when the body is identical.
 * It records observation identity, not a semantic validation certificate. */
export function nativeWhitespaceFingerprint(provenance:unknown){
 const metadata=(provenance as {nativeWhitespace?:Record<string,unknown>}|undefined)?.nativeWhitespace;
 if(metadata===undefined)return undefined;
 if(!metadata||metadata.policy!==NATIVE_WHITESPACE_VERSION)throw Error('Invalid native whitespace provenance');
 if(metadata.status==='unavailable'){
  if(!['native-observation-unavailable','observation-capacity','block-capacity'].includes(String(metadata.reason)))throw Error('Invalid native whitespace failure');
  return{policy:NATIVE_WHITESPACE_VERSION,status:'unavailable',reason:metadata.reason};
 }
 if(!['projected','unchanged'].includes(String(metadata.status))||typeof metadata.receiptHash!=='string'||!/^[a-f0-9]{64}$/.test(metadata.receiptHash)||
  !Number.isSafeInteger(metadata.changedBlocks)||Number(metadata.changedBlocks)<0||Number(metadata.changedBlocks)>10000||
  ((metadata.status==='unchanged')!==(metadata.changedBlocks===0)))throw Error('Invalid native whitespace receipt');
 return{policy:NATIVE_WHITESPACE_VERSION,status:metadata.status,changedBlocks:metadata.changedBlocks,receiptHash:metadata.receiptHash};
}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),compact=(s:string)=>s.replace(/\s/gu,'');
type Edit={blockOrdinal:number;originalRangeUtf16:[number,number];projectedRangeUtf16:[number,number];nativeRangeUtf16:[number,number];
 originalSha256:string;projectedSha256:string;nonWhitespaceSha256:string;nonWhitespaceCharactersUnchanged:true};
/** Two literal parser observations must agree on every non-whitespace UTF16
 * unit, uniquely, on this page. No edit distance, names, aliases or language
 * heuristics. Original inputs remain unchanged; only a new derivation is made. */
export function projectNativeWhitespace(sourceHash:string,input:DoclingPage[],observation:NativePdfReadingObservation|null){
 const pages=input.map(p=>({...p})),unavailable=(reason:string)=>({status:'unavailable' as const,reason,pages:input.map(p=>({...p})),changedBlocks:0,receipt:undefined});
 if(!observation)return unavailable('native-observation-unavailable');
 if(!/^[a-f0-9]{64}$/.test(sourceHash)||observation.sourceHash!==sourceHash||observation.engine!=='poppler-pdftotext'||
  !observation.engineVersion||observation.engineVersion.length>200||JSON.stringify(observation.options)!==JSON.stringify(['-enc','UTF-8'])||
  hash(observation.rawOutput)!==observation.rawOutputSha256)throw Error('Native whitespace source or observation differs');
 const native=observation.rawOutput.split('\f');if(!native.at(-1)?.trim())native.pop();
 if(input.length<1||input.length>500||native.length!==input.length||input.some((p,i)=>p.pageNumber!==i+1))
  throw Error('Native whitespace page manifest differs');
 if(Buffer.byteLength(observation.rawOutput)>8*1024*1024||input.reduce((n,p)=>n+Buffer.byteLength(p.text),0)>8*1024*1024)
  return unavailable('observation-capacity');
 if(input.reduce((n,p)=>n+p.text.split('\n\n').length,0)>10000)return unavailable('block-capacity');
 let changedBlocks=0,blocksSeen=0;
 const records=pages.map((page,index)=>{
  const original=page.text,observed=native[index].trim(),bodyCompact=compact(original),nativeCompact=compact(observed),positions:number[]=[];
  for(let i=0;i<observed.length;i++)if(!/\s/u.test(observed[i]))positions.push(i);
  let originalAt=0,projectedAt=0,ordinal=0;const edits:Edit[]=[],omitted:Record<string,number>={};
  const parts=original.split(/(\n\n)/u).map(part=>{
   const start=originalAt;originalAt+=part.length;if(part==='\n\n'){projectedAt+=part.length;return part;}
   blocksSeen++;const blockOrdinal=ordinal++,needle=compact(part);
   const unchanged=(reason:string)=>{omitted[reason]=(omitted[reason]??0)+1;projectedAt+=part.length;return part;};
   if(needle.length<80)return unchanged('short-block');
   const at=nativeCompact.indexOf(needle);
   if(bodyCompact.indexOf(needle)!==bodyCompact.lastIndexOf(needle))return unchanged('ambiguous-decoded-block');
   if(at<0)return unchanged('non-whitespace-disagreement');
   if(at!==nativeCompact.lastIndexOf(needle))return unchanged('ambiguous-native-block');
   const nativeStart=positions[at],nativeEnd=positions[at+needle.length-1]+1,value=observed.slice(nativeStart,nativeEnd);
   if(compact(value)!==needle)throw Error('Native whitespace character invariant failed');
   if(value===part)return unchanged('already-identical');
   edits.push({blockOrdinal,originalRangeUtf16:[start,originalAt],projectedRangeUtf16:[projectedAt,projectedAt+value.length],
    nativeRangeUtf16:[nativeStart,nativeEnd],originalSha256:hash(part),projectedSha256:hash(value),nonWhitespaceSha256:hash(needle),nonWhitespaceCharactersUnchanged:true});
   projectedAt+=value.length;changedBlocks++;return value;
  });
  page.text=parts.join('');if(compact(page.text)!==bodyCompact)throw Error('Native whitespace page character invariant failed');
  return{pageNumber:page.pageNumber,originalBodySha256:hash(original),projectedBodySha256:hash(page.text),nativePageSha256:hash(observed),
   regionMapping:'whole-page-only-block-geometry-unknown' as const,edits,omitted};
 });
 if(blocksSeen>10000)return unavailable('block-capacity');
 const receipt={policy:NATIVE_WHITESPACE_VERSION,sourceHash,native:structuredClone(observation),pages:records,
  fidelityVerified:false,semanticAliasesVerified:false,structureRelationsVerified:false,originalPdfUnmodified:true};
 return{status:changedBlocks?'projected' as const:'unchanged' as const,reason:null,pages,changedBlocks,receipt};
}
