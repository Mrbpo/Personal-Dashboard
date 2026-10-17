import {createHash} from 'node:crypto';
import {assertNativeTableObservation,assertAuthorImageTableObservation,type TableObservation} from './document-table-candidates.ts';
import type {DocumentContextSource,DocumentImageEvidence} from './document-context.ts';
import type {PdfVisualImageEvidence} from './pdf-visual-evidence.ts';

export const SOURCE_VALUE_CONTRACT='difference-v1';
export const SOURCE_VALUE_LIMITS=Object.freeze({cells:256,bytes:32768});
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
const canonical=(v:unknown):string=>JSON.stringify(v,(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?
 Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const exact=(v:unknown,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
 Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
type OriginalImage=PdfVisualImageEvidence|Pick<DocumentImageEvidence,'source'|'attachmentId'|'captionEvidenceId'|'sha256'|'width'|'height'>;
export type SourceValueImage={id:string;kind:'text'|'image';documentId:string;documentVersionId:string;sourceVersionId:string;sourceHash:string;
 evidenceId:string;sha256:string;image?:OriginalImage;tableObservations?:TableObservation[]};
type Cell={id:string;tableId:string;row:number;column:number;rowSpan:number;columnSpan:number;
 headerRole:'none'|'row'|'column'|'section'|'unknown';text:string;rawCellSha256:string};
type Table={id:string;imageId:string;source:DocumentContextSource;evidenceId:string;imageSha256:string;attachmentId:string;
 artifactSha256:string;observationSha256:string;producer:string;tableReference:string;
 semanticVerified:false;relationshipVerified:false;visibilityVerified:false};
export type SourceValueCatalog={version:'source-value-catalog-v1';complete:boolean;status:'available'|'unavailable';
 reason:null|'no-table-observations'|'observation-unavailable'|'catalog-cell-limit'|'catalog-byte-limit';
 sourceInputSha256:string;tables:Table[];cells:Cell[];limits:typeof SOURCE_VALUE_LIMITS;catalogSha256:string};
type Selections={status:'answered'|'insufficient-evidence'|'conflicting-evidence';message:string;claims:Array<{text:string;citations:{id:string}[]}>};
type Difference={kind:'difference';leftValueRef:string;rightValueRef:string;leftRowLabelRef:string;rightRowLabelRef:string;columnLabelRefs:string[]};
export type SourceValueDerivation={method:'source-value-difference-v1';rawProviderResult:unknown;rawOutputText:string;rawOutputSha256:string;
 rawOperationSha256:string;catalogSha256:string;normalizedSelections:Selections;normalizedSelectionsSha256:string;
 operations:Array<{claimIndex:number;operation:Difference;sourceCells:Cell[];sourceTable:Table;difference:string;arithmetic:'exact-fixed-decimal';
  arithmeticVerified:true;semanticVerified:false;relationshipVerified:false;visibilityVerified:false}>;
 semanticVerified:false;coverage:'unassessed'};

/** Only metadata of the actually selected, already verified Kernel PNGs enters
 * this catalog. Entire tables are retained or the whole catalog is unavailable. */
export function prepareSourceValueCatalog(images:readonly SourceValueImage[]):SourceValueCatalog{
 const sourceInputSha256=sha(canonical(images.filter(s=>s.kind==='image').map(({image,...s})=>s))),tables:Table[]=[],cells:Cell[]=[];
 const finish=(reason:SourceValueCatalog['reason'])=>{
  const value={version:'source-value-catalog-v1' as const,complete:reason===null,status:reason===null?'available' as const:'unavailable' as const,
   reason,sourceInputSha256,tables:reason?[]:tables,cells:reason?[]:cells,limits:SOURCE_VALUE_LIMITS};
  return {...value,catalogSha256:sha(canonical(value))};
 };
 for(const s of images){
  if(s.kind!=='image')continue;
  for(const observation of s.tableObservations??[]){
   const image=s.image;
   if(!image||image.sha256!==s.sha256||image.source.documentId!==s.documentId||image.source.currentVersionId!==s.documentVersionId||
    image.source.sourceVersionId!==s.sourceVersionId||image.source.sourceHash!==s.sourceHash||
    ('anchorEvidenceId' in image?image.anchorEvidenceId:image.captionEvidenceId)!==s.evidenceId)throw new Error('Source value image binding differs');
   const c=observation.candidate,source=c.source;
   if(observation.version==='docling-native-observation-v1'){
    if(!('kind' in image))throw new Error('Source value native page binding differs');assertNativeTableObservation(observation,image);
   }else{
    if('kind' in image)throw new Error('Source value author image binding differs');assertAuthorImageTableObservation(observation,image);
   }
   if(observation.status!=='available')return finish('observation-unavailable');
   const native=observation.version==='docling-native-observation-v1'?observation.native:undefined;
   const groups=observation.version==='author-image-table-observation-v1'?observation.artifact!.grid.tables.map((t,index)=>({
    reference:`tables/${index}`,cells:t.cells.map(cell=>({...cell,rawCellSha256:sha(canonical(cell))}))})):[{
    reference:native!.reference,cells:(native!.raw.data as {table_cells:Record<string,unknown>[]}).table_cells.map((raw,index)=>{
     const row=raw.start_row_offset_idx as number,column=raw.start_col_offset_idx as number;
     const flags=[raw.row_header===true,raw.column_header===true,raw.row_section===true];
     return {row,column,rowSpan:raw.row_span as number??(raw.end_row_offset_idx as number)-row,
      columnSpan:raw.col_span as number??(raw.end_col_offset_idx as number)-column,text:native!.cellTexts[index].text,
      headerRole:flags.filter(Boolean).length>1?'unknown':flags[0]?'row':flags[1]?'column':flags[2]?'section':
       [raw.row_header,raw.column_header,raw.row_section].every(v=>v===false)?'none':'unknown',rawCellSha256:sha(canonical(raw))};
    })}];
   for(const group of groups){
    if(cells.length+group.cells.length>SOURCE_VALUE_LIMITS.cells)return finish('catalog-cell-limit');
    const tableValue={imageId:s.id,source:structuredClone(source),evidenceId:s.evidenceId,imageSha256:s.sha256,attachmentId:image.attachmentId,
     artifactSha256:c.artifactSha256,observationSha256:observation.observationSha256,producer:observation.producer,tableReference:group.reference,
     semanticVerified:false as const,relationshipVerified:false as const,visibilityVerified:false as const};
    const table={id:'t:'+sha(canonical(tableValue)).slice(0,40),...tableValue};tables.push(table);
    for(const raw of group.cells){
     const value={tableId:table.id,...raw};cells.push({id:'v:'+sha(canonical({table,...raw})).slice(0,40),...value} as Cell);
    }
   }
  }
 }
 if(!cells.length)return finish('no-table-observations');
 if(new Set(cells.map(c=>c.id)).size!==cells.length||new Set(tables.map(t=>t.id)).size!==tables.length)throw new Error('Duplicate source value identity');
 const result=finish(null);return Buffer.byteLength(canonical(result))>SOURCE_VALUE_LIMITS.bytes?finish('catalog-byte-limit'):result;
}

function assertCatalog(c:SourceValueCatalog){
 const {catalogSha256,...value}=c;
 if(c.version!=='source-value-catalog-v1'||c.status!=='available'||!c.complete||c.reason!==null||
  sha(canonical(value))!==catalogSha256||!c.cells.length||c.cells.length>SOURCE_VALUE_LIMITS.cells||Buffer.byteLength(canonical(c))>SOURCE_VALUE_LIMITS.bytes)
  throw new Error('Source value catalog is unavailable or changed');
 if(new Set(c.tables.map(t=>t.id)).size!==c.tables.length||new Set(c.cells.map(cell=>cell.id)).size!==c.cells.length)throw new Error('Duplicate catalog identities');
 for(const table of c.tables){const {id,...rest}=table;
  if(id!=='t:'+sha(canonical(rest)).slice(0,40)||table.semanticVerified!==false||table.relationshipVerified!==false||table.visibilityVerified!==false)
   throw new Error('Source table identity changed');
 }
 for(const cell of c.cells){const {id,tableId,...rest}=cell,table=c.tables.find(t=>t.id===tableId);
  if(!table||id!=='v:'+sha(canonical({table,...rest})).slice(0,40))throw new Error('Source cell identity changed');
 }
}
export function sourceValueAnswerSchema(catalog:SourceValueCatalog,selectedIds:string[]){
 assertCatalog(catalog);
 return {type:'object',additionalProperties:false,$defs:{cellId:{type:'string',enum:catalog.cells.map(c=>c.id)},
  originalId:{type:'string',enum:selectedIds}},properties:{status:{type:'string',enum:['answered','insufficient-evidence','conflicting-evidence']},
  message:{type:'string'},claims:{type:'array',maxItems:30,items:{anyOf:[{type:'object',additionalProperties:false,properties:{
   kind:{type:'string',enum:['statement']},text:{type:'string'},citations:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,
    properties:{id:{$ref:'#/$defs/originalId'}},required:['id']}}},required:['kind','text','citations']},
   {type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['difference']},
    leftValueRef:{$ref:'#/$defs/cellId'},rightValueRef:{$ref:'#/$defs/cellId'},leftRowLabelRef:{$ref:'#/$defs/cellId'},
    rightRowLabelRef:{$ref:'#/$defs/cellId'},columnLabelRefs:{type:'array',minItems:1,maxItems:4,items:{$ref:'#/$defs/cellId'}}},
    required:['kind','leftValueRef','rightValueRef','leftRowLabelRef','rightRowLabelRef','columnLabelRefs']}]}}},required:['status','message','claims']};
}
function decimal(text:string){
 if(text.length>32||!(/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(text)))throw new Error('Source value is not an explicit plain decimal');
 const sign=text.startsWith('-')?-BigInt(1):BigInt(1),parts=text.replace(/^[+-]/u,'').split('.'),scale=parts[1]?.length??0;
 if(scale>12)throw new Error('Source decimal precision is unsupported');return {integer:sign*BigInt((parts[0]||'0')+(parts[1]||'')),scale};
}
export function sourceDecimalDifference(left:string,right:string){
 const a=decimal(left),b=decimal(right),scale=Math.max(a.scale,b.scale),n=a.integer*BigInt(10)**BigInt(scale-a.scale)-b.integer*BigInt(10)**BigInt(scale-b.scale);
 const sign=n<BigInt(0)?'-':'',digits=(n<BigInt(0)?-n:n).toString().padStart(scale+1,'0');
 return sign+(scale?`${digits.slice(0,-scale)}.${digits.slice(-scale)}`.replace(/0+$/u,'').replace(/\.$/u,''):digits);
}
/** This decodes a NEW operation response. It never repairs an old free-form
 * assertion or adds references to a statement. Semantic flags remain false. */
