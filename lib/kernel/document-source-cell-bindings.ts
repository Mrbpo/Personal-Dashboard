import {createHash} from 'node:crypto';
import {assertNativeTableObservation} from './document-table-candidates.ts';
import {completeSourceValueColumnHeaders,sourceDecimalDifference,SOURCE_VALUE_LIMITS,type SourceValueImage} from './document-source-values.ts';
import type {DocumentContextSource} from './document-context.ts';

const canonical=(v:unknown):string=>JSON.stringify(v,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
 Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item),sha=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex'),
 exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export class SourceCellBindingError extends Error{
 readonly code:string;readonly stage:'evidence-selection'|'structure-storage'|'generation';
 constructor(code:string,stage:'evidence-selection'|'structure-storage'|'generation'='generation'){
  super(code);this.name='SourceCellBindingError';this.code=code;this.stage=stage;
 }
}
type Cell={id:string;tableId:string;index:number;row:number;column:number;rowSpan:number;columnSpan:number;text:string;
 headerRole:'row'|'column'|'section'|'none'|'unknown';rawCellSha256:string;bbox:unknown};
type Table={id:string;imageId:string;observationIndex:number;source:DocumentContextSource;
 evidenceId:string;imageSha256:string;artifactSha256:string;observationSha256:string;nativeSha256:string;physicalPage:number;
 rawCellReferenceBasis:'native.raw.data.table_cells[index]';unknownPositions:number[][];gridStatus:'available'|'unavailable';
 semanticVerified:false;relationshipVerified:false;visibilityVerified:false};
export const SOURCE_CELL_VALUE_PATH_VERSION='parser-declared-cell-paths-v1';
type ValuePath={status:'parser-derived';rowLabels:string[];columnLabels:string[]}|{status:'not-value'}|
 {status:'unknown';reason:string;stage:SourceCellBindingError['stage']};
export type SourceCellBindingCatalog={version:'source-cell-bindings-v2';status:'available'|'unavailable';reason:string|null;
 valuePathVersion:typeof SOURCE_CELL_VALUE_PATH_VERSION;
 tables:Table[];cells:Cell[];catalogSha256:string;wire:{version:'source-cell-bindings-v2';status:'available'|'unavailable';reason:string|null;
  authority:'parser-declared-untrusted';coverage:'observed-cells-only';gridRepaired:false;
  valuePathVersion:typeof SOURCE_CELL_VALUE_PATH_VERSION;valuePathAuthority:'parser-derived-unverified';
  tables:Array<Table&{cells:Array<Pick<Cell,'id'|'index'|'row'|'column'|'text'|'headerRole'>&{valuePath:ValuePath}>}>;catalogSha256:string};
 /** Private reader witnesses; never put the whole catalog into model input. */
 sources:readonly SourceValueImage[]};
type Binding={value:Cell;rowLabels:Cell[];columnLabels:Cell[];table:Table};
type Selections={status:'answered'|'insufficient-evidence'|'conflicting-evidence';message:string;claims:Array<{text:string;citations:{id:string}[]}>};
export type SourceCellDerivation={method:'source-cell-bindings-v2';rawProviderResult:unknown;rawOutputText:string;rawOutputSha256:string;
 questionContract?:undefined;
 rawOperationSha256:string;catalogSha256:string;normalizedSelections:Selections;normalizedSelectionsSha256:string;
 operations:Array<{claimIndex:number;kind:'table-value'|'table-difference';bindings:Binding[];difference?:string;
  arithmeticVerified:boolean;semanticVerified:false;relationshipVerified:false;visibilityVerified:false}>;
 semanticVerified:false;coverage:'unassessed'};

/** An index of observed cells beside original PNGs, not a usable/repaired grid.
 * Private witnesses are revalidated; only catalog.wire is provider metadata. */
