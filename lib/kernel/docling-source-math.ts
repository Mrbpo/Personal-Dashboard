import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const DOCLING_SOURCE_MATH_VERSION='docling-source-math-v1' as const;
export type DoclingMathNode={reference:string;path:string[];role:'inline-group'|'inline-formula'|'block-formula'|'unscoped-formula'|'script'|'inline-text';
 raw:Record<string,unknown>;derivedPageNumbers:number[];pageNumbers:number[]};
export type DoclingSourceMath={policy:typeof DOCLING_SOURCE_MATH_VERSION;nodes:DoclingMathNode[];
 result?:{resultBlobSha256:string;derivedInputSha256:string;copyIndices:number[];formulaEnriched:boolean}};
export type DoclingMathProvenance={policy:typeof DOCLING_SOURCE_MATH_VERSION;documentId:string;sourceHash:string;
 pages:Array<{pageNumber:number;bodySha256:string}>;structures:DoclingSourceMath[];sourceProven:false;formulaRelationsVerified:false};
export type PreparedDoclingSourceMath={owner:string;provenance:DoclingMathProvenance;sha256:string;blobReferences:Array<{kind:'docling-math-result';sha256:string;byteLength:number}>};
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
 Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const isSha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const object=(v:unknown):Record<string,unknown>|undefined=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:undefined;
const limit=8*1024*1024;

/** Keep declared raw fields, including missing versus null. No inferred glyph,
 * attachment, source font, math base, bbox or logical reading order is added. */
export function doclingMathRaw(node:Record<string,unknown>){
 return structuredClone(Object.fromEntries(['self_ref','label','parent','children','orig','text','formatting','prov']
  .filter(key=>Object.hasOwn(node,key)).map(key=>[key,node[key]])));
}
export function mapDoclingSourceMath(structures:DoclingSourceMath[]|undefined,copyIndices:number[]){
 return structures?.map(s=>({...s,nodes:s.nodes.map(n=>({...n,pageNumbers:n.derivedPageNumbers.map(page=>{
  if(!Number.isInteger(page)||page<1||page>copyIndices.length)throw Error('Source math page mapping is invalid');return copyIndices[page-1]+1;
 })}))}));
}
export function bindDoclingSourceMath(structures:DoclingSourceMath[]|undefined,result:NonNullable<DoclingSourceMath['result']>){
 return structures?.map(s=>({...s,result:{...result,copyIndices:[...result.copyIndices]}}));
}
const prepared=new WeakSet<PreparedDoclingSourceMath>();
const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.freeze(v);for(const child of Object.values(v))freeze(child);}};

/** Check raw CAS and source/page binding outside the ingestion transaction. The
 * saved JSON is decoded again, not the PDF. No remote or PDF-parse fallback. */
