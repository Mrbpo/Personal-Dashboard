import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import type {Pool,PoolClient} from 'pg';
import type {DocumentTextHit} from './document-search.ts';

export type DocumentContextSource={documentId:string;currentVersionId:string;sourceVersionId:string;sourceHash:string;courseId?:string};
export type DocumentNodeKind='paragraph'|'abstract'|'caption'|'page';
export type DocumentStructureInput={rawSourceHash:string;parserVersion:string;
 parents:Array<{id:string;parentId?:string|null;heading:string}>;
 nodes:Array<{evidenceId:string;locator:string;ordinal:number;kind:DocumentNodeKind;parentId?:string|null;bodySha256:string}>};
export type DocumentEvidenceNode={documentId:string;documentVersionId:string;sourceVersionId:string;sourceHash:string;
 evidenceId:string;locator:string;ordinal:number;kind:DocumentNodeKind;parentId?:string|null;body:string;bodySha256:string};
export type DocumentImageProvenance={sourceUrl:string;revision:string;archiveSha256?:string;archiveMember?:string;license?:string;attribution?:string};
export type DocumentImageEvidence={attachmentId:string;assetId:string;captionEvidenceId:string;source:DocumentContextSource;
 mime:'image/png';sha256:string;byteLength:number;width:number;height:number;originalReference:string;
 provenance:DocumentImageProvenance;bytes:Uint8Array};
export type DocumentParentContext={parentId:string;kind:'section'|'single-node';
 source:DocumentContextSource;manifestSha256:string;firstAnchorRank:number;anchorRanks:number[];
 headingMetadata?:{text:string;originalSourceHash:string};status:'available'|'unavailable-size-exceeds-8192';
 sourceNodeCount:number;sourceBodyCodepoints:number;nodeManifest:Array<{evidenceId:string;locator:string;bodySha256:string}>;nodes:DocumentEvidenceNode[]};
export type DocumentContextRead={anchors:DocumentTextHit[];parents:DocumentParentContext[];images:DocumentImageEvidence[];
 accounting:{anchorCount:number;parentCount:number;contextNodeCount:number;contextBodyCodepoints:number;imageCount:number;imageBytes:number};
 sourceContentIsUntrusted:true};
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
 rawSourceHash:string;name:string;origin:string;originKey:string;parserVersion:string};
