import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {indexDoclingPageRegions,DoclingPageRegionError,DOCLING_PAGE_REGION_LIMITS,type DoclingVisualLayout} from './docling-result.ts';
import type {PdfVisualAsset} from './pdf-visual-evidence.ts';

export const DOCLING_SOURCE_REGIONS_VERSION='docling-source-page-regions-v1' as const;
export type DoclingRegionSource={owner:string;documentId:string;sourceHash:string;pageCount:number;physicalPage:number};
export type DoclingRegionResultReference={resultBlobSha256:string;derivedInputSha256:string;copyIndices:number[];optionsHash:string|null};
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const isSha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function invalid(message:string):never{throw new DoclingPageRegionError('invalid',message);}

/** Continuous point coordinates only; both native origins are explicit. No
 * crop, rounding, rotation inference or visibility assertion is performed. */
export function doclingPageImageTransform(size:{width:number;height:number}|null,image:Pick<PdfVisualAsset,'width'|'height'|'provenance'>){
 const frame=image.provenance,crop=frame.sourcePageCropBox;
 if(!size||frame.rotation!==0||crop.x!==0||crop.y!==0||crop.width!==size.width||crop.height!==size.height||
  frame.pageSizePoints.width!==size.width||frame.pageSizePoints.height!==size.height)
  return {status:'unknown' as const,reason:'producer-to-page-image-frame-not-established'};
 const scaleX=image.width/size.width,scaleY=image.height/size.height;
 return {status:'derived' as const,policy:'unrotated-zero-origin-affine-v1' as const,imageOrigin:'TOPLEFT' as const,
  rounding:'none-continuous-coordinates' as const,byCoordOrigin:{
   TOPLEFT:{scaleX,scaleY,offsetX:0,offsetY:0},BOTTOMLEFT:{scaleX,scaleY:-scaleY,offsetX:0,offsetY:image.height}}};
}

/** Follow only references registered with the current source, not a caller's
 * arbitrary CAS hash. Unknown historical options remain unknown. */
export function doclingPageResultReferences(source:DoclingRegionSource,progress:unknown,layout:DoclingVisualLayout|null){
 if(!source.owner||!source.documentId||!isSha(source.sourceHash)||!Number.isInteger(source.pageCount)||source.pageCount<1||
  source.pageCount>DOCLING_PAGE_REGION_LIMITS.pages||!Number.isInteger(source.physicalPage)||source.physicalPage<1||source.physicalPage>source.pageCount)
  invalid('Invalid bounded original source page');
 const selected=new Map<string,DoclingRegionResultReference>();let count=0;
 const add=(raw:unknown,optionsHash:string|null)=>{
  if(++count>2*DOCLING_PAGE_REGION_LIMITS.pages)throw new DoclingPageRegionError('limit','Too many saved result references');
  const value=object(raw),indices=value?.copyIndices;
  if(!value||!isSha(value.resultBlobSha256)||!isSha(value.derivedInputSha256)||!Array.isArray(indices)||!indices.length||
   indices.length>source.pageCount||indices.some((n,i)=>!Number.isInteger(n)||n<0||n>=source.pageCount||(i>0&&n!==indices[i-1]+1)))
   invalid('Saved Docling result reference mapping differs');
  if(!indices.includes(source.physicalPage-1))return;
  const ref:DoclingRegionResultReference={resultBlobSha256:value.resultBlobSha256 as string,derivedInputSha256:value.derivedInputSha256 as string,
   copyIndices:[...indices] as number[],optionsHash};
  const old=selected.get(ref.resultBlobSha256);
  if(old&&(old.derivedInputSha256!==ref.derivedInputSha256||!isDeepStrictEqual(old.copyIndices,ref.copyIndices)||
   (old.optionsHash!==null&&ref.optionsHash!==null&&old.optionsHash!==ref.optionsHash)))invalid('Conflicting current Docling result references');
  selected.set(ref.resultBlobSha256,{...ref,optionsHash:old?.optionsHash??ref.optionsHash});
 };
 const p=object(progress);
 if(p&&('batches'in p||'identity'in p)){
  const identity=object(p.identity);
  if(p.schema!==1||identity?.owner!==source.owner||identity.documentId!==source.documentId||identity.sourceHash!==source.sourceHash||
   identity.totalPages!==source.pageCount||!isSha(identity.optionsHash)||!Array.isArray(p.batches)||p.batches.length>source.pageCount)
   invalid('Published Docling batch source differs');
  for(const batch of p.batches as unknown[]){const b=object(batch);
   if(!b||!Number.isInteger(b.start)||!Number.isInteger(b.end)||(b.start as number)<1||(b.end as number)>(source.pageCount)||
    (b.end as number)<(b.start as number))invalid('Published Docling batch range differs');
   if(b.resultHash!==undefined){
    if(!Array.isArray(b.copyIndices)||b.copyIndices.length!==(b.end as number)-(b.start as number)+1||
     b.copyIndices.some((n,i)=>n!==(b.start as number)+i-1))invalid('Published Docling batch copy map differs');
    add({resultBlobSha256:b.resultHash,derivedInputSha256:b.inputHash,copyIndices:b.copyIndices},identity.optionsHash as string);
   }
  }
 }
 if(layout){
  if(!Array.isArray(layout.resultReferences??[])||(layout.resultReferences?.length??0)>source.pageCount||!Array.isArray(layout.regions))
   invalid('Published Docling layout references differ');
  for(const ref of layout.resultReferences??[])add(ref,null);
  // Older manifests can hold the same explicit mapping on picture regions.
  if(!(layout.resultReferences?.length))for(const region of layout.regions){
   if(region.pageNumber===source.physicalPage&&region.resultBlobSha256)add(region,null);
  }
 }
 if(selected.size>1)throw new DoclingPageRegionError('unavailable','Multiple saved results cover this original page');
 return [...selected.values()];
}