export async function prepareDoclingSourceMath(input:{owner:string;documentId:string;sourceHash:string;
 pages:Array<{pageNumber:number;text:string}>;structures?:DoclingSourceMath[]},load?:(hash:string)=>Promise<Uint8Array>):Promise<PreparedDoclingSourceMath|undefined>{
 if(!input.structures?.length)return undefined;
 const structures=structuredClone(input.structures),pages=input.pages.map(p=>({pageNumber:p.pageNumber,bodySha256:hash(p.text)}));
 if(!input.owner||!input.documentId||!isSha(input.sourceHash)||!pages.length||pages.length>500||pages.some((p,i)=>p.pageNumber!==i+1)||
  structures.length>500||Buffer.byteLength(canonical(structures))>limit)throw Error('Invalid bounded source math input');
 const blobReferences:PreparedDoclingSourceMath['blobReferences']=[],seen=new Set<string>();
 const read=load??(async(hash:string)=>(await import('../library.ts')).readBlob(hash));
 for(const s of structures){
  const r=s.result;
  if(s.policy!==DOCLING_SOURCE_MATH_VERSION||!s.nodes.length||s.nodes.length>10000||!r||
   !isSha(r.resultBlobSha256)||!isSha(r.derivedInputSha256)||typeof r.formulaEnriched!=='boolean'||!r.copyIndices.length||
   r.copyIndices.length>500||r.copyIndices.some((p,i,a)=>!Number.isInteger(p)||p<0||p>=pages.length||(i>0&&p!==a[i-1]+1)))throw Error('Source math raw result binding is unavailable');
  const bytes=await read(r.resultBlobSha256);if(bytes.length>16*1024*1024||hash(bytes)!==r.resultBlobSha256)throw Error('Source math raw checksum differs');
  const saved=JSON.parse(Buffer.from(bytes).toString('utf8')),identity=saved.identity;
  if(identity?.owner!==input.owner||identity?.documentId!==input.documentId||identity?.sourceHash!==input.sourceHash||
   identity?.totalPages!==pages.length||identity?.inputHash!==r.derivedInputSha256||!isDeepStrictEqual(identity?.copyIndices,r.copyIndices))
   throw Error('Source math raw owner/source/page mapping differs');
  const {decodeDoclingResult}=await import('./docling-result.ts');
  const decoded=decodeDoclingResult(saved.result,r.copyIndices.length,{formulaEnriched:r.formulaEnriched,
   verifiedBlankPages:r.copyIndices.map((_,i)=>i+1)});
  const actual=bindDoclingSourceMath(mapDoclingSourceMath(decoded.sourceMath,r.copyIndices),r);
  if(!actual?.some(a=>isDeepStrictEqual(a,s)))throw Error('Source math differs from actual saved raw');
  if(seen.has(r.resultBlobSha256))throw Error('Duplicate source math raw result');seen.add(r.resultBlobSha256);
  blobReferences.push({kind:'docling-math-result',sha256:r.resultBlobSha256,byteLength:bytes.length});
 }
 const provenance:DoclingMathProvenance={policy:DOCLING_SOURCE_MATH_VERSION,documentId:input.documentId,sourceHash:input.sourceHash,
  pages,structures,sourceProven:false,formulaRelationsVerified:false};
 if(Buffer.byteLength(canonical(provenance))>limit)throw Error('Source math provenance exceeds byte limit');
 const value={owner:input.owner,provenance,sha256:hash(canonical(provenance)),blobReferences};freeze(value);prepared.add(value);return value;
}
export function assertPreparedDoclingSourceMath(value:PreparedDoclingSourceMath,owner:string,documentId:string,sourceHash:string,pages:Array<{pageNumber:number;text:string}>){
 if(!prepared.has(value)||value.owner!==owner||value.provenance.documentId!==documentId||value.provenance.sourceHash!==sourceHash||
  hash(canonical(value.provenance))!==value.sha256||!isDeepStrictEqual(value.provenance.pages,pages.map(p=>({pageNumber:p.pageNumber,bodySha256:hash(p.text)}))))
  throw Error('Source math staging or page body differs');
}
export function doclingMathBatchProvenance(value:PreparedDoclingSourceMath,previous:unknown){
 if(previous!==undefined&&!object(previous))throw Error('Source math requires structured parsing provenance');
 const base=object(previous)||{},refs=base.blobReferences===undefined?[]:base.blobReferences;
 if(!Array.isArray(refs))throw Error('Invalid existing parsing blob references');
 return {...base,sourceMath:{policy:value.provenance.policy,sha256:value.sha256},
  blobReferences:[...refs,...value.blobReferences.filter(ref=>!refs.some(old=>object(old)?.sha256===ref.sha256))]};
}
/** Persisted source metadata is covered by the existing structure manifest hash.
 * Its roles remain machine extraction, not verified source mathematics. */
export function assertDoclingMathProvenance(value:DoclingMathProvenance,documentId:string,sourceHash:string,pages:Array<{pageNumber:number;body:string}>){
 if(value.policy!==DOCLING_SOURCE_MATH_VERSION||value.documentId!==documentId||value.sourceHash!==sourceHash||value.sourceProven!==false||
  value.formulaRelationsVerified!==false||!Array.isArray(value.structures)||Buffer.byteLength(canonical(value))>limit||
  !isDeepStrictEqual(value.pages,pages.map(p=>({pageNumber:p.pageNumber,bodySha256:hash(p.body)}))))throw Error('Persisted source math/page binding differs');
}
export function doclingMathForPage(value:DoclingMathProvenance|undefined,page:number){
 if(!value)return undefined;
 return {policy:value.policy,sourceProven:false as const,formulaRelationsVerified:false as const,
  structures:value.structures.flatMap(s=>{const nodes=s.nodes.filter(n=>n.pageNumbers.includes(page));return nodes.length?[{...s,nodes}]:[];})};
}