export function deriveSourceValueAnswer(value:unknown,rawOutputText:string,catalog:SourceValueCatalog,selectedIds:string[]):SourceValueDerivation{
 assertCatalog(catalog);
 if(!exact(value,['status','message','claims'])||canonical(JSON.parse(rawOutputText))!==canonical(value))throw new Error('Invalid source value operation response');
 const v=value as {status:Selections['status'];message:string;claims:unknown[]};
 if(!['answered','insufficient-evidence','conflicting-evidence'].includes(v.status)||typeof v.message!=='string'||v.message.length>3000||
  !Array.isArray(v.claims)||v.claims.length>30)throw new Error('Invalid source value answer');
 if(v.status==='insufficient-evidence'?v.claims.length!==0:(!v.claims.length||v.message!==''))throw new Error('Invalid source value status');
 const byId=new Map(catalog.cells.map(c=>[c.id,c])),operations:SourceValueDerivation['operations']=[],claims:Selections['claims']=[];
 for(const [claimIndex,raw]of v.claims.entries()){
  const op=raw as Difference;
  if((raw as {kind?:string})?.kind==='statement'){
   if(!exact(raw,['kind','text','citations']))throw new Error('Invalid source value statement');
   const statement=raw as {text:string;citations:{id:string}[]};
   if(typeof statement.text!=='string'||!statement.text.trim()||statement.text.length>3000||!Array.isArray(statement.citations)||
    !statement.citations.length||statement.citations.length>20||statement.citations.some(c=>!exact(c,['id'])||!selectedIds.includes(c.id)))throw new Error('Statement references are outside selected originals');
   claims.push({text:statement.text,citations:structuredClone(statement.citations)});continue;
  }
  if(!exact(op,['kind','leftValueRef','rightValueRef','leftRowLabelRef','rightRowLabelRef','columnLabelRefs'])||op.kind!=='difference'||
   !Array.isArray(op.columnLabelRefs)||!op.columnLabelRefs.length||op.columnLabelRefs.length>4||new Set(op.columnLabelRefs).size!==op.columnLabelRefs.length)
   throw new Error('Invalid difference operation');
  const ids=[op.leftValueRef,op.rightValueRef,op.leftRowLabelRef,op.rightRowLabelRef,...op.columnLabelRefs];
  if(ids.some(id=>!byId.has(id)))throw new Error('Unknown source cell reference');
  const [left,right,leftRow,rightRow,...columns]=ids.map(id=>byId.get(id)!);
  if(left.id===right.id||[right,leftRow,rightRow,...columns].some(c=>c.tableId!==left.tableId)||left.column!==right.column||
   left.columnSpan!==1||right.columnSpan!==1||left.rowSpan!==1||right.rowSpan!==1||left.headerRole!=='none'||right.headerRole!=='none'||
   columns.some(column=>!column.text.trim()||!['column','section'].includes(column.headerRole)||column.column>left.column||column.column+column.columnSpan<=left.column||
    column.row+column.rowSpan>Math.min(left.row,right.row))||
   [leftRow,rightRow].some((r,index)=>{const c=index?right:left;return !r.text.trim()||r.headerRole!=='row'||r.row>c.row||r.row+r.rowSpan<=c.row||
    (r.column<=c.column&&r.column+r.columnSpan>c.column);}))throw new Error('Difference requires one table, one numeric column and explicit positioned row/column labels');
  const table=catalog.tables.find(t=>t.id===left.tableId)!;
  if(!selectedIds.includes(table.imageId))throw new Error('Difference cannot cite an unselected image');
  const header=columns.map(column=>JSON.stringify(column.text)).join(' / ');
  const difference=sourceDecimalDifference(left.text,right.text),text=`${JSON.stringify(leftRow.text)} [${header}]: ${left.text}; `+
   `${JSON.stringify(rightRow.text)} [${header}]: ${right.text}; printed-value difference (left minus right) = ${difference}.`;
  if(text.length>3000)throw new Error('Derived source value claim exceeds the answer bound');
  claims.push({text,citations:[{id:table.imageId}]});operations.push({claimIndex,operation:structuredClone(op),sourceCells:structuredClone([left,right,leftRow,rightRow,...columns]),
   sourceTable:structuredClone(table),difference,arithmetic:'exact-fixed-decimal',arithmeticVerified:true,semanticVerified:false,relationshipVerified:false,visibilityVerified:false});
 }
 const normalizedSelections={status:v.status,message:v.message,claims};
 return {method:'source-value-difference-v1',rawProviderResult:structuredClone(value),rawOutputText,rawOutputSha256:sha(rawOutputText),
  rawOperationSha256:sha(canonical(value)),catalogSha256:catalog.catalogSha256,normalizedSelections,normalizedSelectionsSha256:sha(canonical(normalizedSelections)),
  operations,semanticVerified:false,coverage:'unassessed'};
}