type PageRow={page_number:number;evidence_id:string;locator:string;body:string};
async function currentSource(db:Queryable,owner:string,source:DocumentContextSource,lock=false):Promise<SourceRow>{
 if(!bounded(owner)||!source||![source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash].every(value=>bounded(value)))
  invalid('Complete expected source identity is required');
 const result=await db.query<SourceRow>(`SELECT d.id "documentId",d.current_version_id "currentVersionId",
 v.source_version_id "sourceVersionId",d.source_hash "sourceHash",coalesce(d.course_id,'') "courseId",
 s.raw_sha256 "rawSourceHash",d.name,d.origin,d.origin_key "originKey",v.parser_version "parserVersion"
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
function validateStructure(input:DocumentStructureInput,current:SourceRow,pages:PageRow[]):void{
 if(!input||!isSha(input.rawSourceHash)||input.rawSourceHash!==current.rawSourceHash||input.rawSourceHash!==current.sourceHash
  ||!bounded(input.parserVersion,200)||!Array.isArray(input.parents)||!Array.isArray(input.nodes)
  ||input.parents.length>10000||input.nodes.length!==pages.length)invalid('Structure must cover the complete original source');
 if(Object.keys(input).some(key=>!['rawSourceHash','parserVersion','parents','nodes'].includes(key)))invalid('Unknown structure fields');
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
export async function registerDocumentStructure(db:Queryable,owner:string,source:DocumentContextSource,input:DocumentStructureInput){
 const current=await currentSource(db,owner,source,true),pages=await sourcePages(db,current);validateStructure(input,current,pages);
 const manifest=canonical(input),sha=hash(manifest);
 await db.query(`INSERT INTO document_structures(version_id,source_version_id,source_hash,raw_source_hash,parser_version,manifest_sha256,manifest)
 VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(version_id) DO NOTHING`,
 [current.currentVersionId,current.sourceVersionId,current.sourceHash,input.rawSourceHash,input.parserVersion,sha,manifest]);
 const existing=(await db.query<{manifest_sha256:string}>('SELECT manifest_sha256 FROM document_structures WHERE version_id=$1',[current.currentVersionId])).rows[0];
 if(existing?.manifest_sha256!==sha)throw new DocumentContextError('DOCUMENT_STRUCTURE_CONFLICT','Current source structure is immutable');
 await currentSource(db,owner,identity(current));return {source:identity(current),manifestSha256:sha};
}
async function structuredSource(db:Queryable,owner:string,source:DocumentContextSource){
 const current=await currentSource(db,owner,source),pages=await sourcePages(db,current);
 const record=(await db.query<{manifest:DocumentStructureInput;manifest_sha256:string;raw_source_hash:string}>(`SELECT manifest,manifest_sha256,raw_source_hash
 FROM document_structures WHERE version_id=$1 AND source_version_id=$2 AND source_hash=$3`,
 [current.currentVersionId,current.sourceVersionId,current.sourceHash])).rows[0];
 if(!record)throw new DocumentContextError('DOCUMENT_STRUCTURE_UNAVAILABLE','Current source has no verified hierarchy');
 if(hash(canonical(record.manifest))!==record.manifest_sha256||record.raw_source_hash!==record.manifest.rawSourceHash)changed();
 try{validateStructure(record.manifest,current,pages);}catch{changed();}
 return {current,structure:record.manifest,manifestSha256:record.manifest_sha256,nodes:pages.map((page,index)=>evidenceNode(current,page,record.manifest.nodes[index]))};
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
export async function registerDocumentImage(db:Queryable,owner:string,source:DocumentContextSource,input:{captionEvidenceId:string;
 originalReference:string;provenance:DocumentImageProvenance;bytes:Uint8Array}){
 const data=await structuredSource(db,owner,source),current=await currentSource(db,owner,identity(data.current),true);
 if(!data.nodes.some(node=>node.evidenceId===input.captionEvidenceId&&node.kind==='caption')||!bounded(input.originalReference)
  ||!bounded(input.provenance?.sourceUrl)||!bounded(input.provenance?.revision)||!/^https?:\/\//.test(input.provenance.sourceUrl)
  ||(input.provenance.archiveSha256&&!isSha(input.provenance.archiveSha256))||!(input.bytes instanceof Uint8Array)
  ||Object.keys(input.provenance).some(key=>!['sourceUrl','revision','archiveSha256','archiveMember','license','attribution'].includes(key))
  ||Object.values(input.provenance).some(value=>!bounded(value,4000)))invalid('Image requires a current caption and original-source provenance');
 const dimensions=pngDimensions(input.bytes),sha=hash(input.bytes),id=hash(canonical([current.currentVersionId,input.captionEvidenceId,sha,input.originalReference,input.provenance]));
 await mkdir(blobRoot(),{recursive:true,mode:0o700});
 try{await writeFile(resolve(blobRoot(),sha),input.bytes,{flag:'wx',mode:0o600});}
 catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
 if((await stat(resolve(blobRoot(),sha))).size!==input.bytes.length||hash(await readFile(resolve(blobRoot(),sha)))!==sha)
  throw new DocumentContextError('DOCUMENT_IMAGE_CHANGED','Original image blob hash differs');
 await db.query(`INSERT INTO document_image_attachments(id,version_id,source_version_id,source_hash,caption_evidence_id,asset_sha256,byte_length,width,height,mime,original_reference,provenance)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'image/png',$10,$11::jsonb) ON CONFLICT DO NOTHING`,
 [id,current.currentVersionId,current.sourceVersionId,current.sourceHash,input.captionEvidenceId,sha,input.bytes.length,
 dimensions.width,dimensions.height,input.originalReference,canonical(input.provenance)]);
 const stored=(await db.query<{id:string}>('SELECT id FROM document_image_attachments WHERE id=$1',[id])).rows[0];
 if(!stored)throw new DocumentContextError('DOCUMENT_STRUCTURE_CONFLICT','Image attachment provenance is immutable');
 await currentSource(db,owner,identity(current));return {attachmentId:id,assetId:sha,source:identity(current),...dimensions,byteLength:input.bytes.length};
}
type ImageRow={id:string;caption_evidence_id:string;asset_sha256:string;byte_length:number;width:number;height:number;
 mime:'image/png';original_reference:string;provenance:DocumentImageProvenance};
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
export async function readDocumentParents(db:Queryable,owner:string,anchors:DocumentTextHit[],options:{includeImages?:boolean}={}):Promise<DocumentContextRead>{
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
    sourceHash:anchor.source_hash,courseId:anchor.course_id});loaded.set(anchor.document_id,data);
  }
  const node=data.nodes.find(node=>node.evidenceId===anchor.evidence_id)??changed();
  if(node.sourceVersionId!==anchor.source_version_id||node.sourceHash!==anchor.source_hash||node.locator!==anchor.locator
   ||node.ordinal+1!==anchor.page_number||anchor.evidence_body!=='full-page'||anchor.body!==node.body
   ||anchor.id!==`pg:${node.documentVersionId}:${anchor.page_number}`||data.current.name!==anchor.name
   ||data.current.origin!==anchor.origin||data.current.originKey!==anchor.origin_key||data.current.courseId!==anchor.course_id
   ||data.current.parserVersion!==anchor.parser_version)changed();
  const parent=node.parentId?data.structure.parents.find(parent=>parent.id===node.parentId):undefined;
  const key=canonical([node.documentId,node.documentVersionId,parent?.id||node.evidenceId]);
  if(parents.has(key)){parents.get(key)!.anchorRanks.push(anchorIndex+1);continue;}
  const belongs=(candidate:DocumentEvidenceNode)=>{let next=candidate.parentId;while(next){if(next===parent?.id)return true;next=data!.structure.parents.find(row=>row.id===next)?.parentId;}return false;};
  const nodes=parent?data.nodes.filter(belongs):[node],points=nodes.reduce((sum,item)=>sum+Array.from(item.body).length,0);
  parents.set(key,{parentId:key,kind:parent?'section':'single-node',source:identity(data.current),manifestSha256:data.manifestSha256,
   firstAnchorRank:anchorIndex+1,anchorRanks:[anchorIndex+1],...(parent?{headingMetadata:{text:parent.heading,originalSourceHash:node.sourceHash}}:{}),
   status:points<=8192?'available':'unavailable-size-exceeds-8192',sourceNodeCount:nodes.length,sourceBodyCodepoints:points,
   nodeManifest:nodes.map(node=>({evidenceId:node.evidenceId,locator:node.locator,bodySha256:node.bodySha256})),nodes:points<=8192?nodes:[]});
 }
 const images:DocumentImageEvidence[]=[];
 if(options.includeImages)for(const data of loaded.values()){
  const captions=[...parents.values()].flatMap(parent=>parent.nodes).filter(node=>node.documentId===data.current.documentId&&node.kind==='caption').map(node=>node.evidenceId);
  if(captions.length)images.push(...await readDocumentImages(db,owner,identity(data.current),[...new Set(captions)]));
 }
 for(const data of loaded.values())await currentSource(db,owner,identity(data.current));
 const packets=[...parents.values()];return {anchors,parents:packets,images,accounting:{anchorCount:anchors.length,parentCount:packets.length,
  contextNodeCount:packets.reduce((sum,parent)=>sum+parent.nodes.length,0),contextBodyCodepoints:packets.reduce((sum,parent)=>sum+parent.nodes.reduce((n,node)=>n+Array.from(node.body).length,0),0),
  imageCount:images.length,imageBytes:images.reduce((sum,image)=>sum+image.byteLength,0)},sourceContentIsUntrusted:true};
}
