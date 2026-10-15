import {createHash} from 'node:crypto';
import type {DocumentImageBudget} from './document-image-budget.ts';
import type {Pool,PoolClient} from 'pg';
import {readBlob} from '../library.ts';
import type {DoclingNativeTable} from './docling-result.ts';
import {decodeDoclingResult} from './docling-result.ts';
import type {DocumentContextSource} from './document-context.ts';
import {documentSearchText,documentSearchTerms} from './document-search.ts';
import {readDocumentNodes} from './document-nodes.ts';
import type {PdfVisualImageEvidence} from './pdf-visual-evidence.ts';
import {DocumentEvidenceChangedError,type DocumentSelectedNodeHit} from './document-evidence.ts';

export const NATIVE_TABLE_PRODUCER='docling-native-table-v1';
export const NATIVE_TABLE_NAMESPACE='table-derived-search-v1';
export const NATIVE_TABLE_LIMITS=Object.freeze({tables:512,cells:10000,rows:1000,columns:200,bodyBytes:2*1024*1024,supplementalPages:2});
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
 ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const object=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
const isSha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const positive=(value:unknown,max:number):value is number=>Number.isSafeInteger(value)&&(value as number)>0&&(value as number)<=max;

export type NativeTableArtifact={namespace:typeof NATIVE_TABLE_NAMESPACE;producer:typeof NATIVE_TABLE_PRODUCER;schema:1;
 status:'available'|'unavailable';reasons:string[];native:DoclingNativeTable;artifactSha256:string};

/** No inferred cells, header flags, spans, numeric conversions, or totals. A
 * sparse/unsupported native grid remains archived but is not a search source. */
export function prepareNativeTableArtifact(table:DoclingNativeTable):NativeTableArtifact{
 const native=structuredClone(table),reasons:string[]=[],data=object(native.raw.data),cells=data?.table_cells;
 if(!/^#\/tables\/\d+$/.test(native.reference))reasons.push('invalid-table-reference');
 if(native.pageNumbers.length!==1||!positive(native.pageNumbers[0],500))reasons.push('ambiguous-physical-page');
 if(!native.result||![native.result.resultBlobSha256,native.result.derivedInputSha256,native.result.optionsHash].every(isSha)||
  !Array.isArray(native.result.copyIndices)||!native.result.copyIndices.length||native.result.copyIndices.length>500||
  native.result.copyIndices.some((page,i,all)=>!Number.isSafeInteger(page)||page<0||(i>0&&page!==all[i-1]+1))||
  native.pageNumbers.some(page=>!native.result!.copyIndices.includes(page-1)))reasons.push('raw-result-identity-unavailable');
 if(!data||!positive(data.num_rows,NATIVE_TABLE_LIMITS.rows)||!positive(data.num_cols,NATIVE_TABLE_LIMITS.columns)||
  !Array.isArray(cells)||!cells.length||cells.length>NATIVE_TABLE_LIMITS.cells)reasons.push('unsupported-grid');
 else{
  const rows=data.num_rows,columns=data.num_cols,occupied=new Set<number>();
  if(rows*columns>NATIVE_TABLE_LIMITS.cells)reasons.push('grid-size-limit');
  else for(const value of cells){
   const cell=object(value),r=cell?.start_row_offset_idx,c=cell?.start_col_offset_idx;
   // End offsets and explicit span sizes are alternative native encodings.
   // Calculating an interval from a supplied span does not invent a missing span.
   const endR=cell?.end_row_offset_idx??(positive(cell?.row_span,rows)&&Number.isSafeInteger(r)?(r as number)+(cell!.row_span as number):undefined);
   const endC=cell?.end_col_offset_idx??(positive(cell?.col_span,columns)&&Number.isSafeInteger(c)?(c as number)+(cell!.col_span as number):undefined);
   if(!cell||!Number.isSafeInteger(r)||!Number.isSafeInteger(c)||(r as number)<0||(c as number)<0||
    !positive(endR,rows)||!positive(endC,columns)||endR<=(r as number)||endC<=(c as number)||
    (cell.row_span!==undefined&&cell.row_span!==endR-(r as number))||
    (cell.col_span!==undefined&&cell.col_span!==endC-(c as number))||
    ['column_header','row_header','row_section'].some(key=>cell[key]!==undefined&&typeof cell[key]!=='boolean')){
    reasons.push('unsupported-cell-structure');continue;
   }
   for(let row=r as number;row<endR;row++)for(let col=c as number;col<endC;col++){
    const index=row*columns+col;if(occupied.has(index))reasons.push('overlapping-cells');occupied.add(index);
   }
  }
  if(occupied.size!==rows*columns)reasons.push('incomplete-grid');
  if(native.cellTexts.length!==cells.length||native.cellTexts.some((cell,index)=>cell.cellIndex!==index||typeof cell.text!=='string'))
   reasons.push('cell-text-mapping-unavailable');
 }
 if(Buffer.byteLength(canonical(native))>NATIVE_TABLE_LIMITS.bodyBytes)reasons.push('artifact-size-limit');
 const value:Omit<NativeTableArtifact,'artifactSha256'>={namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,schema:1,
  status:reasons.length?'unavailable' as const:'available' as const,reasons:[...new Set(reasons)],native};
 return {...value,artifactSha256:sha(canonical(value))};
}

/** Search-only copy; uncertainty/status strings never become matching terms. */
export function nativeTableSearchStrings(artifact:NativeTableArtifact):string{
 if(artifact.status!=='available')return '';
 return [...artifact.native.cellTexts.map(cell=>cell.text),...artifact.native.captions.map(caption=>
  typeof caption.raw.text==='string'&&caption.raw.text.trim()?caption.raw.text:typeof caption.raw.orig==='string'?caption.raw.orig:'')].join('\n');
}

export type PreparedNativeTableCandidates={owner:string;documentId:string;sourceHash:string;artifacts:NativeTableArtifact[];sha256:string};
const prepared=new WeakSet<PreparedNativeTableCandidates>();
const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}};