export function prepareSourceCellBindingCatalog(sources:readonly SourceValueImage[]):SourceCellBindingCatalog{
 const tables:Table[]=[],cells:Cell[]=[];
 const finish=(reason:string|null):SourceCellBindingCatalog=>{
  const status=reason?'unavailable' as const:'available' as const,value={version:'source-cell-bindings-v2' as const,status,reason,
   valuePathVersion:SOURCE_CELL_VALUE_PATH_VERSION as typeof SOURCE_CELL_VALUE_PATH_VERSION,tables:reason?[]:tables,cells:reason?[]:cells},catalogSha256=sha(value),wire={version:value.version,status,reason,
   authority:'parser-declared-untrusted' as const,coverage:'observed-cells-only' as const,gridRepaired:false as const,
   valuePathVersion:SOURCE_CELL_VALUE_PATH_VERSION as typeof SOURCE_CELL_VALUE_PATH_VERSION,valuePathAuthority:'parser-derived-unverified' as const,
   tables:reason?[]:tables.map(table=>({...table,cells:cells.filter(c=>c.tableId===table.id).map(cell=>{
    const {id,index,row,column,text,headerRole}=cell;
    return {id,index,row,column,text,headerRole,valuePath:declaredValuePath(value,cell,table.imageId)};
   })})),catalogSha256};
  return {...value,catalogSha256,wire,sources};
 };
 for(const support of sources){
  if(support.kind!=='image'||!support.image||!('kind' in support.image))continue;
  for(const [observationIndex,observation]of (support.tableObservations??[]).entries()){
   if(observation.version!=='docling-native-observation-v1')continue;
   assertNativeTableObservation(observation,support.image);
   if(support.documentId!==support.image.source.documentId||support.documentVersionId!==support.image.source.currentVersionId||
    support.sourceVersionId!==support.image.source.sourceVersionId||support.sourceHash!==support.image.source.sourceHash||
    support.evidenceId!==support.image.anchorEvidenceId||support.sha256!==support.image.sha256)throw new SourceCellBindingError('source-cell-image-binding-changed','evidence-selection');
   const native=observation.native??(observation.cellDeclarations?.status==='available'?observation.cellDeclarationWitness?.native:undefined);
   if(!native)return finish('native-cell-declarations-unavailable');
   const raw=(native.raw.data as {table_cells:Record<string,unknown>[]}).table_cells;
   if(cells.length+raw.length>SOURCE_VALUE_LIMITS.cells)return finish('catalog-cell-limit');
   const table:Table={id:`b${tables.length}`,imageId:support.id,observationIndex,source:structuredClone(observation.candidate.source),
    evidenceId:support.evidenceId,imageSha256:support.sha256,artifactSha256:observation.candidate.artifactSha256,observationSha256:observation.observationSha256,
    nativeSha256:observation.nativeSha256,physicalPage:observation.candidate.pageNumber,rawCellReferenceBasis:'native.raw.data.table_cells[index]',
    unknownPositions:observation.cellDeclarations?.status==='available'?structuredClone(observation.cellDeclarations.unknownPositions):[],
    gridStatus:observation.cellDeclarationWitness?.status??'available',semanticVerified:false,relationshipVerified:false,visibilityVerified:false};
   tables.push(table);
   raw.forEach((cell,index)=>{
    const row=cell.start_row_offset_idx as number,column=cell.start_col_offset_idx as number,
     flags=[cell.row_header===true,cell.column_header===true,cell.row_section===true];
    cells.push({id:`${table.id}/${index}`,tableId:table.id,index,row,column,
     rowSpan:(cell.row_span as number|undefined)??(cell.end_row_offset_idx as number)-row,
     columnSpan:(cell.col_span as number|undefined)??(cell.end_col_offset_idx as number)-column,
     headerRole:flags.filter(Boolean).length>1?'unknown':flags[0]?'row':flags[1]?'column':flags[2]?'section':
      [cell.row_header,cell.column_header,cell.row_section].every(v=>v===false)?'none':'unknown',
     text:native.cellTexts[index].text,rawCellSha256:sha(cell),bbox:structuredClone(cell.bbox??null)});
   });
  }
 }
 if(!cells.length)return finish('no-native-cell-declarations');
 const result=finish(null);
 if(Buffer.byteLength(canonical(result.wire))>SOURCE_VALUE_LIMITS.bytes)return finish('catalog-byte-limit');
 return result.wire.tables.some(t=>t.cells.some(c=>c.valuePath.status==='parser-derived'))?result:finish('no-bindable-cell-values');
}
function assertCatalog(catalog:SourceCellBindingCatalog){
 const rebuilt=prepareSourceCellBindingCatalog(catalog.sources);
 if(catalog.status!=='available'||rebuilt.status!=='available'||catalog.valuePathVersion!==SOURCE_CELL_VALUE_PATH_VERSION||catalog.catalogSha256!==rebuilt.catalogSha256||
  canonical([catalog.tables,catalog.cells,catalog.wire])!==canonical([rebuilt.tables,rebuilt.cells,rebuilt.wire]))
  throw new SourceCellBindingError('source-cell-catalog-changed','evidence-selection');
}
function binding(catalog:Pick<SourceCellBindingCatalog,'cells'|'tables'>,id:unknown,selectedIds:string[]):Binding{
 const value=catalog.cells.find(c=>c.id===id),table=value&&catalog.tables.find(t=>t.id===value.tableId);
 if(!value||!table||!selectedIds.includes(table.imageId))throw new SourceCellBindingError('source-cell-reference-outside-selected-input');
 if(value.headerRole!=='none'||value.rowSpan!==1||value.columnSpan!==1||!value.text.trim())
  throw new SourceCellBindingError('source-cell-value-not-explicit');
 const cells=catalog.cells.filter(c=>c.tableId===table.id),covers=(c:Cell)=>c.column<=value.column&&c.column+c.columnSpan>value.column;
 if(table.unknownPositions.some(([r,c])=>c===value.column&&r<=value.row||r===value.row&&c<=value.column)||
  cells.some(c=>c.headerRole==='unknown'&&(covers(c)&&c.row<value.row||c.row<=value.row&&c.row+c.rowSpan>value.row&&c.column<value.column)))
  throw new SourceCellBindingError('source-cell-header-path-unknown','structure-storage');
 const columns=cells.filter(c=>covers(c)&&['column','section'].includes(c.headerRole)&&c.text.trim()&&c.row<value.row),
  transpose=(c:Cell):Cell=>({...c,row:c.column,column:c.row,rowSpan:c.columnSpan,columnSpan:c.rowSpan,
   headerRole:c.headerRole==='row'?'column':c.headerRole==='column'?'row':c.headerRole}),rotated=cells.map(transpose),rotatedValue=transpose(value),
  rows=rotated.filter(c=>c.column<=rotatedValue.column&&c.column+c.columnSpan>rotatedValue.column&&
   ['column','section'].includes(c.headerRole)&&c.text.trim()&&c.row<rotatedValue.row);
 try{
  const columnIds=completeSourceValueColumnHeaders(cells,value,value,columns).map(c=>c.id),columnLabels=columnIds.map(id=>cells.find(c=>c.id===id)!),
   rowIds=completeSourceValueColumnHeaders(rotated,rotatedValue,rotatedValue,rows).map(c=>c.id),rowLabels=rowIds.map(id=>cells.find(c=>c.id===id)!);
  if(!rowLabels.length||!columnLabels.length)throw Error('Unknown complete label path');
  const bound={value:structuredClone(value),rowLabels:structuredClone(rowLabels),columnLabels:structuredClone(columnLabels),table:structuredClone(table)};
  if(render(bound).length+1>3000)throw new SourceCellBindingError('source-cell-render-limit');
  return bound;
 }catch(error){if(error instanceof SourceCellBindingError)throw error;
  throw new SourceCellBindingError('source-cell-header-path-unknown','structure-storage');}
}
const label=(cells:Cell[])=>cells.map(c=>JSON.stringify(c.text)).join(' / '),render=(b:Binding)=>`${label(b.rowLabels)} [${label(b.columnLabels)}]: ${b.value.text}`;
function declaredValuePath(catalog:Pick<SourceCellBindingCatalog,'cells'|'tables'>,cell:Cell,imageId:string):ValuePath{
 if(['row','column','section'].includes(cell.headerRole))return {status:'not-value'};
 try{const bound=binding(catalog,cell.id,[imageId]);return {status:'parser-derived',
  rowLabels:bound.rowLabels.map(c=>c.text),columnLabels:bound.columnLabels.map(c=>c.text)};
 }catch(error){if(!(error instanceof SourceCellBindingError))throw error;
  return {status:'unknown',reason:error.code,stage:error.stage};}
}
export function sourceCellBindingAnswerSchema(catalog:SourceCellBindingCatalog,selectedIds:string[]){
 assertCatalog(catalog);
 const imageIds=new Set(catalog.tables.map(t=>t.imageId)),statementIds=selectedIds.filter(id=>!imageIds.has(id)),
  valueIds=catalog.wire.tables.filter(t=>selectedIds.includes(t.imageId)).flatMap(t=>t.cells.filter(c=>c.valuePath.status==='parser-derived').map(c=>c.id));
 if(!valueIds.length)throw new SourceCellBindingError('source-cell-no-selected-values','evidence-selection');
 const cell={type:'string',enum:valueIds},
  object=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
 return object({status:{type:'string',enum:['answered','insufficient-evidence','conflicting-evidence']},message:{type:'string'},claims:{type:'array',maxItems:30,items:{anyOf:[
  object({kind:{type:'string',enum:['table-value']},valueRef:cell}),
  object({kind:{type:'string',enum:['table-difference']},leftValueRef:cell,rightValueRef:cell}),
  ...(statementIds.length?[object({kind:{type:'string',enum:['statement']},text:{type:'string'},citations:{type:'array',minItems:1,maxItems:20,items:object({id:{type:'string',enum:statementIds}})}})]:[])
 ]}}});
}
/** Decode only a NEW typed response. No old assertion repair or new model step.
 * Ordinary statements remain unverified generation; typed cells cannot rename
 * source labels, invent a value/result or acquire semantic verification. */