/** Read at most the declared bounded file size (+1 race detector). No PDF,
 * model, decoder service, write, or missing-file recovery is available here. */
export async function readDoclingPageRegions(source:DoclingRegionSource,reference:DoclingRegionResultReference){
 if(reference.optionsHash!==null&&!isSha(reference.optionsHash))invalid('Invalid Docling options hash');
 if(!doclingPageResultReferences(source,undefined,{status:'unavailable',regions:[],pageSizes:[],resultReferences:[reference]}).length)
  invalid('Requested original page is outside saved result');
 const handle=await open(resolve(/* turbopackIgnore: true */ process.env.LIBRARY_DIR||'./data/library',reference.resultBlobSha256),'r')
  .catch(()=>{throw new DoclingPageRegionError('unavailable','Saved Docling result blob is unavailable');});
 let bytes:Buffer;
 try{
  const info=await handle.stat();
  if(!info.isFile()||info.size>DOCLING_PAGE_REGION_LIMITS.rawBytes)throw new DoclingPageRegionError('limit','Saved Docling file exceeds limit');
  const buffer=Buffer.alloc(info.size+1);let length=0;
  while(length<buffer.length){const read=await handle.read(buffer,length,buffer.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}
  if(length!==info.size||sha(buffer.subarray(0,length))!==reference.resultBlobSha256)invalid('Saved Docling raw checksum changed');
  bytes=buffer.subarray(0,length);
 }finally{await handle.close();}
 let saved:Record<string,unknown>|undefined;
 try{saved=object(JSON.parse(bytes.toString('utf8')));}catch{invalid('Saved Docling raw JSON is invalid');}
 const identity=object(saved?.identity),indices=reference.copyIndices;
 if(!identity||identity.owner!==source.owner||identity.documentId!==source.documentId||identity.sourceHash!==source.sourceHash||
  identity.totalPages!==source.pageCount||identity.inputHash!==reference.derivedInputSha256||!isDeepStrictEqual(identity.copyIndices,indices)||
  (identity.optionsHash!==undefined&&!isSha(identity.optionsHash))||
  (reference.optionsHash!==null&&identity.optionsHash!==reference.optionsHash))invalid('Saved Docling raw owner/source/input/options mapping differs');
 if((identity.start!==undefined||identity.end!==undefined)&&(identity.start!==indices[0]+1||identity.end!==indices.at(-1)!+1))
  invalid('Saved Docling raw range differs');
 const derivedPage=indices.indexOf(source.physicalPage-1)+1;
 if(!derivedPage)invalid('Requested original page is outside saved result');
 const index=indexDoclingPageRegions(saved!.result,derivedPage,indices.length);
 const output={policy:DOCLING_SOURCE_REGIONS_VERSION,physicalPage:source.physicalPage,...index,
  nodes:index.nodes.map(node=>({...node,physicalPageNumbers:node.declaredPageNumbers.map(page=>indices[page-1]+1)})),
  result:{...reference,optionsHash:isSha(identity.optionsHash)?identity.optionsHash:null},
  sourceBindingVerified:true as const,sourceContentIsUntrusted:true as const,
  observationStatus:'observed' as const,inferredRelations:[] as never[],
  visibilityVerified:false as const,textFaithfulnessVerified:false as const,readingOrderVerified:false as const,semanticRelationsVerified:false as const};
 if(Buffer.byteLength(JSON.stringify(output))>DOCLING_PAGE_REGION_LIMITS.pageBytes)
  throw new DoclingPageRegionError('limit','Bound Docling page index exceeds byte limit');
 return output;
}

export const DOCLING_ORIG_SEARCH_POLICY='docling-orig-search-hints-v1' as const;
export const DOCLING_ORIG_SEARCH_LIMITS=Object.freeze({items:256,textBytes:32768,provenanceBytes:65536});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
 Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export const doclingOrigSearchHash=(value:unknown)=>sha(Buffer.from(canonical(value)));
/** Only batches[].taskId identifies a conversion attempt rather than its
 * immutable source/result. Preserve every other known or unknown field. */
function stableOrigProgressHash(progress:unknown){
 const value=object(progress);
 return doclingOrigSearchHash(value&&Array.isArray(value.batches)?{...value,batches:value.batches.map(batch=>{
  const item=object(batch);if(!item)return batch;
  const {taskId:runtimeId,...bound}=item;void runtimeId;return bound;
 })}:progress??null);
}
export type OrigSearchInput=DoclingRegionSource&{body:string;parserVersion:string;progress:unknown;layout?:DoclingVisualLayout|null};
export type PreparedDoclingOrigSearchHints={policy:typeof DOCLING_ORIG_SEARCH_POLICY;source:DoclingRegionSource;
 bodySha256:string;parserVersion:string;progressSha256:string;references:DoclingRegionResultReference[];
 producerDocument:{schemaName:string|null;version:string|null};derivedPage:number;
 entries:Array<{reference:string;orig:string}>;hintSha256:string;sourceContentIsUntrusted:true;
 visibilityVerified:false;textFaithfulnessVerified:false;semanticRelationsVerified:false};
const preparedOrig=new WeakSet<PreparedDoclingOrigSearchHints>();
function freezeOrig(value:unknown):void{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freezeOrig(child);}}
/** Raw orig is a recall aid, including potentially hidden or incorrectly
 * decoded text. Never replace body, create quotations, or certify visibility.
 * All CAS IO finishes before the caller opens its publication transaction. */