/** Verify saved raw outputs outside the ingestion transaction. A parser payload
 * with a digest-shaped caller field is insufficient provenance. No HTTP calls. */
export async function prepareNativeTableCandidates(input:{owner:string;documentId:string;sourceHash:string;tables:DoclingNativeTable[]}):Promise<PreparedNativeTableCandidates>{
 input={...input,tables:structuredClone(input.tables)};
 if(!input.owner||!input.documentId||!isSha(input.sourceHash)||input.tables.length>NATIVE_TABLE_LIMITS.tables)
  throw new Error('Invalid bounded native table input');
 const checked=new Map<string,DoclingNativeTable[]>(),artifacts:NativeTableArtifact[]=[];
 for(const table of input.tables){
  let artifact=prepareNativeTableArtifact(table);
  if(table.result){
   try{
    const ref=table.result,key=canonical(ref);let actual=checked.get(key);
    if(!actual){
     const bytes=await readBlob(ref.resultBlobSha256);
     if(sha(bytes)!==ref.resultBlobSha256)throw new Error('raw-result-checksum');
     const saved=JSON.parse(Buffer.from(bytes).toString('utf8')),identity=saved.identity;
     if(identity?.owner!==input.owner||identity?.documentId!==input.documentId||identity?.sourceHash!==input.sourceHash||
      identity?.inputHash!==ref.derivedInputSha256||identity?.optionsHash!==ref.optionsHash||
      canonical(identity?.copyIndices)!==canonical(ref.copyIndices)||
      !positive(identity?.totalPages,500)||ref.copyIndices.some(page=>page>=identity.totalPages))throw new Error('raw-result-source-mapping');
     const count=ref.copyIndices.length,decoded=decodeDoclingResult(saved.result,count,
      {verifiedBlankPages:Array.from({length:count},(_,i)=>i+1),formulaEnriched:false});
     actual=decoded.nativeTables.map(value=>({...value,pageNumbers:value.pageNumbers.map(page=>ref.copyIndices[page-1]+1),result:{...ref}}));
     checked.set(key,actual);
    }
    if(!actual.some(value=>canonical(value)===canonical(table)))throw new Error('raw-table-differs');
   }catch{
    const {artifactSha256:_hash,...value}=artifact;
    const failed={...value,status:'unavailable' as const,reasons:[...new Set([...value.reasons,'raw-result-unverified'])]};
    artifact={...failed,artifactSha256:sha(canonical(failed))};
   }
  }
  artifacts.push(artifact);
 }
 const value={owner:input.owner,documentId:input.documentId,sourceHash:input.sourceHash,artifacts,
  sha256:sha(canonical(artifacts))};freeze(value);prepared.add(value);return value;
}

export function assertPreparedNativeTableCandidates(value:PreparedNativeTableCandidates,owner:string,documentId:string,sourceHash:string){
 if(!prepared.has(value)||value.owner!==owner||value.documentId!==documentId||value.sourceHash!==sourceHash||sha(canonical(value.artifacts))!==value.sha256)
  throw new Error('Native table staging receipt differs');
}

