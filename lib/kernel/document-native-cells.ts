import {createHash} from 'node:crypto';
import type {NativeTableArtifact} from './document-table-candidates.ts';

export const NATIVE_CELL_DECLARATION_VERSION='native-cell-declarations-v1';
export const NATIVE_CELL_DECLARATION_LIMITS=Object.freeze({cells:256});
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
 ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const sha=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
type OffsetTuple=[number,number|null,number|null];
export type NativeCellDeclaration={row:OffsetTuple;column:OffsetTuple;headerFlags:[boolean|null,boolean|null,boolean|null];
 texts:[string,string|null,string|null];bbox:unknown;rawCellSha256:string};
type Base={version:typeof NATIVE_CELL_DECLARATION_VERSION;authority:'parser-declared-untrusted';
 nativeSha256:string;gridStatus:NativeTableArtifact['status'];gridReasons:string[];declaredCellCount:number;
 semanticVerified:false;relationshipVerified:false;visibilityVerified:false;coordinateMapping:'unverified'};
export type NativeCellDeclarations=Base&({status:'unavailable';reason:'cell-limit'|'byte-limit'}|
 {status:'available';reason:null;cellReferenceBasis:'native.raw.data.table_cells[index]';
 offsetTuple:['start-offset','end-offset-or-null','span-or-null'];headerFlagTuple:['row_header','column_header','row_section'];
 textTuple:['cellTexts[index].text','raw.text-or-null','raw.orig-or-null'];
 rawGridReference:'native.raw.data.grid';rawGridTransport:'retained-in-immutable-artifact';
 cells:NativeCellDeclaration[];unknownPositions:number[][];rawTableMetadata:Record<string,unknown>;
 rawDataMetadata:Record<string,unknown>;captions:NativeTableArtifact['native']['captions']});

/** Called only with a current artifact validated by prepareNativeTableObservation.
 * Lossless for the declared fields, including original per-cell geometry.
 * Missing offsets/flags/text variants remain null. A grid is never repaired or
 * elected as truth; omitted duplicate grid/other raw fields remain in the CAS. */
export function prepareNativeCellDeclarations(artifact:NativeTableArtifact,maxBytes:number):NativeCellDeclarations{
 const native=artifact.native,data=native.raw.data as Record<string,unknown>,rawCells=data.table_cells as Record<string,unknown>[],
  base:Base={version:NATIVE_CELL_DECLARATION_VERSION,authority:'parser-declared-untrusted',nativeSha256:sha(native),
   gridStatus:artifact.status,gridReasons:[...artifact.reasons],declaredCellCount:rawCells.length,
   semanticVerified:false,relationshipVerified:false,visibilityVerified:false,coordinateMapping:'unverified'};
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw Error('Invalid native cell declaration allowance');
 const unavailable=(reason:'cell-limit'|'byte-limit'):NativeCellDeclarations=>({...base,status:'unavailable',reason});
 if(rawCells.length>NATIVE_CELL_DECLARATION_LIMITS.cells)return unavailable('cell-limit');
 const occupied=new Set<string>(),cells=rawCells.map((raw,index):NativeCellDeclaration=>{
  const row=raw.start_row_offset_idx as number,column=raw.start_col_offset_idx as number,
   endRow=(raw.end_row_offset_idx??row+(raw.row_span as number)) as number,
   endColumn=(raw.end_col_offset_idx??column+(raw.col_span as number)) as number;
  for(let r=row;r<endRow;r++)for(let c=column;c<endColumn;c++)occupied.add(`${r}:${c}`);
  return {row:[row,(raw.end_row_offset_idx as number|undefined)??null,(raw.row_span as number|undefined)??null],
   column:[column,(raw.end_col_offset_idx as number|undefined)??null,(raw.col_span as number|undefined)??null],
   headerFlags:['row_header','column_header','row_section'].map(key=>raw[key]??null) as NativeCellDeclaration['headerFlags'],
   texts:[native.cellTexts[index].text,typeof raw.text==='string'?raw.text:null,typeof raw.orig==='string'?raw.orig:null],
   bbox:structuredClone(raw.bbox??null),rawCellSha256:sha(raw)};
 });
 const unknownPositions:number[][]=[];
 for(let r=0;r<(data.num_rows as number);r++)for(let c=0;c<(data.num_cols as number);c++)
  if(!occupied.has(`${r}:${c}`))unknownPositions.push([r,c]);
 const {data:_data,...rawTableMetadata}=native.raw,{table_cells:_cells,grid:_grid,...rawDataMetadata}=data;
 const value:NativeCellDeclarations={...base,status:'available',reason:null,
  cellReferenceBasis:'native.raw.data.table_cells[index]',offsetTuple:['start-offset','end-offset-or-null','span-or-null'],
  headerFlagTuple:['row_header','column_header','row_section'],textTuple:['cellTexts[index].text','raw.text-or-null','raw.orig-or-null'],
  rawGridReference:'native.raw.data.grid',rawGridTransport:'retained-in-immutable-artifact',
  cells,unknownPositions,rawTableMetadata:structuredClone(rawTableMetadata),rawDataMetadata:structuredClone(rawDataMetadata),captions:structuredClone(native.captions)};
 return Buffer.byteLength(canonical(value))<=maxBytes?value:unavailable('byte-limit');
}