export async function prepareDoclingOrigSearchHints(input:OrigSearchInput):Promise<PreparedDoclingOrigSearchHints|null>{
 const progress=object(input.progress),layout=input.layout??null;
 if(!progress?.identity&&!progress?.batches&&!layout?.resultReferences?.length&&!layout?.regions?.some(r=>r.resultBlobSha256))return null;
 const source:DoclingRegionSource={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,
  pageCount:input.pageCount,physicalPage:input.physicalPage};
 if(typeof input.body!=='string'||!input.parserVersion||input.parserVersion.length>200)invalid('Invalid orig search page/parser');
 const references=doclingPageResultReferences(source,input.progress,layout);if(!references.length)return null;
 const index=await readDoclingPageRegions(source,references[0]);
 // Multi-page orig cannot safely be attributed to a single physical page.
 const entries=index.nodes.filter(n=>n.membership==='declared-provenance'&&n.textScope==='single-page'&&
  n.physicalPageNumbers[0]===source.physicalPage&&typeof n.raw.orig==='string'&&n.raw.orig.trim())
  .map(n=>({reference:n.reference,orig:n.raw.orig as string}));
 // Orig is verbatim provenance, not a repaired text projection. PostgreSQL
 // jsonb cannot represent NUL; leave this optional hint unavailable rather
 // than mutate raw orig or let it invalidate an otherwise publishable page.
 if(entries.some(entry=>entry.orig.includes('\0')))
  throw new DoclingPageRegionError('unavailable','Orig search hints contain NUL; verbatim observations remain in the bound raw result');
 if(entries.length>DOCLING_ORIG_SEARCH_LIMITS.items||Buffer.byteLength(entries.map(e=>e.orig).join('\n'))>DOCLING_ORIG_SEARCH_LIMITS.textBytes)
  throw new DoclingPageRegionError('limit','Orig search hints exceed complete page limit');
 const value:PreparedDoclingOrigSearchHints={policy:DOCLING_ORIG_SEARCH_POLICY,source,bodySha256:sha(Buffer.from(input.body)),
  parserVersion:input.parserVersion,progressSha256:stableOrigProgressHash(input.progress),references:[index.result],
  producerDocument:index.producerDocument,derivedPage:index.derivedPage,entries,hintSha256:doclingOrigSearchHash(entries),
  sourceContentIsUntrusted:true,visibilityVerified:false,textFaithfulnessVerified:false,semanticRelationsVerified:false};
 if(Buffer.byteLength(canonical(value))>DOCLING_ORIG_SEARCH_LIMITS.provenanceBytes)
  throw new DoclingPageRegionError('limit','Orig search provenance exceeds complete page limit');
 freezeOrig(value);preparedOrig.add(value);return value;
}
export function assertPreparedDoclingOrigSearchHints(value:PreparedDoclingOrigSearchHints,input:OrigSearchInput){
 const source={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,pageCount:input.pageCount,physicalPage:input.physicalPage};
 const refs=doclingPageResultReferences(source,input.progress,input.layout??null);
 // A legacy progress reference may omit options; the raw reader can establish it.
 const sameRefs=refs.length===value.references.length&&refs.every((r,i)=>r.resultBlobSha256===value.references[i].resultBlobSha256&&
  r.derivedInputSha256===value.references[i].derivedInputSha256&&isDeepStrictEqual(r.copyIndices,value.references[i].copyIndices)&&
  (r.optionsHash===null||r.optionsHash===value.references[i].optionsHash));
 if(!preparedOrig.has(value)||!isDeepStrictEqual(value.source,source)||value.bodySha256!==sha(Buffer.from(input.body))||
  value.parserVersion!==input.parserVersion||value.progressSha256!==stableOrigProgressHash(input.progress)||!sameRefs)
  invalid('Orig search staging differs from current source/body/progress');
}
/** Persisted proofs can be checked without trusting a supplied hash alone.
 * Rebuild still reopens the registered CAS; this is only an index binding. */