export function deriveSourceCellBindingAnswer(value:unknown,rawOutputText:string,catalog:SourceCellBindingCatalog,selectedIds:string[]):SourceCellDerivation{
 assertCatalog(catalog);
 if(canonical(JSON.parse(rawOutputText))!==canonical(value)||!exact(value,['status','message','claims']))throw new SourceCellBindingError('invalid-source-cell-result');
 const v=value as Selections;
 if(!['answered','insufficient-evidence','conflicting-evidence'].includes(v.status)||typeof v.message!=='string'||v.message.length>3000||
  !Array.isArray(v.claims)||v.claims.length>30||(v.status==='insufficient-evidence'?v.claims.length!==0:!v.claims.length||v.message!==''))
  throw new SourceCellBindingError('invalid-source-cell-result');
 const claims:Selections['claims']=[],operations:SourceCellDerivation['operations']=[],images=new Set(catalog.tables.map(t=>t.imageId));
 for(const [claimIndex,raw]of (v.claims as unknown[]).entries()){
  const op=raw as Record<string,unknown>;
  if(op?.kind==='statement'){
   if(!exact(op,['kind','text','citations'])||typeof op.text!=='string'||!op.text.trim()||op.text.length>3000||!Array.isArray(op.citations)||
    !op.citations.length||op.citations.length>20||op.citations.some(c=>!exact(c,['id'])||!selectedIds.includes(c.id)||images.has(c.id)))
    throw new SourceCellBindingError('invalid-source-cell-statement');
   claims.push({text:op.text,citations:structuredClone(op.citations) as {id:string}[]});continue;
  }
  if(op?.kind==='table-value'&&exact(op,['kind','valueRef'])){
   const bound=binding(catalog,op.valueRef,selectedIds),text=render(bound)+'.';
   claims.push({text,citations:[{id:bound.table.imageId}]});
   operations.push({claimIndex,kind:'table-value',bindings:[bound],arithmeticVerified:false,semanticVerified:false,relationshipVerified:false,visibilityVerified:false});continue;
  }
  if(op?.kind!=='table-difference'||!exact(op,['kind','leftValueRef','rightValueRef']))throw new SourceCellBindingError('invalid-source-cell-operation');
  const left=binding(catalog,op.leftValueRef,selectedIds),right=binding(catalog,op.rightValueRef,selectedIds),same=(a:Cell[],b:Cell[])=>canonical(a.map(c=>c.id))===canonical(b.map(c=>c.id));
  if(left.table.id!==right.table.id||left.value.id===right.value.id||!(left.value.column===right.value.column&&same(left.columnLabels,right.columnLabels)||
   left.value.row===right.value.row&&same(left.rowLabels,right.rowLabels)&&left.columnLabels.at(-1)!.text===right.columnLabels.at(-1)!.text))
   throw new SourceCellBindingError('source-cell-comparison-axis-or-metric-mismatch');
  let difference:string;try{difference=sourceDecimalDifference(left.value.text,right.value.text);}catch{throw new SourceCellBindingError('source-cell-decimal-not-explicit');}
  const text=`${render(left)}; ${render(right)}; printed-value difference (left minus right) = ${difference}.`;
  if(text.length>3000)throw new SourceCellBindingError('source-cell-render-limit');
  claims.push({text,citations:[{id:left.table.imageId}]});
  operations.push({claimIndex,kind:'table-difference',bindings:[left,right],difference,arithmeticVerified:true,semanticVerified:false,relationshipVerified:false,visibilityVerified:false});
 }
 const normalizedSelections={status:v.status,message:v.message,claims};
 return {method:'source-cell-bindings-v2',rawProviderResult:structuredClone(value),rawOutputText,rawOutputSha256:createHash('sha256').update(rawOutputText).digest('hex'),
  rawOperationSha256:sha(value),catalogSha256:catalog.catalogSha256,normalizedSelections,normalizedSelectionsSha256:sha(normalizedSelections),operations,semanticVerified:false,coverage:'unassessed'};
}