type Queryable=Pick<Pool,'query'>|Pick<PoolClient,'query'>;
type VisualManifest={content:{rawPdfSha256:string;renderStatus:string;assets:Array<{kind:string;physicalPage:number;sha256:string}>};
 bindings:Array<{index:number;anchorEvidenceId:string}>};

/** Called after the same-version visual manifest is published, in its short
 * transaction. Unsupported artifacts are recorded without search text. */
export async function commitNativeTableCandidates(db:Queryable,value:PreparedNativeTableCandidates,source:DocumentContextSource,pageEvidenceIds:string[]){
 source={...source};pageEvidenceIds=[...pageEvidenceIds];
 assertPreparedNativeTableCandidates(value,value.owner,source.documentId,source.sourceHash);
 if(!value.artifacts.length)return {tables:0,available:0,unavailable:0,artifactSha256:value.sha256};
 const current=(await db.query<{course_id:string}>(`SELECT coalesce(d.course_id,'') course_id FROM document_texts d
  JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
  JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
  WHERE d.owner_id=$1 AND d.id=$2 AND d.current_version_id=$3 AND v.source_version_id=$4 AND d.source_hash=$5
  AND s.raw_sha256=$5 AND NOT d.hidden AND ($6::text IS NULL OR coalesce(d.course_id,'')=$6)
  AND NOT EXISTS(SELECT 1 FROM document_texts n WHERE n.owner_id=d.owner_id AND n.origin=d.origin AND n.origin_key=d.origin_key
   AND NOT n.hidden AND(n.created_at>d.created_at OR(n.created_at=d.created_at AND n.id>d.id))) FOR UPDATE OF d`,
 [value.owner,source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash,source.courseId??null])).rows;
 if(current.length!==1)throw new DocumentEvidenceChangedError();
 // courseId is optional on the public source identity. Hash the checked DB
 // representation so omitted and explicit empty/course values resolve alike.
 source={documentId:source.documentId,currentVersionId:source.currentVersionId,sourceVersionId:source.sourceVersionId,
  sourceHash:source.sourceHash,courseId:current[0].course_id};
 const row=(await db.query<{manifest:VisualManifest;manifest_sha256:string}>(
  `SELECT manifest,manifest_sha256 FROM document_pdf_visual_manifests WHERE version_id=$1 AND source_version_id=$2 AND source_hash=$3`,
  [source.currentVersionId,source.sourceVersionId,source.sourceHash])).rows[0];
 if(row&&(sha(canonical(row.manifest))!==row.manifest_sha256||row.manifest.content.rawPdfSha256!==source.sourceHash))
  throw new Error('Native table visual manifest differs');
 let availableCount=0;
 for(const artifact of value.artifacts){
  const page=artifact.native.pageNumbers.length===1?artifact.native.pageNumbers[0]:null;
  const assetIndex=row?.manifest.content.assets.findIndex(asset=>asset.kind==='pdf-page'&&asset.physicalPage===page)??-1;
  const asset=assetIndex>=0?row!.manifest.content.assets[assetIndex]:null;
  const anchor=page?pageEvidenceIds[page-1]:null,binding=assetIndex>=0?row!.manifest.bindings[assetIndex]:null;
  const available=artifact.status==='available'&&row?.manifest.content.renderStatus==='available'&&asset&&anchor&&
   binding?.index===assetIndex&&binding.anchorEvidenceId===anchor&&isSha(asset.sha256);
  const status=available?'available':'unavailable';
  if(available)availableCount++;
  const ref=artifact.native.result;
  const identity={namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,source,artifactSha256:artifact.artifactSha256,
   manifestSha256:row?.manifest_sha256??null,assetSha256:asset?.sha256??null,anchor:anchor??null};
  const id=sha(canonical(identity)),search=available?documentSearchText(nativeTableSearchStrings(artifact)):'';
  await db.query(`INSERT INTO document_table_candidates(id,namespace,producer,document_id,version_id,source_version_id,source_hash,
   page_number,anchor_evidence_id,manifest_sha256,asset_sha256,raw_result_sha256,input_sha256,options_sha256,artifact_sha256,status,artifact,search_text,unavailable_reason)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19) ON CONFLICT(id) DO NOTHING`,
  [id,NATIVE_TABLE_NAMESPACE,NATIVE_TABLE_PRODUCER,source.documentId,source.currentVersionId,source.sourceVersionId,source.sourceHash,
   page,anchor??null,row?.manifest_sha256??null,asset?.sha256??null,ref?.resultBlobSha256??null,ref?.derivedInputSha256??null,
   ref?.optionsHash??null,artifact.artifactSha256,status,canonical(artifact),search,
   available?null:artifact.reasons.length?artifact.reasons.join(','):'original-page-image-unavailable']);
 }
 return {tables:value.artifacts.length,available:availableCount,unavailable:value.artifacts.length-availableCount,artifactSha256:value.sha256};
}