export function assertDoclingOrigSearchHints(value:PreparedDoclingOrigSearchHints,source:DoclingRegionSource,bodySha256:string,parserVersion:string){
 if(!value||value.policy!==DOCLING_ORIG_SEARCH_POLICY||!isDeepStrictEqual(value.source,source)||!isSha(bodySha256)||
  value.bodySha256!==bodySha256||value.parserVersion!==parserVersion||!isSha(value.progressSha256)||
  value.sourceContentIsUntrusted!==true||value.visibilityVerified!==false||value.textFaithfulnessVerified!==false||value.semanticRelationsVerified!==false||
  !Array.isArray(value.references)||value.references.length!==1||!Array.isArray(value.entries)||value.entries.length>DOCLING_ORIG_SEARCH_LIMITS.items||
  value.entries.some(e=>!e||typeof e.reference!=='string'||!/^#\/(?:texts|tables|groups|pictures|field_regions|field_items)\/\d+$/.test(e.reference)||typeof e.orig!=='string'||!e.orig.trim())||
  new Set(value.entries.map(e=>e.reference)).size!==value.entries.length||value.hintSha256!==doclingOrigSearchHash(value.entries)||
  Buffer.byteLength(value.entries.map(e=>e.orig).join('\n'))>DOCLING_ORIG_SEARCH_LIMITS.textBytes||
  Buffer.byteLength(canonical(value))>DOCLING_ORIG_SEARCH_LIMITS.provenanceBytes)invalid('Stored orig search provenance differs');
 const refs=doclingPageResultReferences(source,undefined,{status:'unavailable',regions:[],pageSizes:[],resultReferences:value.references});
 if(refs.length!==1||!Number.isInteger(value.derivedPage)||value.derivedPage!==refs[0].copyIndices.indexOf(source.physicalPage-1)+1||
  (value.references[0].optionsHash!==null&&!isSha(value.references[0].optionsHash))||!object(value.producerDocument))invalid('Stored orig search mapping differs');
}

export const DOCLING_TEXT_CONTEXT_WINDOWS_POLICY='docling-text-context-windows-v1' as const;
export const DOCLING_TEXT_CONTEXT_WINDOW_LIMITS=Object.freeze({windows:64,utf16:1200});
export type DoclingTextContextWindowBinding=DoclingRegionSource&{currentVersionId:string;sourceVersionId:string;evidenceId:string;
 parserVersion:string;bodySha256:string};
export type DoclingTextContextWindowsInput=OrigSearchInput&Pick<DoclingTextContextWindowBinding,'currentVersionId'|'sourceVersionId'|'evidenceId'>;
type PageRegionObservation=Awaited<ReturnType<typeof readDoclingPageRegions>>;
export type DoclingTextContextWindow={startUtf16:number;endUtf16:number;quoteSha256:string;
 references:Array<PageRegionObservation['nodes'][number]&{startUtf16:number;endUtf16:number}>;
 semanticRelationsVerified:false};
export type PreparedDoclingTextContextWindows={policy:typeof DOCLING_TEXT_CONTEXT_WINDOWS_POLICY;binding:DoclingTextContextWindowBinding;
 progressSha256:string;result:DoclingRegionResultReference;derivedPage:number;producerDocument:PageRegionObservation['producerDocument'];
 pageSize:PageRegionObservation['pageSize'];windows:DoclingTextContextWindow[];hintSha256:string;
 sourceBindingVerified:true;sourceContentIsUntrusted:true;visibilityVerified:false;textFaithfulnessVerified:false;
 readingOrderVerified:false;semanticRelationsVerified:false};
const preparedTextContextWindows=new WeakSet<PreparedDoclingTextContextWindows>();

/** Preparation only: these literal windows must be offered before selection.
 * Neither a shared parent nor adjacency establishes a paragraph, continuation,
 * or semantic relation. Existing bodies and selected quotations are untouched. */
export async function prepareDoclingTextContextWindows(input:DoclingTextContextWindowsInput):Promise<PreparedDoclingTextContextWindows|null>{
 const {owner,documentId,currentVersionId,sourceVersionId,sourceHash,pageCount,physicalPage,evidenceId,parserVersion}=input;
 if([owner,documentId,currentVersionId,sourceVersionId,evidenceId,parserVersion].some(value=>
  typeof value!=='string'||!value.trim()||value.length>200||value.includes('\0'))||typeof input.body!=='string')
  invalid('Invalid text context window binding');
 if(Buffer.byteLength(input.body)>DOCLING_PAGE_REGION_LIMITS.pageBytes)
  throw new DoclingPageRegionError('limit','Text context body exceeds page limit');
 const source:DoclingRegionSource={owner,documentId,sourceHash,pageCount,physicalPage};
 const references=doclingPageResultReferences(source,input.progress,input.layout??null);if(!references.length)return null;
 const index=await readDoclingPageRegions(source,references[0]);
 const candidates=index.nodes.flatMap(node=>{
  // Only declared, leaf text items directly attached to body are eligible.
  // Geometry is retained as observed/unknown; it never proves reading order.
  const root=node.path.length===1?node.path[0]:undefined,position=root?.via.match(/^body\.children\[(\d+)\]$/);
  if(!/^#\/texts\/\d+$/.test(node.reference)||node.membership!=='declared-provenance'||node.textScope!=='single-page'||
   node.declaredPageNumbers.length!==1||node.declaredPageNumbers[0]!==index.derivedPage||
   node.physicalPageNumbers.length!==1||node.physicalPageNumbers[0]!==physicalPage||!position||root?.reference!==node.reference||
   object(node.raw.parent)?.$ref!=='#/body'||node.raw.label!=='text'||
   ['children','captions','footnotes','references'].some(key=>node.raw[key]!==undefined&&
    (!Array.isArray(node.raw[key])||(node.raw[key] as unknown[]).length>0)))return [];
  const script=object(node.raw.formatting)?.script;if(script!==undefined&&script!==null&&script!=='baseline')return [];
  const text=typeof node.raw.text==='string'&&node.raw.text.trim()?node.raw.text:
   typeof node.raw.orig==='string'&&node.raw.orig.trim()?node.raw.orig:'';
  if(!text||text.length>DOCLING_TEXT_CONTEXT_WINDOW_LIMITS.utf16)return [];
  const start=input.body.indexOf(text);
  if(start<0||input.body.indexOf(text,start+1)!==-1)return []; // Ambiguous occurrences cannot acquire a source span.
  return [{position:Number(position[1]),node,startUtf16:start,endUtf16:start+text.length}];
 }).sort((a,b)=>a.position-b.position);
 const windows:DoclingTextContextWindow[]=[];
 for(let i=1;i<candidates.length;i++){
  const left=candidates[i-1],right=candidates[i];
  if(right.position!==left.position+1||right.startUtf16<=left.endUtf16||
   right.endUtf16-left.startUtf16>DOCLING_TEXT_CONTEXT_WINDOW_LIMITS.utf16||
   !/^\s+$/u.test(input.body.slice(left.endUtf16,right.startUtf16)))continue;
  if(windows.length>=DOCLING_TEXT_CONTEXT_WINDOW_LIMITS.windows)
   throw new DoclingPageRegionError('limit','Text context windows exceed page limit');
  windows.push({startUtf16:left.startUtf16,endUtf16:right.endUtf16,
   quoteSha256:sha(Buffer.from(input.body.slice(left.startUtf16,right.endUtf16))),
   references:[left,right].map(member=>({...member.node,startUtf16:member.startUtf16,endUtf16:member.endUtf16})),
   semanticRelationsVerified:false});
 }
 const binding:DoclingTextContextWindowBinding={...source,currentVersionId,sourceVersionId,evidenceId,parserVersion,bodySha256:sha(Buffer.from(input.body))};
 const observation={policy:DOCLING_TEXT_CONTEXT_WINDOWS_POLICY,binding,progressSha256:stableOrigProgressHash(input.progress),
  result:index.result,derivedPage:index.derivedPage,producerDocument:index.producerDocument,pageSize:index.pageSize,windows,
  sourceBindingVerified:true as const,sourceContentIsUntrusted:true as const,visibilityVerified:false as const,
  textFaithfulnessVerified:false as const,readingOrderVerified:false as const,semanticRelationsVerified:false as const};
 if(Buffer.byteLength(canonical(observation))>DOCLING_PAGE_REGION_LIMITS.pageBytes)
  throw new DoclingPageRegionError('limit','Text context window provenance exceeds page limit');
 const value:PreparedDoclingTextContextWindows={...observation,hintSha256:doclingOrigSearchHash(observation)};
 freezeOrig(value);preparedTextContextWindows.add(value);return value;
}

/** A caller must supply the binding read from its current source/body. JSON,
 * a matching digest, or an old prepared value cannot upgrade another binding. */
export function assertPreparedDoclingTextContextWindows(value:PreparedDoclingTextContextWindows,binding:DoclingTextContextWindowBinding){
 if(!preparedTextContextWindows.has(value)||!isDeepStrictEqual(value.binding,binding))
  invalid('Text context window staging differs from current source/body binding');
}
