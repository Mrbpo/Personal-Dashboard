import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import type {DoclingTextContextWindowBinding} from './docling-source-regions.ts';

export const NATIVE_REGION_TEXT_VERSION='native-pdf-region-text-v1' as const;
export const NATIVE_REGION_WINDOWS_POLICY='native-region-text-windows-v1' as const;
export const NATIVE_REGION_LIMITS=Object.freeze({bytes:2*1024*1024,pages:16,chars:50000,regions:16,regionUtf16:8192,textBytes:32768});
export const nativeRegionHash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const compact=(s:string)=>s.replace(/\s/gu,'');
type Rect=[number,number,number,number];
export type NativeRegionBundle={policy:'native-pdf-region-observations-v1';source:{owner:string;documentId:string;sourceHash:string;pageCount:number};
 producer:{engine:'pdfplumber';packages:Record<string,string>;options:{layout:true;x_tolerance:2;y_tolerance:2};scriptSha256:string;
 boundsExportSha256:string;boundsAuthority:'parser-declared-untrusted'};
 pages:Array<{physicalPage:number;width:number;height:number;chars:Array<{index:number;text:string;bbox:Rect;font:string}>;
 regions:Array<{id:string;bbox:Rect;text:string;charIndices:number[];boundsReference:string}>}>};
type Source=NativeRegionBundle['source'];
type PageProjection={physicalPage:number;previousBodySha256:string;bodySha256:string;windows:Array<{
 regionId:string;bbox:Rect;startUtf16:number;endUtf16:number;quoteSha256:string}>};
export type NativeRegionManifest={policy:typeof NATIVE_REGION_TEXT_VERSION;source:Source;observationSha256:string;pages:PageProjection[]};
function invalid():never{throw Error('Native region source/characters/projection invalid');}
const rect=(b:Rect,w:number,h:number)=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=0&&b[1]>=0&&b[2]>b[0]&&b[3]>b[1]&&b[2]<=w&&b[3]<=h;
const inside=(a:Rect,b:Rect)=>a[0]>=b[0]&&a[1]>=b[1]&&a[2]<=b[2]&&a[3]<=b[3];
const intersects=(a:Rect,b:Rect)=>!(a[2]<b[0]||a[0]>b[2]||a[3]<b[1]||a[1]>b[3]);
/** Trusted administrator import, not proof that caller-supplied glyphs are
 * authentic. The offline producer reads the pinned original PDF. Geometry,
 * Unicode faithfulness and semantic/row/column relationships stay unverified. */