/** Deliberately no body, quote, rank-as-confidence or OCR string fields. */
export type DerivedTableCandidate={kind:'derived-native-table';id:string;source:DocumentContextSource;pageNumber:number;
 anchorEvidenceId:string;manifestSha256:string;assetSha256:string;artifactSha256:string};
type CandidateRow={id:string;document_id:string;version_id:string;source_version_id:string;source_hash:string;course_id:string;
 page_number:number;anchor_evidence_id:string;manifest_sha256:string;asset_sha256:string;artifact_sha256:string;artifact:NativeTableArtifact};

const candidateSQL=`SELECT t.id,t.document_id,t.version_id,t.source_version_id,t.source_hash,coalesce(d.course_id,'') course_id,
 t.page_number,t.anchor_evidence_id,t.manifest_sha256,t.asset_sha256,t.artifact_sha256,t.artifact,t.search_vector
 FROM document_table_candidates t
 JOIN document_texts d ON d.id=t.document_id AND d.current_version_id=t.version_id AND d.source_hash=t.source_hash
 JOIN document_text_versions v ON v.id=t.version_id AND v.document_id=d.id AND v.source_version_id=t.source_version_id
 JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id AND s.raw_sha256=t.source_hash
 JOIN document_text_pages p ON p.version_id=v.id AND p.page_number=t.page_number AND p.evidence_id=t.anchor_evidence_id
 JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=t.source_version_id AND e.source_item_id=d.source_item_id
 JOIN document_pdf_visual_manifests m ON m.version_id=t.version_id AND m.source_version_id=t.source_version_id
  AND m.source_hash=t.source_hash AND m.manifest_sha256=t.manifest_sha256
 WHERE d.owner_id=$1 AND NOT d.hidden AND t.status='available' AND t.namespace='${NATIVE_TABLE_NAMESPACE}'
 AND t.producer='${NATIVE_TABLE_PRODUCER}' AND NOT EXISTS(SELECT 1 FROM document_texts n WHERE n.owner_id=d.owner_id
  AND n.origin=d.origin AND n.origin_key=d.origin_key AND NOT n.hidden
  AND(n.created_at>d.created_at OR(n.created_at=d.created_at AND n.id>d.id)))`;

function candidate(row:CandidateRow):DerivedTableCandidate{
 const {artifactSha256,...artifact}=row.artifact;
 if(row.artifact.status!=='available'||artifactSha256!==row.artifact_sha256||sha(canonical(artifact))!==artifactSha256||
  row.artifact.namespace!==NATIVE_TABLE_NAMESPACE||row.artifact.producer!==NATIVE_TABLE_PRODUCER||
  row.artifact.native.pageNumbers.length!==1||row.artifact.native.pageNumbers[0]!==row.page_number)throw new DocumentEvidenceChangedError();
 const source={documentId:row.document_id,currentVersionId:row.version_id,sourceVersionId:row.source_version_id,
  sourceHash:row.source_hash,courseId:row.course_id};
 const identity={namespace:NATIVE_TABLE_NAMESPACE,producer:NATIVE_TABLE_PRODUCER,source,artifactSha256,
  manifestSha256:row.manifest_sha256,assetSha256:row.asset_sha256,anchor:row.anchor_evidence_id};
 if(sha(canonical(identity))!==row.id)throw new DocumentEvidenceChangedError();
 return {kind:'derived-native-table',id:row.id,source,pageNumber:row.page_number,anchorEvidenceId:row.anchor_evidence_id,
  manifestSha256:row.manifest_sha256,assetSha256:row.asset_sha256,artifactSha256};
}

/** FTS uses the same current corpus scope, without changing protected text ranks.
 * At most two distinct page anchors supplement a normal answer. */
