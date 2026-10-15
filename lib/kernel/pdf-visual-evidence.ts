import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,utimes,rename,unlink,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {PDFDocument} from 'pdf-lib';
import sharp from 'sharp';
import type {Pool,PoolClient} from 'pg';
import {localPdfPageImage} from '../local-ocr.ts';
import type {DoclingVisualLayout} from './docling-result.ts';
import type {DocumentContextSource} from './document-context.ts';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const pdfVisualCanonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
 ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const root=()=>resolve(/* turbopackIgnore: true */ process.env.LIBRARY_DIR||'./data/library');
const isSha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const PDF_VISUAL_STORAGE_LIMITS=Object.freeze({pages:500,assets:1500,bytes:256*1024*1024});
export const PDF_VISUAL_READ_LIMITS=Object.freeze({images:64,bytes:32*1024*1024,imageInputTokens:65536});
export class PdfVisualEvidenceError extends Error{
 readonly code:'source-changed'|'unavailable'|'count-limit'|'byte-limit'|'input-limit'|'invalid';
 constructor(code:PdfVisualEvidenceError['code'],message:string){super(message);this.code=code;this.name='PdfVisualEvidenceError';}
}
type Queryable=Pick<Pool,'query'>|Pick<PoolClient,'query'>;
type Json=Record<string,unknown>;
export type PdfVisualAsset={kind:'pdf-page'|'pdf-region';physicalPage:number;sha256:string;width:number;height:number;byteLength:number;
 provenance:{rawPdfSha256:string;pageRenderSha256:string;pageSizePoints:{width:number;height:number};rotation:number;
  rendererPolicy:string;sourcePageCropBox:{x:number;y:number;width:number;height:number};
  region?:{pictureRef:string;derivedPageNumber:number;derivedInputSha256?:string;copyIndices?:number[];resultBlobSha256:string;
   bbox:{l:number;t:number;r:number;b:number;coord_origin:'BOTTOMLEFT'|'TOPLEFT'};cropPixelBox:[number,number,number,number];
   pointToPixelScaleX:number;pointToPixelScaleY:number;rounding:'outward-floor-ceil';textReferences:unknown[]}}};
type ContentManifest={schema:1;rawPdfSha256:string;pageCount:number;layout:DoclingVisualLayout;layoutStatus:'available'|'unavailable';layoutReason?:string;
 renderStatus:'available'|'unavailable';renderReason?:string;assets:PdfVisualAsset[]};
