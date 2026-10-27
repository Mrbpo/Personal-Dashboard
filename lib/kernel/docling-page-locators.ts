import{createHash}from'node:crypto';
import type{readDocumentPageRegions}from'./document-context.ts';
import type{DoclingRegionResultReference}from'./docling-source-regions.ts';
type Page=Extract<Awaited<ReturnType<typeof readDocumentPageRegions>>,{status:'available'}>;
const canonical=(x:unknown):string=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v),
 sha=(x:unknown)=>createHash('sha256').update(canonical(x)).digest('hex'),hex=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const DOCLING_PAGE_LOCATOR_LIMITS=Object.freeze({nodes:128,bytes:16384});
export function doclingPageLocatorsEnabled(value=process.env.STUDY_PDF_REGION_LOCATORS){
 if(value===undefined||value===''||value==='off')return false;
 if(value!=='source-locators-v1')throw Error('Invalid STUDY_PDF_REGION_LOCATORS');return true;
}
/** Complete locator set only, never a prefix of text/cells or a claim that
 * producer geometry, reading order or semantic relations have been verified. */
export function projectDoclingPageLocators(page:Page,originalObservationSha256:string){
 if(!hex(originalObservationSha256)||page.index.sourceBindingVerified!==true||page.index.semanticRelationsVerified!==false||
  page.index.visibilityVerified!==false||page.index.textFaithfulnessVerified!==false||page.index.readingOrderVerified!==false||page.index.inferredRelations.length)
  throw Error('Invalid source locator observation');
 const nodes=page.index.nodes.map(n=>({reference:n.reference,ordinal:n.ordinal,path:n.path.map(({reference,via})=>({reference,via})),membership:n.membership,
   declaredPageNumbers:[...n.declaredPageNumbers],physicalPageNumbers:[...n.physicalPageNumbers],geometry:structuredClone(n.geometry),textScope:n.textScope,
   rawNodeSha256:sha(n.raw),observedLabel:typeof n.raw.label==='string'?n.raw.label:null})),
  common={version:'docling-page-locators-v1' as const,scope:'source-locators-only' as const,originalObservationSha256,
   sourceResult:structuredClone(page.index.result),physicalPage:page.physicalPage,pageSize:structuredClone(page.index.pageSize),producerDocument:structuredClone(page.index.producerDocument),
   coordinateTransform:structuredClone(page.coordinateTransform),sourceNodeCount:nodes.length,
   sourceContentIsUntrusted:true as const,textIncluded:false as const,tableCellsIncluded:false as const,semanticRelationsVerified:false as const,
   visibilityVerified:false as const,textFaithfulnessVerified:false as const,readingOrderVerified:false as const};
 const complete={...common,status:'available' as const,reason:null,nodes},reason=nodes.length>DOCLING_PAGE_LOCATOR_LIMITS.nodes?'locator-node-limit':
  Buffer.byteLength(canonical({...complete,projectionSha256:sha(complete)}))>DOCLING_PAGE_LOCATOR_LIMITS.bytes?'locator-byte-limit':null,
  value=reason?{...common,status:'unavailable' as const,reason,nodes:[] as typeof nodes}:complete;
 const result={...value,projectionSha256:sha(value)};
 if(Buffer.byteLength(canonical(result))>DOCLING_PAGE_LOCATOR_LIMITS.bytes)throw new RangeError('locator-header-byte-limit');
 return result;
}
export type DoclingPageLocators=ReturnType<typeof projectDoclingPageLocators>;
export function assertDoclingPageLocators(p:DoclingPageLocators,originalSha:string,expectedResult:DoclingRegionResultReference|undefined,physicalPage:number){
 const{projectionSha256,...value}=p;
 if(Object.keys(p).some(k=>!['version','scope','originalObservationSha256','sourceResult','physicalPage','pageSize','producerDocument','coordinateTransform','sourceNodeCount',
  'sourceContentIsUntrusted','textIncluded','tableCellsIncluded','semanticRelationsVerified','visibilityVerified','textFaithfulnessVerified','readingOrderVerified','status','reason','nodes','projectionSha256'].includes(k))||
  p.version!=='docling-page-locators-v1'||p.scope!=='source-locators-only'||p.originalObservationSha256!==originalSha||
  canonical(p.sourceResult)!==canonical(expectedResult)||p.physicalPage!==physicalPage||sha(value)!==projectionSha256||
  p.sourceContentIsUntrusted!==true||p.textIncluded!==false||p.tableCellsIncluded!==false||p.semanticRelationsVerified!==false||p.visibilityVerified!==false||
  p.textFaithfulnessVerified!==false||p.readingOrderVerified!==false||!Number.isSafeInteger(p.sourceNodeCount)||p.sourceNodeCount<0||
  !Array.isArray(p.nodes)||p.nodes.length>DOCLING_PAGE_LOCATOR_LIMITS.nodes||Buffer.byteLength(canonical(p))>DOCLING_PAGE_LOCATOR_LIMITS.bytes||
  (p.status==='available'?(p.reason!==null||p.nodes.length!==p.sourceNodeCount):p.status!=='unavailable'||!p.reason||p.nodes.length!==0))
  throw Error('Invalid source locator projection');
 const seen=new Set<string>();
 for(const n of p.nodes){
  if(Object.keys(n).some(k=>!['reference','ordinal','path','membership','declaredPageNumbers','physicalPageNumbers','geometry','textScope','rawNodeSha256','observedLabel'].includes(k))||
   !/^#\/(texts|tables|groups|pictures|field_regions|field_items)\/\d+$/.test(n.reference)||seen.has(n.reference)||
   !Number.isSafeInteger(n.ordinal)||n.ordinal<0||!hex(n.rawNodeSha256)||!Array.isArray(n.path)||
   !['declared-provenance','ancestor-reference'].includes(n.membership)||!['single-page','multi-page','unknown'].includes(n.textScope)||
   ![n.declaredPageNumbers,n.physicalPageNumbers].every(a=>Array.isArray(a)&&a.every(v=>Number.isSafeInteger(v)&&v>0))||
   (n.geometry.status==='observed'?![n.geometry.bbox.l,n.geometry.bbox.t,n.geometry.bbox.r,n.geometry.bbox.b].every(Number.isFinite):
    n.geometry.status!=='unknown'||!n.geometry.reason))throw Error('Invalid source locator node');
  seen.add(n.reference);
 }
}