export async function searchNativeTableCandidates(pool:Pool,owner:string,query:string,scope:{courseId?:string;documentId?:string;strict?:boolean}={}):Promise<DerivedTableCandidate[]>{
 const {normalized,words}=documentSearchTerms(query);
 if(!words.length)return [];
 const args:unknown[]=[owner,scope.strict?normalized:words.map(word=>`"${word}"`).join(' OR ')];
 const course=scope.courseId?`AND d.course_id=$${args.push(scope.courseId)}`:'';
 const document=scope.documentId?`AND d.id=$${args.push(scope.documentId)}`:'';
 const querySQL=scope.strict?`plainto_tsquery('simple',$2)||plainto_tsquery('english',$2)`:
  `websearch_to_tsquery('simple',$2)||websearch_to_tsquery('english',$2)`;
 const rows=(await pool.query<CandidateRow>(`WITH hits AS (${candidateSQL} ${course} ${document}
  AND t.search_vector @@ (${querySQL})), ranked AS (SELECT hits.*,ts_rank_cd(search_vector,(${querySQL})) match_rank,row_number() OVER
  (PARTITION BY version_id,page_number ORDER BY ts_rank_cd(search_vector,(${querySQL})) DESC,id) page_rank FROM hits)
  SELECT * FROM ranked WHERE page_rank=1 ORDER BY match_rank DESC,id LIMIT ${NATIVE_TABLE_LIMITS.supplementalPages}`,args)).rows;
 return rows.map(candidate);
}

/** Cached candidate identities are rechecked before AND after rereading actual
 * PNGs. An unavailable image is an error, never permission to answer from OCR. */
export async function readNativeTableCandidateEvidence(pool:Pool,owner:string,requested:DerivedTableCandidate[],
 selection?:{budget:DocumentImageBudget;firstAnchorRank:number}){
 const expected=structuredClone(requested);
 if(expected.length>NATIVE_TABLE_LIMITS.supplementalPages||new Set(expected.map(value=>value.id)).size!==expected.length)
  throw new Error('Invalid bounded native table selections');
 const verify=async()=>{
  if(!expected.length)return;
  const rows=(await pool.query<CandidateRow>(`${candidateSQL} AND t.id=ANY($2::text[])`,[owner,expected.map(value=>value.id)])).rows;
  const actual=new Map(rows.map(row=>[row.id,candidate(row)]));
  if(rows.length!==expected.length||expected.some(value=>canonical(actual.get(value.id))!==canonical(value)))throw new DocumentEvidenceChangedError();
 };
 await verify();const imageAnchors:DocumentSelectedNodeHit[]=[],images:PdfVisualImageEvidence[]=[];
 const {readPdfVisualEvidence,PDF_VISUAL_READ_LIMITS}=await import('./pdf-visual-evidence.ts');
 for(const [index,item] of expected.entries()){
  const source=item.source,ids=[item.anchorEvidenceId];
  const nodes=await readDocumentNodes(pool,owner,source,ids),visuals=await readPdfVisualEvidence(pool,owner,source,ids,undefined,
   {pageAssetsOnly:true,...(selection?{selection:{budget:selection.budget,anchorRank:selection.firstAnchorRank+index}}:{})});
   const node=nodes.find(node=>node.evidence_id===item.anchorEvidenceId&&node.page_number===item.pageNumber);
   const matches=(image:Omit<PdfVisualImageEvidence,'bytes'>)=>image.kind==='pdf-page'&&image.anchorEvidenceId===item.anchorEvidenceId&&
    image.physicalPage===item.pageNumber&&image.sha256===item.assetSha256&&image.manifestSha256===item.manifestSha256;
   const png=visuals.images.find(matches),omitted=visuals.omittedImages?.find(matches);
   if(!node||(!png&&!omitted))throw new Error('Native table original page image is unavailable');
   if(!png)continue;
   if(!imageAnchors.some(value=>value.evidence_id===node.evidence_id))imageAnchors.push(node);
   if(!images.some(value=>value.attachmentId===png.attachmentId))images.push(png);
 }
 if(images.reduce((sum,image)=>sum+image.byteLength,0)>PDF_VISUAL_READ_LIMITS.bytes||
  images.reduce((sum,image)=>sum+2*Math.ceil(image.width/32)*Math.ceil(image.height/32)+1,0)>PDF_VISUAL_READ_LIMITS.imageInputTokens)
  throw new Error('Native table original images exceed the read limit');
 await verify();return {imageAnchors,images};
}

/** Historical artifacts remain reconstructible even after their source is hidden. */
export async function nativeTableBlobHashes(db:Queryable):Promise<string[]>{
 const rows=(await db.query<{source_hash:string;asset_sha256:string|null;raw_result_sha256:string|null;input_sha256:string|null}>(
  'SELECT source_hash,asset_sha256,raw_result_sha256,input_sha256 FROM document_table_candidates')).rows;
 return [...new Set(rows.flatMap(row=>[row.source_hash,row.asset_sha256,row.raw_result_sha256,row.input_sha256].filter(isSha)))];
}
