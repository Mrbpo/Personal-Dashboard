import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat,utimes} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import type {DocumentEvidenceHit} from './document-evidence.ts';
import {readDocumentNodes} from './document-nodes.ts';
import {readPdfVisualEvidence,PdfVisualEvidenceError,type PdfVisualImageEvidence} from './pdf-visual-evidence.ts';
import {createDocumentImageBudget,type DocumentImageBudget,type DocumentImageSelection} from './document-image-budget.ts';
import {assertDoclingMathProvenance,assertPreparedDoclingSourceMath,doclingMathForPage,
 type DoclingMathProvenance,type PreparedDoclingSourceMath} from './docling-source-math.ts';
import {doclingPageResultReferences,readDoclingPageRegions,doclingPageImageTransform,type DoclingRegionResultReference} from './docling-source-regions.ts';
import {DoclingPageRegionError,DOCLING_PAGE_REGION_LIMITS} from './docling-result.ts';

export type DocumentContextSource={documentId:string;currentVersionId:string;sourceVersionId:string;sourceHash:string;courseId?:string};
export type DocumentNodeKind='paragraph'|'abstract'|'caption'|'page';
export type DocumentStructureInput={rawSourceHash:string;parserVersion:string;
 parents:Array<{id:string;parentId?:string|null;heading:string}>;
 nodes:Array<{evidenceId:string;locator:string;ordinal:number;kind:DocumentNodeKind;parentId?:string|null;bodySha256:string}>;
 sourceMath?:DoclingMathProvenance};
export type DocumentEvidenceNode={documentId:string;documentVersionId:string;sourceVersionId:string;sourceHash:string;
 evidenceId:string;locator:string;ordinal:number;kind:DocumentNodeKind;parentId?:string|null;body:string;bodySha256:string;
 sourceMath?:ReturnType<typeof doclingMathForPage>};
export type DocumentImageProvenance={sourceUrl:string;revision:string;archiveSha256?:string;archiveMember?:string;license?:string;attribution?:string};
export type DocumentImageInput={captionEvidenceId:string;originalReference:string;provenance:DocumentImageProvenance;bytes:Uint8Array};
export type DocumentImageEvidence={attachmentId:string;assetId:string;captionEvidenceId:string;source:DocumentContextSource;
 mime:'image/png';sha256:string;byteLength:number;width:number;height:number;originalReference:string;
 provenance:DocumentImageProvenance;bytes:Uint8Array};
export type FlatTextStructureProvenance={method:'flat-persisted-text-v1';manifestSha256:string;
 originalHierarchyVerified:false;originalFileCompletenessVerified:false};
export type DocumentParentContext={parentId:string;kind:'section'|'single-node';
 source:DocumentContextSource;manifestSha256:string;firstAnchorRank:number;anchorRanks:number[];
 structureProvenance?:FlatTextStructureProvenance;
 headingMetadata?:{text:string;originalSourceHash:string};status:'available'|'unavailable-size-exceeds-8192';
 sourceNodeCount:number;sourceBodyCodepoints:number;nodeManifest:Array<{evidenceId:string;locator:string;bodySha256:string}>;nodes:DocumentEvidenceNode[]};
export type DocumentContextRead={anchors:DocumentEvidenceHit[];parents:DocumentParentContext[];images:Array<DocumentImageEvidence|PdfVisualImageEvidence>;
 imageSelection?:DocumentImageSelection;
 accounting:{anchorCount:number;parentCount:number;contextNodeCount:number;contextBodyCodepoints:number;imageCount:number;imageBytes:number};
 sourceContentIsUntrusted:true};
/** A separate whole-source reader; these limits do not change ranked readers. */
export const COMPLETE_DOCUMENT_SOURCE_LIMITS=Object.freeze({nodes:512,bodyCodepoints:131072,bodyUtf8Bytes:262144,
 images:64,imageBytes:32*1024*1024,imageInputTokens:65536,requestInputTokens:300000,framingTokens:16384});
export type CompleteDocumentSourceReason='source-size-limit'|'structure-unavailable'|
 'image-count-limit'|'image-byte-limit'|'image-input-limit'|'image-unavailable'|'image-ambiguous'|'request-input-limit';
export type CompleteDocumentSourceManifest={method:'complete-current-source';nodeOrder:'original-source';complete:boolean;
 reason:CompleteDocumentSourceReason|null;source:DocumentContextSource;sourceNodeCount:number;returnedNodeCount:number;
 sourceBodyCodepoints:number;sourceBodyUtf8Bytes:number;orderedTextSha256:string|null;structureManifestSha256:string|null;
 parserWarnings:string[];document:{name:string;origin:string;originKey:string;parserVersion:string};
 hierarchy:DocumentStructureInput['parents'];nodes:Array<Omit<DocumentEvidenceNode,'body'>>;
 images:Array<{attachmentId:string;captionEvidenceId?:string;anchorEvidenceId?:string;kind?:'pdf-page'|'pdf-region';physicalPage?:number;manifestSha256?:string;
  sha256:string;byteLength:number;width:number;height:number}>;
 pdfVisuals?:{manifestSha256:string|null;layoutStatus:'available'|'unavailable'};
 request?:{nonImageBodyUtf8Bytes:number;imageInputTokenUpper:number;inputTokenUpper:number;nonImageBodySha256:string};
 requestSchemaLimit?:'enum-count'|'enum-string';
 imageInputTokenUpper:number;limits:typeof COMPLETE_DOCUMENT_SOURCE_LIMITS;manifestSha256:string};
export type CompleteDocumentSourceRead={status:'unavailable';reason:CompleteDocumentSourceReason;manifest:CompleteDocumentSourceManifest}|
 {status:'available';context:DocumentContextRead;manifest:CompleteDocumentSourceManifest};