export type PreparedPdfVisualEvidence={owner:string;documentId:string;sourceHash:string;contentSha256:string;content:ContentManifest};
const prepared=new WeakSet<PreparedPdfVisualEvidence>();
const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}};
async function store(bytes:Uint8Array){
 const hash=sha(bytes);await mkdir(root(),{recursive:true,mode:0o700});
 try{await writeFile(resolve(root(),hash),bytes,{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 if((await stat(resolve(root(),hash))).size!==bytes.length||sha(await readFile(resolve(root(),hash)))!==hash)throw new PdfVisualEvidenceError('invalid','PDF visual blob differs');
 await utimes(resolve(root(),hash),new Date(),new Date());return hash;
}
/** Source-derived PNG work and blob IO occur before the short ingestion transaction.
 * renderer is an internal test seam; Kernel ingestion always uses the fixed local renderer. */
export async function preparePdfVisualEvidence(input:{owner:string;documentId:string;sourceHash:string;pdfBytes:Uint8Array;layout:DoclingVisualLayout},
 renderer:(bytes:Uint8Array)=>Promise<Buffer|null>=localPdfPageImage):Promise<PreparedPdfVisualEvidence>{
 input={...input,pdfBytes:Buffer.from(input.pdfBytes),layout:structuredClone(input.layout)};
 if(!input.owner||!input.documentId||!isSha(input.sourceHash)||sha(input.pdfBytes)!==input.sourceHash)throw new PdfVisualEvidenceError('invalid','Original PDF identity differs');
 const pdf=await PDFDocument.load(input.pdfBytes,{updateMetadata:false}),count=pdf.getPageCount();
 if(!count||count>PDF_VISUAL_STORAGE_LIMITS.pages)throw new PdfVisualEvidenceError('count-limit','PDF visual page limit exceeded');
 if(input.layout.status==='available'&&(input.layout.pageSizes.length!==count||
  [...input.layout.pageSizes].sort((a,b)=>a.pageNumber-b.pageNumber).some((page,index)=>page.pageNumber!==index+1)))
  throw new PdfVisualEvidenceError('invalid','Complete Docling layout lacks original page coverage');
 // A digest-shaped caller value is not proof of actual Docling provenance.
 const savedResults=new Map<string,ReturnType<typeof JSON.parse>>();
 for(const reference of input.layout.resultReferences||[]){
  if(!isSha(reference.resultBlobSha256)||!isSha(reference.derivedInputSha256)||!Array.isArray(reference.copyIndices)||
   !reference.copyIndices.length||reference.copyIndices.some((n,i)=>!Number.isInteger(n)||n<0||n>=count||(i>0&&n!==reference.copyIndices[i-1]+1)))
   throw new PdfVisualEvidenceError('invalid','Invalid Docling result reference');
  const bytes=await readFile(resolve(root(),reference.resultBlobSha256)),saved=JSON.parse(bytes.toString('utf8'));
  if(sha(bytes)!==reference.resultBlobSha256||saved.identity?.owner!==input.owner||saved.identity?.documentId!==input.documentId||
   saved.identity?.sourceHash!==input.sourceHash||saved.identity?.totalPages!==count||saved.identity?.inputHash!==reference.derivedInputSha256||
   pdfVisualCanonical(saved.identity?.copyIndices)!==pdfVisualCanonical(reference.copyIndices))throw new PdfVisualEvidenceError('invalid','Saved Docling layout source mapping differs');
  savedResults.set(reference.resultBlobSha256,saved);
 }
 for(const region of input.layout.regions){
  if(!isSha(region.resultBlobSha256))throw new PdfVisualEvidenceError('invalid','PDF region lacks saved Docling result');
  let saved=savedResults.get(region.resultBlobSha256);
  if(!saved){const bytes=await readFile(resolve(root(),region.resultBlobSha256));
   if(sha(bytes)!==region.resultBlobSha256)throw new PdfVisualEvidenceError('invalid','Docling result blob checksum differs');
   saved=JSON.parse(bytes.toString('utf8'));savedResults.set(region.resultBlobSha256,saved);}
  const identity=saved.identity;
  if(identity?.owner!==input.owner||identity?.documentId!==input.documentId||identity?.sourceHash!==input.sourceHash||identity?.totalPages!==count||
   identity?.inputHash!==region.derivedInputSha256||pdfVisualCanonical(identity?.copyIndices)!==pdfVisualCanonical(region.copyIndices)||
   !Array.isArray(region.copyIndices)||region.copyIndices[region.derivedPageNumber-1]+1!==region.pageNumber)
   throw new PdfVisualEvidenceError('invalid','Docling original/derived source mapping differs');
  const doc=saved.result?.document?.json_content,picture=doc?.pictures?.[Number(region.pictureRef.split('/').at(-1))];
  if(saved.result?.status!=='success'||!/^#\/pictures\/\d+$/.test(region.pictureRef)||
   pdfVisualCanonical(doc?.pages?.[region.derivedPageNumber]?.size)!==pdfVisualCanonical(region.pageSize)||
   !picture?.prov?.some((prov:{page_no:number;bbox:unknown})=>prov.page_no===region.derivedPageNumber&&pdfVisualCanonical(prov.bbox)===pdfVisualCanonical(region.bbox)))
   throw new PdfVisualEvidenceError('invalid','PDF region is not in its actual saved Docling result');
 }
 const content:ContentManifest={schema:1,rawPdfSha256:input.sourceHash,pageCount:count,layout:structuredClone(input.layout),layoutStatus:input.layout.status,
  ...(input.layout.reason?{layoutReason:input.layout.reason}:{}),renderStatus:'available',assets:[]};
 const rendererPolicy=renderer===localPdfPageImage?'localPdfPageImage-pdftoppm-max2500-sharp0354-v1':'injected-offline-renderer-v1';
 const cacheIdentity={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,count,rendererPolicy,layoutSha256:sha(pdfVisualCanonical(input.layout))};
 const cachePath=resolve(root(),`.pdf-visual-${sha(pdfVisualCanonical(cacheIdentity))}.json`);
 let cached:{identity:typeof cacheIdentity;completed:PdfVisualAsset[][]}={identity:cacheIdentity,completed:[]};
 try{const value=JSON.parse(await readFile(cachePath,'utf8'));if(pdfVisualCanonical(value.identity)!==pdfVisualCanonical(cacheIdentity)||!Array.isArray(value.completed))throw new Error('identity');cached=value;}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new PdfVisualEvidenceError('invalid','PDF visual staging cache differs; no automatic rerender');}
 const persist=async()=>{await mkdir(root(),{recursive:true,mode:0o700});const temp=resolve(root(),`.pdf-visual-${randomUUID()}.tmp`);
  try{await writeFile(temp,pdfVisualCanonical(cached),{flag:'wx',mode:0o600});await rename(temp,cachePath);}finally{await unlink(temp).catch(()=>{});}};
 let total=0;
 for(let index=0;index<count;index++){
  const restored=cached.completed[index];
  if(restored){
   const expectedRegions=input.layout.regions.filter(region=>region.pageNumber===index+1);
   if(restored.length!==1+expectedRegions.length||restored[0].kind!=='pdf-page'||restored.some(asset=>!isSha(asset.sha256)||asset.physicalPage!==index+1||asset.provenance.rawPdfSha256!==input.sourceHash||
    asset.provenance.rendererPolicy!==rendererPolicy))throw new PdfVisualEvidenceError('invalid','Cached PDF visual page identity differs');
   if(restored.slice(1).some((asset,i)=>asset.kind!=='pdf-region'||asset.provenance.region?.pictureRef!==expectedRegions[i].pictureRef||
    pdfVisualCanonical(asset.provenance.region?.bbox)!==pdfVisualCanonical(expectedRegions[i].bbox)||
    asset.provenance.region?.resultBlobSha256!==expectedRegions[i].resultBlobSha256))throw new PdfVisualEvidenceError('invalid','Cached region provenance differs');
   for(const asset of restored){const bytes=await readFile(resolve(root(),asset.sha256));
    if(sha(bytes)!==asset.sha256||bytes.length!==asset.byteLength)throw new PdfVisualEvidenceError('invalid','Cached PDF visual blob differs; no automatic rerender');
    const meta=await sharp(bytes).metadata();if(meta.format!=='png'||meta.width!==asset.width||meta.height!==asset.height)throw new PdfVisualEvidenceError('invalid','Cached PDF visual dimensions differ');
    await utimes(resolve(root(),asset.sha256),new Date(),new Date());
    total+=asset.byteLength;content.assets.push(asset);}
   if(total>PDF_VISUAL_STORAGE_LIMITS.bytes||content.assets.length>PDF_VISUAL_STORAGE_LIMITS.assets)throw new PdfVisualEvidenceError('byte-limit','Cached PDF visuals exceed storage limit');
   continue;
  }
  const pageAssetStart=content.assets.length;
  const sourcePage=pdf.getPage(index),copy=await PDFDocument.create();copy.setCreationDate(new Date(0));copy.setModificationDate(new Date(0));
  for(const page of await copy.copyPages(pdf,[index]))copy.addPage(page);
  const bytes=await renderer(await copy.save());
  if(!bytes){content.renderStatus='unavailable';content.renderReason='Local PDF renderer unavailable; completed assets and real layout retained';break;}
  const metadata=await sharp(bytes,{limitInputPixels:100000000}).metadata();
  if(metadata.format!=='png'||!metadata.width||!metadata.height)throw new PdfVisualEvidenceError('invalid','Renderer did not return a bounded PNG');
  const width=metadata.width,height=metadata.height,size=sourcePage.getSize(),rotation=sourcePage.getRotation().angle,cropBox=sourcePage.getCropBox();
  const pageHash=await store(bytes),provenance={rawPdfSha256:input.sourceHash,pageRenderSha256:pageHash,pageSizePoints:size,rotation,
    rendererPolicy,sourcePageCropBox:cropBox};
  const add=(asset:PdfVisualAsset)=>{total+=asset.byteLength;if(total>PDF_VISUAL_STORAGE_LIMITS.bytes||content.assets.length>=PDF_VISUAL_STORAGE_LIMITS.assets)
    throw new PdfVisualEvidenceError('byte-limit','PDF visual storage limit exceeded; previous version retained');content.assets.push(asset);};
  add({kind:'pdf-page',physicalPage:index+1,sha256:pageHash,width,height,byteLength:bytes.length,provenance});
  for(const region of input.layout.regions.filter(item=>item.pageNumber===index+1)){
   if(rotation!==0||cropBox.x!==0||cropBox.y!==0||cropBox.width!==size.width||cropBox.height!==size.height||
    Math.abs(region.pageSize.width-size.width)>.01||Math.abs(region.pageSize.height-size.height)>.01)
    throw new PdfVisualEvidenceError('invalid','Rotated/cropped or mismatched PDF region geometry requires an explicit transform');
   if(!isSha(region.resultBlobSha256))throw new PdfVisualEvidenceError('invalid','PDF region lacks immutable Docling result provenance');
   const b=region.bbox,sx=width/size.width,sy=height/size.height,top=b.coord_origin==='BOTTOMLEFT'?size.height-b.t:b.t,
    bottom=b.coord_origin==='BOTTOMLEFT'?size.height-b.b:b.b;
   const pixelBox:[number,number,number,number]=[Math.floor(b.l*sx),Math.floor(top*sy),Math.ceil(b.r*sx),Math.ceil(bottom*sy)];
   if(!pixelBox.every(Number.isSafeInteger)||pixelBox[0]<0||pixelBox[1]<0||pixelBox[2]>width||pixelBox[3]>height||
    pixelBox[0]>=pixelBox[2]||pixelBox[1]>=pixelBox[3])throw new PdfVisualEvidenceError('invalid','Invalid real PDF crop');
   const cropped=await sharp(bytes).extract({left:pixelBox[0],top:pixelBox[1],width:pixelBox[2]-pixelBox[0],height:pixelBox[3]-pixelBox[1]}).png().toBuffer();
   const hash=await store(cropped);
   add({kind:'pdf-region',physicalPage:index+1,sha256:hash,width:pixelBox[2]-pixelBox[0],height:pixelBox[3]-pixelBox[1],byteLength:cropped.length,
    provenance:{...provenance,region:{pictureRef:region.pictureRef,derivedPageNumber:region.derivedPageNumber,
      ...(region.derivedInputSha256?{derivedInputSha256:region.derivedInputSha256}:{}),...(region.copyIndices?{copyIndices:[...region.copyIndices]}:{}),
      resultBlobSha256:region.resultBlobSha256,bbox:{...b},cropPixelBox:pixelBox,pointToPixelScaleX:sx,pointToPixelScaleY:sy,
      rounding:'outward-floor-ceil',textReferences:structuredClone(region.textReferences)}}});
  }
  cached.completed[index]=content.assets.slice(pageAssetStart);await persist();
 }
 if(input.layout.regions.some(region=>!Number.isInteger(region.pageNumber)||region.pageNumber<1||region.pageNumber>count))throw new PdfVisualEvidenceError('invalid','Region original page unavailable');
 const value={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,contentSha256:sha(pdfVisualCanonical(content)),content};
 freeze(value);prepared.add(value);return value;
}
export function assertPreparedPdfVisualEvidence(value:PreparedPdfVisualEvidence,owner:string,documentId:string,sourceHash:string,pageCount:number){
 if(!prepared.has(value)||value.owner!==owner||value.documentId!==documentId||value.sourceHash!==sourceHash||value.content.pageCount!==pageCount||
  sha(pdfVisualCanonical(value.content))!==value.contentSha256)throw new PdfVisualEvidenceError('invalid','PDF visuals have no matching staging receipt');
}
export async function commitPdfVisualEvidence(db:Queryable,value:PreparedPdfVisualEvidence,source:DocumentContextSource,pageEvidenceIds:string[]){
 assertPreparedPdfVisualEvidence(value,value.owner,source.documentId,source.sourceHash,pageEvidenceIds.length);
 const manifest={content:value.content,bindings:value.content.assets.map((asset,index)=>({index,anchorEvidenceId:pageEvidenceIds[asset.physicalPage-1]}))};
 const hash=sha(pdfVisualCanonical(manifest));
 await db.query(`INSERT INTO document_pdf_visual_manifests(version_id,source_version_id,source_hash,content_sha256,manifest_sha256,manifest)
 VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(version_id) DO NOTHING`,
 [source.currentVersionId,source.sourceVersionId,source.sourceHash,value.contentSha256,hash,pdfVisualCanonical(manifest)]);
 const actual=(await db.query<{manifest_sha256:string}>('SELECT manifest_sha256 FROM document_pdf_visual_manifests WHERE version_id=$1',[source.currentVersionId])).rows[0];
 if(actual?.manifest_sha256!==hash)throw new PdfVisualEvidenceError('invalid','Immutable PDF visual manifest differs');
 return hash;
}
export type PdfVisualImageEvidence={kind:'pdf-page'|'pdf-region';attachmentId:string;assetId:string;anchorEvidenceId:string;physicalPage:number;
 rawPdfSha256:string;manifestSha256:string;source:DocumentContextSource;mime:'image/png';sha256:string;byteLength:number;width:number;height:number;
 provenance:PdfVisualAsset['provenance'];bytes:Uint8Array};
async function current(db:Queryable,owner:string,source:DocumentContextSource){
 const rows=(await db.query(`SELECT d.id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
 JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
 WHERE d.owner_id=$1 AND d.id=$2 AND d.current_version_id=$3 AND v.source_version_id=$4 AND d.source_hash=$5 AND s.raw_sha256=$5 AND NOT d.hidden
 AND ($6::text IS NULL OR coalesce(d.course_id,'')=$6) AND NOT EXISTS(SELECT 1 FROM document_texts n WHERE n.owner_id=d.owner_id
 AND n.origin=d.origin AND n.origin_key=d.origin_key AND NOT n.hidden AND (n.created_at>d.created_at OR (n.created_at=d.created_at AND n.id>d.id)))`,
 [owner,source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash,source.courseId??null])).rows;
 if(rows.length!==1)throw new PdfVisualEvidenceError('source-changed','PDF visual source is not current for this owner');
}
/** Multiple real regions may share one real page; never invent caption nodes. */
export async function readPdfVisualEvidence(db:Queryable,owner:string,source:DocumentContextSource,pageEvidenceIds?:string[],
 limits:{images:number;bytes:number;imageInputTokens:number}=PDF_VISUAL_READ_LIMITS){
 await current(db,owner,source);
 if(![limits.images,limits.bytes,limits.imageInputTokens].every(n=>Number.isSafeInteger(n)&&n>0)||limits.images>PDF_VISUAL_READ_LIMITS.images||
  limits.bytes>PDF_VISUAL_READ_LIMITS.bytes||limits.imageInputTokens>PDF_VISUAL_READ_LIMITS.imageInputTokens)throw new PdfVisualEvidenceError('invalid','Invalid bounded PDF visual read');
 const row=(await db.query<{manifest:{content:ContentManifest;bindings:Array<{index:number;anchorEvidenceId:string}>};manifest_sha256:string;content_sha256:string}>(
  'SELECT manifest,manifest_sha256,content_sha256 FROM document_pdf_visual_manifests WHERE version_id=$1 AND source_version_id=$2 AND source_hash=$3',
  [source.currentVersionId,source.sourceVersionId,source.sourceHash])).rows[0];
 if(!row){await current(db,owner,source);return {registered:false,layoutStatus:'unavailable' as const,renderStatus:'unavailable' as const,
  images:[] as PdfVisualImageEvidence[],manifestSha256:null,layout:null};}
 const {content,bindings}=row.manifest;
 if(sha(pdfVisualCanonical(row.manifest))!==row.manifest_sha256||sha(pdfVisualCanonical(content))!==row.content_sha256||content.rawPdfSha256!==source.sourceHash||
  content.assets.length!==bindings.length)throw new PdfVisualEvidenceError('invalid','PDF visual manifest identity differs');
 const pages=(await db.query<{page_number:number;evidence_id:string}>(`SELECT p.page_number,p.evidence_id FROM document_text_pages p
 JOIN evidence e ON e.id=p.evidence_id WHERE p.version_id=$1 AND e.source_version_id=$2 ORDER BY p.page_number`,[source.currentVersionId,source.sourceVersionId])).rows;
 if(pages.length!==content.pageCount||pages.some((page,i)=>page.page_number!==i+1))throw new PdfVisualEvidenceError('source-changed','PDF page evidence differs');
 if(pageEvidenceIds&&(!Array.isArray(pageEvidenceIds)||new Set(pageEvidenceIds).size!==pageEvidenceIds.length||pageEvidenceIds.some(id=>!pages.some(page=>page.evidence_id===id))))
  throw new PdfVisualEvidenceError('source-changed','Requested PDF anchor is not a current page');
 if(content.renderStatus!=='available'){await current(db,owner,source);return {registered:true,renderStatus:content.renderStatus,
  layoutStatus:content.layoutStatus,layout:content.layout,images:[] as PdfVisualImageEvidence[],manifestSha256:row.manifest_sha256};}
 const selected=content.assets.flatMap((asset,index)=>{
  const binding=bindings[index];if(binding.index!==index||binding.anchorEvidenceId!==pages[asset.physicalPage-1]?.evidence_id||
   !['pdf-page','pdf-region'].includes(asset.kind)||!isSha(asset.sha256)||asset.provenance.rawPdfSha256!==source.sourceHash||
   ![asset.width,asset.height,asset.byteLength].every(n=>Number.isSafeInteger(n)&&n>0))throw new PdfVisualEvidenceError('invalid','PDF image binding differs');
  return !pageEvidenceIds||pageEvidenceIds.includes(binding.anchorEvidenceId)?[{asset,binding}]:[];});
 if(selected.length>limits.images)throw new PdfVisualEvidenceError('count-limit','PDF image count exceeds limit; none silently dropped');
 if(selected.reduce((sum,{asset})=>sum+asset.byteLength,0)>limits.bytes)throw new PdfVisualEvidenceError('byte-limit','PDF images exceed byte limit');
 if(selected.reduce((sum,{asset})=>sum+2*Math.ceil(asset.width/32)*Math.ceil(asset.height/32)+1,0)>limits.imageInputTokens)
  throw new PdfVisualEvidenceError('input-limit','PDF images exceed input bound');
 const images:PdfVisualImageEvidence[]=[];
 for(const {asset,binding} of selected){
  const bytes=await readFile(resolve(root(),asset.sha256)).catch(()=>{throw new PdfVisualEvidenceError('unavailable','Original PDF image blob missing');});
  if(bytes.length!==asset.byteLength||sha(bytes)!==asset.sha256)throw new PdfVisualEvidenceError('invalid','PDF image blob checksum differs');
  const metadata=await sharp(bytes).metadata();if(metadata.format!=='png'||metadata.width!==asset.width||metadata.height!==asset.height)throw new PdfVisualEvidenceError('invalid','PDF image dimensions differ');
  images.push({...asset,attachmentId:sha(pdfVisualCanonical([source,row.manifest_sha256,binding.index])),assetId:asset.sha256,anchorEvidenceId:binding.anchorEvidenceId,
   rawPdfSha256:source.sourceHash,manifestSha256:row.manifest_sha256,source:{...source},mime:'image/png',bytes});
 }
 await current(db,owner,source);return {registered:true,renderStatus:content.renderStatus,layoutStatus:content.layoutStatus,layout:content.layout,images,manifestSha256:row.manifest_sha256};
}
/** Include historical, hidden, raw-result and render parents for reconstructible blobs. */
export async function pdfVisualBlobHashes(db:Queryable):Promise<string[]>{
 const rows=(await db.query<{manifest:{content:ContentManifest}}>('SELECT manifest FROM document_pdf_visual_manifests')).rows;
 const hashes=rows.flatMap(({manifest})=>[manifest.content.rawPdfSha256,...(manifest.content.layout.resultReferences||[]).flatMap(reference=>
  [reference.resultBlobSha256,reference.derivedInputSha256]),...manifest.content.layout.regions.flatMap(region=>
  [region.resultBlobSha256,region.derivedInputSha256].filter(isSha)),...manifest.content.assets.flatMap(asset=>
  [asset.sha256,asset.provenance.pageRenderSha256,asset.provenance.region?.resultBlobSha256,asset.provenance.region?.derivedInputSha256].filter(isSha))]);
 // Interrupted render caches are derived drafts, never authority. Protect their
 // immutable blobs only while their source identity belongs to a known document
 // or persistent ingestion job, including failed jobs that can be resumed.
 const sources=(await db.query<{owner:string;id:string;source_hash:string|null}>(`SELECT owner_id owner,id,source_hash FROM document_texts
 UNION SELECT payload->>'owner' owner,payload->>'id' id,payload->>'sourceHash' source_hash FROM ingestion_jobs WHERE kind='docling_document'`)).rows;
 const files=await readdir(root()).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;});
 for(const name of files.filter(name=>/^\.pdf-visual-[a-f0-9]{64}\.json$/.test(name))){
  const cache=JSON.parse(await readFile(resolve(root(),name),'utf8'));
  if(name!==`.pdf-visual-${sha(pdfVisualCanonical(cache.identity))}.json`||!Array.isArray(cache.completed))throw new PdfVisualEvidenceError('invalid','PDF visual draft identity differs; collection must stop');
  if(!sources.some(source=>source.owner===cache.identity.owner&&source.id===cache.identity.documentId&&
    (source.source_hash===null||source.source_hash===cache.identity.sourceHash)))continue;
  for(const assets of cache.completed){if(!Array.isArray(assets))throw new PdfVisualEvidenceError('invalid','PDF visual draft is malformed');
   for(const asset of assets){if(!isSha(asset.sha256)||asset.provenance?.rawPdfSha256!==cache.identity.sourceHash)
    throw new PdfVisualEvidenceError('invalid','PDF visual draft source differs');hashes.push(asset.sha256,asset.provenance.pageRenderSha256);}}
 }
 return [...new Set(hashes.filter(isSha))];
}