export function validateNativeRegionBundle(value:unknown,source:Source):NativeRegionBundle{
 if(!value||typeof value!=='object'||Buffer.byteLength(JSON.stringify(value))>NATIVE_REGION_LIMITS.bytes)invalid();
 const v=value as NativeRegionBundle;
 if(v.policy!=='native-pdf-region-observations-v1'||!isDeepStrictEqual(v.source,source)||!source.owner||!source.documentId||!hex(source.sourceHash)||
  !Number.isSafeInteger(source.pageCount)||source.pageCount<1||source.pageCount>500||!v.producer||v.producer.engine!=='pdfplumber'||
  !hex(v.producer.scriptSha256)||!hex(v.producer.boundsExportSha256)||v.producer.boundsAuthority!=='parser-declared-untrusted'||
  !v.producer.packages?.pdfplumber||!v.producer.packages?.['pdfminer.six']||
  !isDeepStrictEqual(v.producer.options,{layout:true,x_tolerance:2,y_tolerance:2})||!Array.isArray(v.pages)||!v.pages.length||v.pages.length>NATIVE_REGION_LIMITS.pages)invalid();
 let charCount=0,regionCount=0,textBytes=0;const pages=new Set<number>();
 for(const p of v.pages){
  if(!Number.isSafeInteger(p.physicalPage)||p.physicalPage<1||p.physicalPage>source.pageCount||pages.has(p.physicalPage)||
   !Number.isFinite(p.width)||!Number.isFinite(p.height)||p.width<=0||p.height<=0||!Array.isArray(p.chars)||!p.chars.length||
   !Array.isArray(p.regions)||!p.regions.length)invalid();pages.add(p.physicalPage);
  charCount+=p.chars.length;if(charCount>NATIVE_REGION_LIMITS.chars)invalid();
  for(const [i,c] of p.chars.entries())if(c.index!==i||typeof c.text!=='string'||!c.text||c.text.length>32||
   typeof c.font!=='string'||!Array.isArray(c.bbox)||c.bbox.length!==4||!c.bbox.every(Number.isFinite)||c.bbox[0]>c.bbox[2]||c.bbox[1]>c.bbox[3])invalid();
  const ids=new Set<string>();
  for(const r of p.regions){
   if(++regionCount>NATIVE_REGION_LIMITS.regions||typeof r.id!=='string'||!/^[-a-zA-Z0-9_]{1,80}$/.test(r.id)||ids.has(r.id)||
    !rect(r.bbox,p.width,p.height)||typeof r.text!=='string'||!compact(r.text)||r.text.length>NATIVE_REGION_LIMITS.regionUtf16||
    !Array.isArray(r.charIndices)||!r.charIndices.length||typeof r.boundsReference!=='string'||!/^#\/tables\/\d+$/.test(r.boundsReference))invalid();
   ids.add(r.id);textBytes+=Buffer.byteLength(r.text);if(textBytes>NATIVE_REGION_LIMITS.textBytes)invalid();
   const observed=p.chars.filter(c=>compact(c.text)&&intersects(c.bbox,r.bbox));
   if(observed.some(c=>!inside(c.bbox,r.bbox))||!isDeepStrictEqual(observed.map(c=>c.index),r.charIndices)||
    compact(observed.map(c=>c.text).join(''))!==compact(r.text))invalid();
  }
 }
 return v;
}
export function projectNativeRegionText(bundle:NativeRegionBundle,input:Array<{pageNumber:number;locator:string;text:string}>,observationSha256:string){
 validateNativeRegionBundle(bundle,bundle.source);if(!hex(observationSha256)||input.length!==bundle.source.pageCount||input.some((p,i)=>p.pageNumber!==i+1||typeof p.text!=='string'))invalid();
 const pages=input.map(p=>({...p})),projections:PageProjection[]=[];
 for(const p of bundle.pages){
  const target=pages[p.physicalPage-1],previousBodySha256=nativeRegionHash(target.text),windows:PageProjection['windows']=[];
  for(const r of p.regions){target.text+='\n\n';const startUtf16=target.text.length;target.text+=r.text;
   windows.push({regionId:r.id,bbox:r.bbox,startUtf16,endUtf16:target.text.length,quoteSha256:nativeRegionHash(r.text)});}
  projections.push({physicalPage:p.physicalPage,previousBodySha256,bodySha256:nativeRegionHash(target.text),windows});
 }
 const manifest:NativeRegionManifest={policy:NATIVE_REGION_TEXT_VERSION,source:bundle.source,observationSha256,pages:projections};
 return {pages,manifest};
}
export function nativeRegionFingerprint(progress:unknown){
 const v=(progress as {nativeRegionText?:{policy:string;manifestSha256:string;observationSha256:string}}|undefined)?.nativeRegionText;
 if(v===undefined)return undefined;
 if(v.policy!==NATIVE_REGION_TEXT_VERSION||!hex(v.manifestSha256)||!hex(v.observationSha256))invalid();
 return {policy:v.policy,manifestSha256:v.manifestSha256,observationSha256:v.observationSha256};
}
async function readRegistered(hash:string){
 if(!hex(hash))invalid();const f=await open(resolve(process.env.LIBRARY_DIR||'./data/library',hash),'r');
 try{const size=(await f.stat()).size;if(size>NATIVE_REGION_LIMITS.bytes)invalid();const bytes=await f.readFile();
  if(bytes.length!==size||nativeRegionHash(bytes)!==hash)invalid();return JSON.parse(bytes.toString('utf8'));
 }finally{await f.close();}
}
export type NativeRegionWindowInput=DoclingTextContextWindowBinding&{body:string;progress:unknown};
export type PreparedNativeRegionWindows={policy:typeof NATIVE_REGION_WINDOWS_POLICY;binding:DoclingTextContextWindowBinding;hintSha256:string;
 observationSha256:string;manifestSha256:string;windows:Array<PageProjection['windows'][number]&{references:Array<{reference:string}>;semanticRelationsVerified:false}>};
const prepared=new WeakSet<PreparedNativeRegionWindows>();
/** Only the source-registered hashes are read, never a caller-selected blob. */
export async function readNativeRegionObservation(input:NativeRegionWindowInput){
 const ref=nativeRegionFingerprint(input.progress);if(!ref)return null;
 const manifest=await readRegistered(ref.manifestSha256) as NativeRegionManifest;
 const source={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,pageCount:input.pageCount};
 if(manifest.policy!==NATIVE_REGION_TEXT_VERSION||!isDeepStrictEqual(manifest.source,source)||manifest.observationSha256!==ref.observationSha256||!Array.isArray(manifest.pages))invalid();
 const bundle=validateNativeRegionBundle(await readRegistered(ref.observationSha256),source),page=bundle.pages.find(p=>p.physicalPage===input.physicalPage),
  projection=manifest.pages.find(p=>p.physicalPage===input.physicalPage);
 if(!page&&!projection)return null;if(!page||!projection||projection.bodySha256!==nativeRegionHash(input.body)||input.bodySha256!==projection.bodySha256||!Array.isArray(projection.windows)||projection.windows.length!==page.regions.length)invalid();
 let end:number|undefined;
 for(const [i,w] of projection.windows.entries()){
  const r=page.regions[i];if(w.regionId!==r.id||!isDeepStrictEqual(w.bbox,r.bbox)||!Number.isSafeInteger(w.startUtf16)||!Number.isSafeInteger(w.endUtf16)||
   w.startUtf16<2||w.endUtf16!==w.startUtf16+r.text.length||input.body.slice(w.startUtf16,w.endUtf16)!==r.text||w.quoteSha256!==nativeRegionHash(r.text)||
   input.body.slice(w.startUtf16-2,w.startUtf16)!=='\n\n'||(end!==undefined&&w.startUtf16!==end+2))invalid();
  if(i===0&&nativeRegionHash(input.body.slice(0,w.startUtf16-2))!==projection.previousBodySha256)invalid();end=w.endUtf16;
 }
 if(end!==input.body.length)invalid();
 return {policy:NATIVE_REGION_TEXT_VERSION,source,physicalPage:page.physicalPage,observationSha256:ref.observationSha256,manifestSha256:ref.manifestSha256,
  producer:bundle.producer,page,projection,sourceContentIsUntrusted:true as const,semanticRelationsVerified:false as const,readingOrderVerified:false as const,unicodeFaithfulnessVerified:false as const};
}
export async function prepareNativeRegionWindows(input:NativeRegionWindowInput){
 const observation=await readNativeRegionObservation(input);if(!observation)return null;
 const {body:_body,progress:_progress,...binding}=input;void _body;void _progress;
 const value:PreparedNativeRegionWindows={policy:NATIVE_REGION_WINDOWS_POLICY,binding,manifestSha256:observation.manifestSha256,
  observationSha256:observation.observationSha256,windows:observation.projection.windows.map(w=>({...w,references:[{reference:'native-region:'+w.regionId}],semanticRelationsVerified:false})),hintSha256:''};
 value.hintSha256=nativeRegionHash(JSON.stringify(value));Object.freeze(value.binding);for(const w of value.windows){for(const ref of w.references)Object.freeze(ref);Object.freeze(w.references);Object.freeze(w.bbox);Object.freeze(w);}Object.freeze(value.windows);Object.freeze(value);
 prepared.add(value);return value;
}
export function assertPreparedNativeRegionWindows(value:PreparedNativeRegionWindows,binding:DoclingTextContextWindowBinding){
 if(!prepared.has(value)||!isDeepStrictEqual(value.binding,binding))invalid();
}