export type DocumentContextErrorCode='DOCUMENT_CONTEXT_INVALID'|'DOCUMENT_CONTEXT_CHANGED'|'DOCUMENT_STRUCTURE_UNAVAILABLE'|
 'DOCUMENT_STRUCTURE_CONFLICT'|'DOCUMENT_IMAGE_UNAVAILABLE'|'DOCUMENT_IMAGE_AMBIGUOUS'|'DOCUMENT_IMAGE_CHANGED';
export class DocumentContextError extends Error{
 readonly code:DocumentContextErrorCode;
 constructor(code:DocumentContextErrorCode,message:string){super(message);this.code=code;this.name='DocumentContextError';}
}
type Queryable=Pick<Pool,'query'>|Pick<PoolClient,'query'>;
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
 ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const invalid=(message:string):never=>{throw new DocumentContextError('DOCUMENT_CONTEXT_INVALID',message);};
const changed=():never=>{throw new DocumentContextError('DOCUMENT_CONTEXT_CHANGED','Document source or evidence is no longer current');};
const isSha=(value:string)=>/^[a-f0-9]{64}$/.test(value);
const bounded=(value:unknown,max=4000):value is string=>typeof value==='string'&&value.length>0&&value.length<=max;

type SourceRow={documentId:string;currentVersionId:string;sourceVersionId:string;sourceHash:string;courseId:string;
 rawSourceHash:string;name:string;origin:string;originKey:string;parserVersion:string;mime:string;extractionMethod:string|null};
type PageRow={page_number:number;evidence_id:string;locator:string;body:string};
async function currentSource(db:Queryable,owner:string,source:DocumentContextSource,lock=false):Promise<SourceRow>{
 if(!bounded(owner)||!source||![source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash].every(value=>bounded(value)))
  invalid('Complete expected source identity is required');
 const result=await db.query<SourceRow>(`SELECT d.id "documentId",d.current_version_id "currentVersionId",
 v.source_version_id "sourceVersionId",d.source_hash "sourceHash",coalesce(d.course_id,'') "courseId",
 s.raw_sha256 "rawSourceHash",d.name,d.origin,d.origin_key "originKey",v.parser_version "parserVersion",s.raw_value->>'mime' mime,
 s.raw_value->>'extractionMethod' "extractionMethod"
 FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
 JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
 WHERE d.owner_id=$1 AND d.id=$2 AND d.current_version_id=$3 AND v.source_version_id=$4 AND d.source_hash=$5
 AND NOT d.hidden AND ($6::text IS NULL OR coalesce(d.course_id,'')=$6)
 AND NOT EXISTS (SELECT 1 FROM document_texts newer WHERE newer.owner_id=d.owner_id AND newer.origin=d.origin
  AND newer.origin_key=d.origin_key AND NOT newer.hidden AND (newer.created_at>d.created_at
   OR (newer.created_at=d.created_at AND newer.id>d.id))) ${lock?'FOR UPDATE OF d':''}`,
 [owner,source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash,source.courseId??null]);
 if(result.rows.length!==1)changed();return result.rows[0];
}
const identity=(row:SourceRow):DocumentContextSource=>({documentId:row.documentId,currentVersionId:row.currentVersionId,
 sourceVersionId:row.sourceVersionId,sourceHash:row.sourceHash,courseId:row.courseId});
async function sourcePages(db:Queryable,row:SourceRow):Promise<PageRow[]>{
 const pages=(await db.query<PageRow>(`SELECT p.page_number,p.evidence_id,p.locator,p.body FROM document_text_pages p
 JOIN evidence e ON e.id=p.evidence_id JOIN document_texts d ON d.current_version_id=p.version_id
 WHERE d.id=$1 AND p.version_id=$2 AND e.source_version_id=$3 AND e.source_item_id=d.source_item_id
 ORDER BY p.page_number`,[row.documentId,row.currentVersionId,row.sourceVersionId])).rows;
 const count=(await db.query<{page_count:number}>('SELECT page_count FROM document_text_versions WHERE id=$1',[row.currentVersionId])).rows[0]?.page_count;
 if(!count||pages.length!==count||pages.some((page,index)=>page.page_number!==index+1))changed();return pages;
}
const evidenceNode=(source:SourceRow,page:PageRow,node?:DocumentStructureInput['nodes'][number]):DocumentEvidenceNode=>({
 documentId:source.documentId,documentVersionId:source.currentVersionId,sourceVersionId:source.sourceVersionId,sourceHash:source.sourceHash,
 evidenceId:page.evidence_id,locator:page.locator,ordinal:page.page_number-1,kind:node?.kind||'page',parentId:node?.parentId??null,
 body:page.body,bodySha256:hash(page.body)});

/** Adapter input, read through Kernel with full actual evidence identities. */
export async function readDocumentSourcePages(db:Queryable,owner:string,source:DocumentContextSource){
 const current=await currentSource(db,owner,source),pages=await sourcePages(db,current);
 await currentSource(db,owner,identity(current));
 return {source:identity(current),nodes:pages.map(page=>evidenceNode(current,page)),sourceContentIsUntrusted:true as const};
}

/** An explicit one-page observation reader. Existing bodies, quotation IDs,
 * ranked readers and complete-source contracts are not changed or upgraded. */
export async function readDocumentPageRegions(db:Queryable,owner:string,source:DocumentContextSource,physicalPage:number){
 source={...source};const current=await currentSource(db,owner,source);
 if(!Number.isInteger(physicalPage)||physicalPage<1)invalid('One explicit physical page is required');
 const pageCount=(await db.query<{page_count:number}>('SELECT page_count FROM document_text_versions WHERE id=$1',[current.currentVersionId])).rows[0]?.page_count??0;
 if(!Number.isInteger(pageCount)||pageCount<1||physicalPage>pageCount)invalid('Requested page is outside the current source');
 if(current.rawSourceHash!==current.sourceHash)changed();
 const readProgress=async()=>(await db.query<{batch_provenance:unknown}>(
  `SELECT raw_value->'batchProvenance' batch_provenance FROM source_item_versions WHERE id=$1`,[current.sourceVersionId])).rows[0]?.batch_provenance??null;
 const progress=await readProgress(),progressSha256=hash(canonical(progress));
 const finish=async()=>{await currentSource(db,owner,identity(current));if(hash(canonical(await readProgress()))!==progressSha256)changed();
  await currentSource(db,owner,identity(current));};
 const unavailable=async(reason:string,reference?:DoclingRegionResultReference)=>{
  await finish();return {status:'unavailable' as const,reason,source:identity(current),physicalPage,
   policy:'docling-source-page-regions-v1' as const,...(reference?{result:reference}:{}),sourceContentIsUntrusted:true as const};
 };
 if(current.mime!=='application/pdf')return unavailable('not-pdf');
 if(pageCount>DOCLING_PAGE_REGION_LIMITS.pages)return unavailable('source-page-count-limit');
 const page=(await db.query<PageRow>(`SELECT p.page_number,p.evidence_id,p.locator,p.body FROM document_text_pages p
 JOIN evidence e ON e.id=p.evidence_id JOIN document_texts d ON d.current_version_id=p.version_id
 WHERE d.id=$1 AND p.version_id=$2 AND e.source_version_id=$3 AND e.source_item_id=d.source_item_id AND p.page_number=$4`,
 [current.documentId,current.currentVersionId,current.sourceVersionId,physicalPage])).rows;
 if(page.length!==1||page[0].page_number!==physicalPage)changed();
 try{
  // Empty selection validates the saved layout/manifest without loading PNGs.
  const metadata=await readPdfVisualEvidence(db,owner,identity(current),[]);
  const refs=doclingPageResultReferences({owner,documentId:current.documentId,sourceHash:current.sourceHash,pageCount,physicalPage},progress,metadata.layout);
  if(!refs.length)return unavailable('saved-docling-result-unavailable');
  const reference=refs[0],index=await readDoclingPageRegions({owner,documentId:current.documentId,sourceHash:current.sourceHash,pageCount,physicalPage},reference);
  if(!metadata.registered||metadata.renderStatus!=='available')return unavailable('original-page-image-unavailable',reference);
  const visuals=await readPdfVisualEvidence(db,owner,identity(current),[page[0].evidence_id],undefined,{pageAssetsOnly:true});
  if(visuals.manifestSha256!==metadata.manifestSha256)changed();
  const images=visuals.images.filter(image=>image.kind==='pdf-page'&&image.physicalPage===physicalPage);
  if(images.length!==1)return unavailable('original-page-image-unavailable-or-ambiguous',reference);
  const {bytes:discarded,...image}=images[0];void discarded;
  const coordinateTransform=doclingPageImageTransform(index.pageSize,image);
  await finish();
  return {status:'available' as const,source:identity(current),physicalPage,pageEvidenceId:page[0].evidence_id,
   pageBodySha256:hash(page[0].body),parserVersion:current.parserVersion,progressSha256,
   visualManifestSha256:visuals.manifestSha256,image,coordinateTransform,index};
 }catch(error){
  if(error instanceof PdfVisualEvidenceError&&error.code==='source-changed')changed();
  if(error instanceof DoclingPageRegionError){
   if(error.code==='limit'||error.code==='unavailable')return unavailable(error.message);
   invalid(error.message);
  }
  if(error instanceof PdfVisualEvidenceError&&error.code==='unavailable')return unavailable(error.message);
  throw error;
 }
}
function validateStructure(input:DocumentStructureInput,current:SourceRow,pages:PageRow[]):void{
 if(!input||!isSha(input.rawSourceHash)||input.rawSourceHash!==current.rawSourceHash||input.rawSourceHash!==current.sourceHash
  ||!bounded(input.parserVersion,200)||!Array.isArray(input.parents)||!Array.isArray(input.nodes)
  ||input.parents.length>10000||input.nodes.length!==pages.length)invalid('Structure must cover the complete original source');
 if(Object.keys(input).some(key=>!['rawSourceHash','parserVersion','parents','nodes','sourceMath'].includes(key)))invalid('Unknown structure fields');
 if(input.sourceMath)assertDoclingMathProvenance(input.sourceMath,current.documentId,current.sourceHash,
  pages.map(page=>({pageNumber:page.page_number,body:page.body})));
 const parents=new Map(input.parents.map(parent=>[parent.id,parent]));
 if(parents.size!==input.parents.length)invalid('Parent IDs must be unique');
 for(const parent of input.parents){
  if(!bounded(parent.id,200)||typeof parent.heading!=='string'||parent.heading.length>4000
   ||Object.keys(parent).some(key=>!['id','parentId','heading'].includes(key)))invalid('Invalid original parent metadata');
  const visited=new Set<string>([parent.id]);let next=parent.parentId;
  while(next){if(visited.has(next)||!parents.has(next))invalid('Hierarchy contains a cycle or missing parent');visited.add(next);next=parents.get(next)!.parentId;}
 }
 const ids=new Set<string>();
 for(const [index,node] of input.nodes.entries()){
  const page=pages[index];
  if(node.ordinal!==index||node.evidenceId!==page.evidence_id||node.locator!==page.locator||node.bodySha256!==hash(page.body)
   ||Object.keys(node).some(key=>!['evidenceId','locator','ordinal','kind','parentId','bodySha256'].includes(key))
   ||!['paragraph','abstract','caption','page'].includes(node.kind)||ids.has(node.evidenceId)
   ||(node.parentId&&!parents.has(node.parentId))||((node.kind==='caption'||node.kind==='abstract')&&node.parentId))
   invalid('Structure node differs from current original evidence');
  ids.add(node.evidenceId);
 }
}
export async function registerDocumentStructure(db:Queryable,owner:string,source:DocumentContextSource,input:DocumentStructureInput,sourceMath?:PreparedDoclingSourceMath){
 const current=await currentSource(db,owner,source,true),pages=await sourcePages(db,current);validateStructure(input,current,pages);
 if(input.sourceMath){
  if(!sourceMath||canonical(sourceMath.provenance)!==canonical(input.sourceMath))invalid('Source math requires verified raw staging');
  assertPreparedDoclingSourceMath(sourceMath!,owner,current.documentId,current.sourceHash,pages.map(page=>({pageNumber:page.page_number,text:page.body})));
 }
 const manifest=canonical(input),sha=hash(manifest);
 await db.query(`INSERT INTO document_structures(version_id,source_version_id,source_hash,raw_source_hash,parser_version,manifest_sha256,manifest)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(version_id) DO NOTHING`,
 [current.currentVersionId,current.sourceVersionId,current.sourceHash,input.rawSourceHash,input.parserVersion,sha,manifest]);
 const existing=(await db.query<{manifest_sha256:string}>('SELECT manifest_sha256 FROM document_structures WHERE version_id=$1',[current.currentVersionId])).rows[0];
 if(existing?.manifest_sha256!==sha)throw new DocumentContextError('DOCUMENT_STRUCTURE_CONFLICT','Current source structure is immutable');
 await currentSource(db,owner,identity(current));return {source:identity(current),manifestSha256:sha};
}
async function structuredSource(db:Queryable,owner:string,source:DocumentContextSource,allowFlatPersistedText=false){
 const current=await currentSource(db,owner,source),pages=await sourcePages(db,current);
 const record=(await db.query<{manifest:DocumentStructureInput;manifest_sha256:string;raw_source_hash:string}>(`SELECT manifest,manifest_sha256,raw_source_hash
 FROM document_structures WHERE version_id=$1 AND source_version_id=$2 AND source_hash=$3`,
 [current.currentVersionId,current.sourceVersionId,current.sourceHash])).rows[0];
 const declaration=`${current.parserVersion} ${current.extractionMethod??''}`;
 const flat=!record&&allowFlatPersistedText&&current.mime==='text/plain'&&
  /(?:^|[^a-z])(?:text|plain|plaintext|json)(?:[^a-z]|$)/iu.test(declaration)&&
  !/pdf|docling|ocr|vision|visual|formula|layout/iu.test(declaration);
 if(!record&&!flat)throw new DocumentContextError('DOCUMENT_STRUCTURE_UNAVAILABLE','Current source has no verified hierarchy');
 if(record&&(hash(canonical(record.manifest))!==record.manifest_sha256||record.raw_source_hash!==record.manifest.rawSourceHash))changed();
 // A flat manifest describes only current persisted text nodes, never author
 // sections, geometry or complete original-file extraction. It is not stored.
 const structure:DocumentStructureInput=record?.manifest??{rawSourceHash:current.rawSourceHash,parserVersion:'flat-persisted-text-v1',parents:[],
  nodes:pages.map((page,index)=>({evidenceId:page.evidence_id,locator:page.locator,ordinal:index,kind:'paragraph',bodySha256:hash(page.body)}))};
 try{validateStructure(structure,current,pages);}catch{changed();}
 const manifestSha256=record?.manifest_sha256??hash(canonical(structure));
 const structureProvenance:FlatTextStructureProvenance|undefined=flat?{method:'flat-persisted-text-v1',manifestSha256,
  originalHierarchyVerified:false,originalFileCompletenessVerified:false}:undefined;
 return {current,structure,manifestSha256,structureProvenance,nodes:pages.map((page,index)=>({...evidenceNode(current,page,structure.nodes[index]),
  ...(structure.sourceMath?{sourceMath:doclingMathForPage(structure.sourceMath,page.page_number)}:{})}))};
}
export async function readDocumentOutline(db:Queryable,owner:string,source:DocumentContextSource){
 const data=await structuredSource(db,owner,source);await currentSource(db,owner,identity(data.current));
 return {source:identity(data.current),manifestSha256:data.manifestSha256,parents:data.structure.parents,
  nodes:data.nodes.map(({body,...node})=>({...node,bodyCodepoints:Array.from(body).length,...(node.kind==='caption'?{caption:body}:{})})),
  sourceContentIsUntrusted:true as const};
}
const blobRoot=()=>resolve(/* turbopackIgnore: true */ process.env.LIBRARY_DIR||'./data/library');
const pngDimensions=(bytes:Uint8Array)=>{
 const data=Buffer.from(bytes);
 if(data.length<33||data.length>50*1024*1024||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
  ||data.toString('ascii',12,16)!=='IHDR'||data.readUInt32BE(8)!==13)invalid('A bounded original PNG is required');
 const width=data.readUInt32BE(16),height=data.readUInt32BE(20);
 if(!width||!height||width>100000||height>100000)invalid('Invalid original PNG dimensions');return {width,height};
};
type PreparedDocumentImage={owner:string;source:DocumentContextSource;manifestSha256:string;captionEvidenceId:string;
 captionBodySha256:string;originalReference:string;provenance:DocumentImageProvenance;sha256:string;attachmentId:string;
 byteLength:number;width:number;height:number};
const preparedImages=new WeakSet<PreparedDocumentImage>();
/** Validate and retain immutable image bytes without a transaction or row lock. */
export async function prepareDocumentImage(db:Queryable,owner:string,source:DocumentContextSource,input:DocumentImageInput){
 const data=await structuredSource(db,owner,source),current=data.current;
 if(!data.nodes.some(node=>node.evidenceId===input.captionEvidenceId&&node.kind==='caption')||!bounded(input.originalReference)
  ||!bounded(input.provenance?.sourceUrl)||!bounded(input.provenance?.revision)||!/^https?:\/\//.test(input.provenance.sourceUrl)
  ||(input.provenance.archiveSha256&&!isSha(input.provenance.archiveSha256))||!(input.bytes instanceof Uint8Array)
  ||Object.keys(input.provenance).some(key=>!['sourceUrl','revision','archiveSha256','archiveMember','license','attribution'].includes(key))
  ||Object.values(input.provenance).some(value=>!bounded(value,4000)))invalid('Image requires a current caption and original-source provenance');
 const bytes=Buffer.from(input.bytes),provenance=Object.freeze({...input.provenance}),captionEvidenceId=input.captionEvidenceId,
  originalReference=input.originalReference,dimensions=pngDimensions(bytes),sha=hash(bytes),
  id=hash(canonical([current.currentVersionId,captionEvidenceId,sha,originalReference,provenance]));
 await mkdir(blobRoot(),{recursive:true,mode:0o700});
 try{await writeFile(resolve(blobRoot(),sha),bytes,{flag:'wx',mode:0o600});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 if((await stat(resolve(blobRoot(),sha))).size!==bytes.length||hash(await readFile(resolve(blobRoot(),sha)))!==sha)
  throw new DocumentContextError('DOCUMENT_IMAGE_CHANGED','Original image blob hash differs');
 // Reusing an uncommitted old hash must retain the existing GC upload grace.
 await utimes(resolve(blobRoot(),sha),new Date(),new Date());
 await currentSource(db,owner,identity(current));
 const prepared=Object.freeze({owner,source:Object.freeze(identity(current)),manifestSha256:data.manifestSha256,
  captionEvidenceId,captionBodySha256:data.nodes.find(node=>node.evidenceId===captionEvidenceId)!.bodySha256,
  originalReference,provenance,sha256:sha,attachmentId:id,byteLength:bytes.length,...dimensions});
 preparedImages.add(prepared);return prepared;
}
/** Called only in Kernel's short metadata transaction after prepare has completed. */
export async function commitDocumentImage(db:Queryable,owner:string,prepared:PreparedDocumentImage){
 if(!preparedImages.has(prepared)||prepared.owner!==owner)invalid('Image has no verified staging receipt');
 const current=await currentSource(db,owner,prepared.source,true),data=await structuredSource(db,owner,identity(current));
 if(data.manifestSha256!==prepared.manifestSha256||!data.nodes.some(node=>node.evidenceId===prepared.captionEvidenceId
  &&node.kind==='caption'&&node.bodySha256===prepared.captionBodySha256))changed();
 await db.query(`INSERT INTO document_image_attachments(id,version_id,source_version_id,source_hash,caption_evidence_id,asset_sha256,byte_length,width,height,mime,original_reference,provenance)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'image/png',$10,$11::jsonb) ON CONFLICT DO NOTHING`,
 [prepared.attachmentId,current.currentVersionId,current.sourceVersionId,current.sourceHash,prepared.captionEvidenceId,
 prepared.sha256,prepared.byteLength,prepared.width,prepared.height,prepared.originalReference,canonical(prepared.provenance)]);
 const stored=(await db.query<{id:string}>('SELECT id FROM document_image_attachments WHERE id=$1',[prepared.attachmentId])).rows[0];
 if(!stored)throw new DocumentContextError('DOCUMENT_STRUCTURE_CONFLICT','Image attachment provenance is immutable');
 await currentSource(db,owner,identity(current));return {attachmentId:prepared.attachmentId,assetId:prepared.sha256,
  source:identity(current),width:prepared.width,height:prepared.height,byteLength:prepared.byteLength};
}
type ImageRow={id:string;caption_evidence_id:string;asset_sha256:string;byte_length:number;width:number;height:number;
 mime:'image/png';original_reference:string;provenance:DocumentImageProvenance};
/** Maintenance-only reference set, including hidden sources and historical versions. */
export async function documentImageBlobHashes(db:Queryable):Promise<string[]>{
 return (await db.query<{asset_sha256:string}>('SELECT DISTINCT asset_sha256 FROM document_image_attachments')).rows.map(row=>row.asset_sha256);
}
export async function readDocumentImages(db:Queryable,owner:string,source:DocumentContextSource,captionEvidenceIds:string[]):Promise<DocumentImageEvidence[]>{
 if(!Array.isArray(captionEvidenceIds)||captionEvidenceIds.length>14||new Set(captionEvidenceIds).size!==captionEvidenceIds.length)invalid('At most 14 distinct current caption references are allowed');
 const data=await structuredSource(db,owner,source),current=data.current;
 if(captionEvidenceIds.some(id=>!data.nodes.some(node=>node.evidenceId===id&&node.kind==='caption')))changed();
 const rows=(await db.query<ImageRow>(`SELECT a.id,a.caption_evidence_id,a.asset_sha256,a.byte_length,a.width,a.height,a.mime,a.original_reference,a.provenance
 FROM document_image_attachments a JOIN document_text_pages p ON p.version_id=a.version_id AND p.evidence_id=a.caption_evidence_id
 JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=a.source_version_id
 WHERE a.version_id=$1 AND a.source_version_id=$2 AND a.source_hash=$3 AND a.caption_evidence_id=ANY($4::text[])`,
 [current.currentVersionId,current.sourceVersionId,current.sourceHash,captionEvidenceIds])).rows;
 const images:DocumentImageEvidence[]=[];
 for(const caption of captionEvidenceIds){
  const matches=rows.filter(row=>row.caption_evidence_id===caption);
  if(!matches.length)throw new DocumentContextError('DOCUMENT_IMAGE_UNAVAILABLE','Current caption has no original image attachment');
  if(matches.length!==1)throw new DocumentContextError('DOCUMENT_IMAGE_AMBIGUOUS','Current caption has multiple original image attachments');
  const row=matches[0];let bytes:Buffer;
  try{const size=(await stat(resolve(blobRoot(),row.asset_sha256))).size;
   if(size!==row.byte_length||size>50*1024*1024)throw new Error('size');bytes=await readFile(resolve(blobRoot(),row.asset_sha256));}
  catch{throw new DocumentContextError('DOCUMENT_IMAGE_UNAVAILABLE','Original image bytes are unavailable');}
  if(hash(bytes)!==row.asset_sha256||bytes.length!==row.byte_length)
   throw new DocumentContextError('DOCUMENT_IMAGE_CHANGED','Original image bytes differ');
  const dimensions=pngDimensions(bytes);
  if(dimensions.width!==row.width||dimensions.height!==row.height)
   throw new DocumentContextError('DOCUMENT_IMAGE_CHANGED','Original image bytes or dimensions differ');
  images.push({attachmentId:row.id,assetId:row.asset_sha256,captionEvidenceId:caption,source:identity(current),mime:row.mime,
   sha256:row.asset_sha256,byteLength:row.byte_length,width:row.width,height:row.height,originalReference:row.original_reference,provenance:row.provenance,bytes});
 }
 await currentSource(db,owner,identity(current));return images;
}
export async function readDocumentParents(db:Queryable,owner:string,anchors:DocumentEvidenceHit[],options:{includeImages?:boolean}={},
 imageBudget?:DocumentImageBudget):Promise<DocumentContextRead>{
 if(!Array.isArray(anchors)||anchors.length>14||Object.keys(options).some(key=>key!=='includeImages')
  ||(options.includeImages!==undefined&&typeof options.includeImages!=='boolean'))invalid('At most 14 original ranked anchors are allowed');
 const loaded=new Map<string,Awaited<ReturnType<typeof structuredSource>>>(),parents=new Map<string,DocumentParentContext>();
 for(const [anchorIndex,anchor] of anchors.entries()){
  let data=loaded.get(anchor.document_id);
  if(!data){
   // Resolve the document version from the actual current source/evidence chain;
   // the caller cannot substitute a version or invent hierarchy membership.
   const version=(await db.query<{version_id:string}>(`SELECT v.id version_id FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
    WHERE d.id=$1 AND d.owner_id=$2 AND v.source_version_id=$3 AND d.source_hash=$4`,
    [anchor.document_id,owner,anchor.source_version_id,anchor.source_hash])).rows[0]?.version_id;
   if(!version)changed();
   data=await structuredSource(db,owner,{documentId:anchor.document_id,currentVersionId:version,sourceVersionId:anchor.source_version_id,
    sourceHash:anchor.source_hash,courseId:anchor.course_id},true);loaded.set(anchor.document_id,data);
  }
  const node=data.nodes.find(node=>node.evidenceId===anchor.evidence_id)??changed();
  if(node.sourceVersionId!==anchor.source_version_id||node.sourceHash!==anchor.source_hash||node.locator!==anchor.locator
   ||node.ordinal+1!==anchor.page_number||anchor.evidence_body!=='full-page'||anchor.body!==node.body
   ||anchor.id!==`pg:${node.documentVersionId}:${anchor.page_number}`||data.current.name!==anchor.name
   ||data.current.origin!==anchor.origin||data.current.originKey!==anchor.origin_key||data.current.courseId!==anchor.course_id
   ||data.current.parserVersion!==anchor.parser_version)changed();
  const parent=node.parentId?data.structure.parents.find(parent=>parent.id===node.parentId):undefined;
  const key=canonical([node.documentId,node.documentVersionId,parent?'section':'single-node',parent?.id||node.evidenceId]);
  if(parents.has(key)){parents.get(key)!.anchorRanks.push(anchorIndex+1);continue;}
  const belongs=(candidate:DocumentEvidenceNode)=>{let next=candidate.parentId;while(next){if(next===parent?.id)return true;next=data!.structure.parents.find(row=>row.id===next)?.parentId;}return false;};
  const nodes=parent?data.nodes.filter(belongs):[node],points=nodes.reduce((sum,item)=>sum+Array.from(item.body).length,0);
  parents.set(key,{parentId:key,kind:parent?'section':'single-node',source:identity(data.current),manifestSha256:data.manifestSha256,
   ...(data.structureProvenance?{structureProvenance:data.structureProvenance}:{}),
   firstAnchorRank:anchorIndex+1,anchorRanks:[anchorIndex+1],...(parent?{headingMetadata:{text:parent.heading,originalSourceHash:node.sourceHash}}:{}),
   status:points<=8192?'available':'unavailable-size-exceeds-8192',sourceNodeCount:nodes.length,sourceBodyCodepoints:points,
   nodeManifest:nodes.map(node=>({evidenceId:node.evidenceId,locator:node.locator,bodySha256:node.bodySha256})),nodes:points<=8192?nodes:[]});
 }
 const images:Array<DocumentImageEvidence|PdfVisualImageEvidence>=[],budget=options.includeImages?(imageBudget??createDocumentImageBudget()):undefined;
 if(budget)for(const [index,anchor] of anchors.entries()){
  const data=loaded.get(anchor.document_id)!,rank=index+1;
  const captions=[...parents.values()].filter(parent=>parent.firstAnchorRank===rank).flatMap(parent=>parent.nodes)
   .filter(node=>node.kind==='caption').map(node=>node.evidenceId);
  for(const caption of new Set(captions))for(const image of await readDocumentImages(db,owner,identity(data.current),[caption]))
   if(budget.include(image,rank)&&!images.some(value=>value.attachmentId===image.attachmentId))images.push(image);
  const pageAnchors=data.nodes.filter(node=>node.kind==='page'&&anchor.evidence_id===node.evidenceId).map(node=>node.evidenceId);
  if(pageAnchors.length&&data.current.mime==='application/pdf')try{const visuals=await readPdfVisualEvidence(db,owner,identity(data.current),pageAnchors,
   undefined,{selection:{budget,anchorRank:rank}});
   if(visuals.registered&&visuals.renderStatus!=='available')throw new PdfVisualEvidenceError('unavailable','Current PDF page images unavailable');
   for(const image of visuals.images)if(!images.some(value=>value.attachmentId===image.attachmentId))images.push(image);
  }catch(error){if(error instanceof PdfVisualEvidenceError&&error.code==='source-changed')changed();throw error;}
 }
 for(const data of loaded.values())await currentSource(db,owner,identity(data.current));
 const packets=[...parents.values()];return {anchors,parents:packets,images,...(budget?{imageSelection:budget.snapshot()}:{}),accounting:{anchorCount:anchors.length,parentCount:packets.length,
  contextNodeCount:packets.reduce((sum,parent)=>sum+parent.nodes.length,0),contextBodyCodepoints:packets.reduce((sum,parent)=>sum+parent.nodes.reduce((n,node)=>n+Array.from(node.body).length,0),0),
  imageCount:images.length,imageBytes:images.reduce((sum,image)=>sum+image.byteLength,0)},sourceContentIsUntrusted:true};
}

/** Complete original body/caption coverage or an honest unavailable result.
 * No ranking, truncation, OCR, model call, or fallback selection takes place. */
export async function readCompleteDocumentSource(pool:Pool,owner:string,expected:DocumentContextSource):Promise<CompleteDocumentSourceRead>{
 const source={...expected},current=await currentSource(pool,owner,source),limits=COMPLETE_DOCUMENT_SOURCE_LIMITS;
 // Count in PG before materializing a potentially large source or any PNG.
 const totals=(await pool.query<{nodes:number;points:string;bytes:string;warnings:string[]}>(`SELECT count(*)::int nodes,
  coalesce(sum(length(p.body)),0)::text points,coalesce(sum(octet_length(p.body)),0)::text bytes,
  (SELECT warnings FROM document_text_versions WHERE id=$1) warnings FROM document_text_pages p WHERE p.version_id=$1`,
 [current.currentVersionId])).rows[0];
 const manifest:Omit<CompleteDocumentSourceManifest,'manifestSha256'>={method:'complete-current-source',nodeOrder:'original-source',complete:false,reason:null,
  source:identity(current),sourceNodeCount:totals.nodes,returnedNodeCount:0,sourceBodyCodepoints:Number(totals.points),sourceBodyUtf8Bytes:Number(totals.bytes),
  orderedTextSha256:null,structureManifestSha256:null,parserWarnings:totals.warnings,
  document:{name:current.name,origin:current.origin,originKey:current.originKey,parserVersion:current.parserVersion},
  hierarchy:[],nodes:[],images:[],imageInputTokenUpper:0,limits};
 const finish=(complete:boolean,reason:CompleteDocumentSourceReason|null)=>{
  const value={...manifest,complete,reason,returnedNodeCount:complete?manifest.sourceNodeCount:0};
  return {...value,manifestSha256:hash(canonical(value))};
 };
 const unavailable=async(reason:CompleteDocumentSourceReason):Promise<CompleteDocumentSourceRead>=>{
  await currentSource(pool,owner,source);return {status:'unavailable',reason,manifest:finish(false,reason)};
 };
 if(!manifest.sourceNodeCount||![manifest.sourceBodyCodepoints,manifest.sourceBodyUtf8Bytes].every(Number.isSafeInteger)||
  manifest.sourceNodeCount>limits.nodes||manifest.sourceBodyCodepoints>limits.bodyCodepoints||manifest.sourceBodyUtf8Bytes>limits.bodyUtf8Bytes)
  return unavailable('source-size-limit');
 if(current.mime==='application/pdf'&&!(await pool.query(`SELECT version_id FROM document_pdf_visual_manifests
  WHERE version_id=$1 AND source_version_id=$2 AND source_hash=$3`,[source.currentVersionId,source.sourceVersionId,source.sourceHash])).rows.length)
  return unavailable('image-unavailable');
 let data:Awaited<ReturnType<typeof structuredSource>>;
 try{data=await structuredSource(pool,owner,source);}
 catch(error){if(error instanceof DocumentContextError&&error.code==='DOCUMENT_STRUCTURE_UNAVAILABLE')return unavailable('structure-unavailable');throw error;}
 if(data.nodes.length!==manifest.sourceNodeCount||data.nodes.reduce((sum,n)=>sum+Array.from(n.body).length,0)!==manifest.sourceBodyCodepoints||
  data.nodes.reduce((sum,n)=>sum+Buffer.byteLength(n.body),0)!==manifest.sourceBodyUtf8Bytes)changed();
 manifest.orderedTextSha256=hash(canonical(data.nodes.map(n=>n.body)));manifest.structureManifestSha256=data.manifestSha256;
 manifest.hierarchy=data.structure.parents;manifest.nodes=data.nodes.map(({body,...node})=>node);
 const captions=data.nodes.filter(n=>n.kind==='caption');
 if(captions.length>limits.images)return unavailable('image-count-limit');
 // A caption alone cannot stand in for its table/figure. Page renders without
 // a registered current original caption are never substituted here.
 const imageRows=(await pool.query<ImageRow>(`SELECT id,caption_evidence_id,asset_sha256,byte_length,width,height,mime,original_reference,provenance
  FROM document_image_attachments WHERE version_id=$1 AND source_version_id=$2 AND source_hash=$3 AND caption_evidence_id=ANY($4::text[])`,
 [current.currentVersionId,current.sourceVersionId,current.sourceHash,captions.map(n=>n.evidenceId)])).rows;
 let pdfImages:PdfVisualImageEvidence[]=[];
 if(current.mime==='application/pdf')try{const visual=await readPdfVisualEvidence(pool,owner,source);pdfImages=visual.images;
  if(!visual.registered)return unavailable('image-unavailable');
  if(visual.registered&&visual.renderStatus!=='available')return unavailable('image-unavailable');
  if(visual.registered)manifest.pdfVisuals={manifestSha256:visual.manifestSha256,layoutStatus:visual.layoutStatus};
 }catch(error){if(error instanceof PdfVisualEvidenceError){
   if(error.code==='source-changed')changed();
   if(error.code==='count-limit')return unavailable('image-count-limit');
   if(error.code==='byte-limit')return unavailable('image-byte-limit');
   if(error.code==='input-limit')return unavailable('image-input-limit');
   if(error.code==='unavailable')return unavailable('image-unavailable');
  }throw error;}
 if(imageRows.length+pdfImages.length>limits.images)return unavailable('image-count-limit');
 for(const caption of captions){const count=imageRows.filter(row=>row.caption_evidence_id===caption.evidenceId).length;
  if(!count)return unavailable('image-unavailable');if(count!==1)return unavailable('image-ambiguous');}
 if(imageRows.reduce((sum,row)=>sum+Number(row.byte_length),0)+pdfImages.reduce((sum,image)=>sum+image.byteLength,0)>limits.imageBytes)return unavailable('image-byte-limit');
 const imageTokens=(width:number,height:number)=>Math.ceil(width/32)*Math.ceil(height/32)*2+1;
 if(imageRows.some(row=>row.mime!=='image/png'||![row.width,row.height,row.byte_length].every(n=>Number.isSafeInteger(n)&&n>0)))changed();
 manifest.imageInputTokenUpper=imageRows.reduce((sum,row)=>sum+imageTokens(row.width,row.height),0)+pdfImages.reduce((sum,image)=>sum+imageTokens(image.width,image.height),0);
 if(manifest.imageInputTokenUpper>limits.imageInputTokens)return unavailable('image-input-limit');
 const anchors:DocumentEvidenceHit[]=[],parents=new Map<string,DocumentParentContext>(),images=new Map<string,DocumentImageEvidence|PdfVisualImageEvidence>();
 for(let offset=0;offset<data.nodes.length;offset+=14){
  const selected=await readDocumentNodes(pool,owner,source,data.nodes.slice(offset,offset+14).map(n=>n.evidenceId));
  const packet=await readDocumentParents(pool,owner,selected);anchors.push(...packet.anchors);
  for(const parent of packet.parents){
   const ranks=parent.anchorRanks.map(rank=>offset+rank),prior=parents.get(parent.parentId);
   if(prior)prior.anchorRanks.push(...ranks);else parents.set(parent.parentId,{...parent,firstAnchorRank:offset+parent.firstAnchorRank,anchorRanks:ranks});
  }
 }
 // Include every real original heading, including ancestor/empty sections that
 // have no directly anchored node. Body coverage already comes from anchors.
 const completeParents=data.structure.parents.map(parent=>{
  const key=canonical([current.documentId,current.currentVersionId,'section',parent.id]),existing=parents.get(key);
  if(existing)return existing;
  const nodes=data.nodes.filter(node=>{let next=node.parentId;while(next){if(next===parent.id)return true;
   next=data.structure.parents.find(row=>row.id===next)?.parentId;}return false;});
  const points=nodes.reduce((sum,node)=>sum+Array.from(node.body).length,0),ranks=nodes.map(node=>node.ordinal+1);
  return {parentId:key,kind:'section' as const,source:identity(current),manifestSha256:data.manifestSha256,
   firstAnchorRank:ranks[0]??0,anchorRanks:ranks,headingMetadata:{text:parent.heading,originalSourceHash:current.sourceHash},
   status:points<=8192?'available' as const:'unavailable-size-exceeds-8192' as const,sourceNodeCount:nodes.length,
   sourceBodyCodepoints:points,nodeManifest:nodes.map(node=>({evidenceId:node.evidenceId,locator:node.locator,bodySha256:node.bodySha256})),
   nodes:points<=8192?nodes:[]};
 });
 completeParents.push(...[...parents.values()].filter(parent=>parent.kind==='single-node'));
 // Images follow all original caption nodes independently of parent expansion.
 // An oversized parent packet has no nodes, but every original body remains in
 // anchors; neither that status nor a long caption can hide a required PNG.
 try{for(let offset=0;offset<captions.length;offset+=14)
  for(const image of await readDocumentImages(pool,owner,source,captions.slice(offset,offset+14).map(n=>n.evidenceId)))images.set(image.attachmentId,image);
 }catch(error){if(error instanceof DocumentContextError){
  if(error.code==='DOCUMENT_IMAGE_UNAVAILABLE')return unavailable('image-unavailable');
  if(error.code==='DOCUMENT_IMAGE_AMBIGUOUS')return unavailable('image-ambiguous');
 }throw error;}
 for(const image of pdfImages)images.set(image.attachmentId,image);
 const actualImages=[...images.values()];
 if(anchors.length!==data.nodes.length||anchors.some((hit,index)=>hit.evidence_id!==data.nodes[index].evidenceId||hit.body!==data.nodes[index].body)||
  actualImages.length!==captions.length+pdfImages.length)changed();
 // Check actual verified bytes/dimensions again, not only PG's size metadata.
 if(actualImages.reduce((sum,image)=>sum+image.byteLength,0)>limits.imageBytes)return unavailable('image-byte-limit');
 manifest.imageInputTokenUpper=actualImages.reduce((sum,image)=>sum+imageTokens(image.width,image.height),0);
 if(manifest.imageInputTokenUpper>limits.imageInputTokens)return unavailable('image-input-limit');
 manifest.images=actualImages.map(image=>({attachmentId:image.attachmentId,sha256:image.sha256,byteLength:image.byteLength,width:image.width,height:image.height,
  ...('anchorEvidenceId' in image?{kind:image.kind,anchorEvidenceId:image.anchorEvidenceId,physicalPage:image.physicalPage,manifestSha256:image.manifestSha256}:
    {captionEvidenceId:image.captionEvidenceId})}));
 manifest.parserWarnings=[...new Set(anchors.flatMap(hit=>hit.parser_warnings??[]))];
 await currentSource(pool,owner,source);
 const context:DocumentContextRead={anchors,parents:completeParents,images:actualImages,sourceContentIsUntrusted:true,
  accounting:{anchorCount:anchors.length,parentCount:completeParents.length,contextNodeCount:data.nodes.length,contextBodyCodepoints:manifest.sourceBodyCodepoints,
   imageCount:actualImages.length,imageBytes:actualImages.reduce((sum,image)=>sum+image.byteLength,0)}};
 return {status:'available',context,manifest:finish(true,null)};
}
