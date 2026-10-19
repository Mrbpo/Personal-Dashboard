import {createHash} from 'node:crypto';
import {validateVisualPageContent,visualPageSearchText,VISUAL_BLOCK_LIMITS,type VisualPageContent,type VisualTableBlock,type VisualPageBinding} from './pdf-visual-blocks.ts';
import {PdfVisualStructureError,visualTextControlIssue} from './pdf-visual-structure.ts';
import type {LocalImageOcrObservation} from './local-ocr.ts';

export const PDF_NATIVE_GRID_VERSION='pdf-native-grid-v1';
export const PDF_NATIVE_GRID_RESPONSE_VERSION='pdf-native-grid-cells-v1';
type Box=[number,number,number,number];
export type PdfNativeGridFrame={rect:Box;mediaBox:Box;cropBox:Box;rotation:number};
export type PdfNativeGridObservation={version:typeof PDF_NATIVE_GRID_VERSION;sourceHash:string;physicalPage:number;
 frame:PdfNativeGridFrame;image:{sha256:string;width:number;height:number};producer:{name:string;version:string;policy:string};
 nativeObservationSha256:string;grids:Array<{id:string;bbox:Box;rowCount:number;columnCount:number;
 cells:Array<{id:string;row:number;column:number;rowSpan:number;columnSpan:number;bbox:Box}>}>;
 observations:{body:string;sha256:string};sidecarSha256:string};
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex'),digest=(v:unknown)=>hash(JSON.stringify(v));
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const integer=(v:unknown,min:number,max:number)=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max;
const hex=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id=(v:unknown)=>typeof v==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(v);
const short=(v:unknown)=>typeof v==='string'&&v.trim().length>0&&v.length<=256&&!visualTextControlIssue(v);
const box=(v:any):v is Box=>Array.isArray(v)&&v.length===4&&v.every(Number.isFinite)&&v[0]<v[2]&&v[1]<v[3];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const fail=(why:string):never=>{throw Error('Invalid native grid: '+why);};
const inside=(a:Box,b:Box)=>a[0]>=b[0]&&a[1]>=b[1]&&a[2]<=b[2]&&a[3]<=b[3];

export const PDF_NATIVE_GRID_PROMPT='\n原生物理格协议：附带网格仅为同源绘制几何候选，不是可见性、表头关系或文字真值。按整页真实阅读顺序输出 text 或 gridRef blocks，正文/标题/公式/图示/格外标签都要保留。每个给定 gridId 恰好一次、每个该网格的 cellId 恰好一次；只填格内实际可见 text/contentStatus/bold，不输出或修改行列数、索引、跨度、边框或坐标，不合并/新建格。'+
 'status=table 仅表示你认为原图该区域可按给定物理格读取，不证明语义；不是表或网格不可靠时用 not-table/uncertain，不猜分格。contentStatus=legible 要有非空原文，blank 仅当原图确实没有格内文字且 text=""；unreadable、OCR误字或不清楚时用 uncertain，不能把有OCR词视为可见值。'+
 '原生文字可能已被后续绘制覆盖；原生字符、OCR、几何和置信度均不受信，只能辅助核原PNG。不得复制已遮挡值、修OCR后冒充原件或推算空白。格外表头/Set等标签仍照抄在原位置的 text，禁止添加假表头行、角色或分组。columnLabels 仅另外记录你从同一原PNG观察到的列标题关联候选：每格网固定列ID依次c0到c(columnCount-1)，fromColumnId/toColumnId选择实际覆盖的连续闭区间，text逐字原标题；只记覆盖范围，不推父子层级或行组。status=observed需有候选，未见表头用none及空列表，不能确定时用uncertain；这些均非已证事实，不能只凭邻近猜关联。保留单元格内数学边界/下划线/上下标，未辨认则 uncertain。全部原页区域和五幅原图仍必须审读，不因网格存在而只答表格。';

function schema(observation:PdfNativeGridObservation){
 const defs:Record<string,any>={text:{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['text']},text:{type:'string',maxLength:100000}},required:['kind','text']},
  bold:{type:'string',enum:['all','none','mixed','uncertain']},contentStatus:{type:'string',enum:['legible','blank','uncertain']},gridStatus:{type:'string',enum:['table','uncertain','not-table']}};
 const alternatives:any[]=[{$ref:'#/$defs/text'}];
 observation.grids.forEach((g,i)=>{
  defs['column'+i]={type:'string',enum:Array.from({length:g.columnCount},(_,n)=>'c'+n)};
  defs['label'+i]={type:'object',additionalProperties:false,properties:{fromColumnId:{$ref:'#/$defs/column'+i},toColumnId:{$ref:'#/$defs/column'+i},text:{type:'string',maxLength:4096}},required:['fromColumnId','toColumnId','text']};
  defs['cell'+i]={type:'object',additionalProperties:false,properties:{cellId:{type:'string',enum:g.cells.map(c=>c.id)},text:{type:'string',maxLength:4096},contentStatus:{$ref:'#/$defs/contentStatus'},bold:{$ref:'#/$defs/bold'}},required:['cellId','text','contentStatus','bold']};
  defs['grid'+i]={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['gridRef']},gridId:{type:'string',enum:[g.id]},status:{$ref:'#/$defs/gridStatus'},cells:{type:'array',minItems:1,maxItems:g.cells.length,items:{$ref:'#/$defs/cell'+i}},columnLabels:{type:'object',additionalProperties:false,properties:{status:{type:'string',enum:['observed','none','uncertain']},labels:{type:'array',maxItems:128,items:{$ref:'#/$defs/label'+i}}},required:['status','labels']}},required:['kind','gridId','status','cells','columnLabels']};
  alternatives.push({$ref:'#/$defs/grid'+i});
 });
 const result={type:'object',additionalProperties:false,properties:{complete:{type:'boolean'},uncertain_spans:{type:'array',maxItems:100,items:{type:'string',maxLength:1000}},blocks:{type:'array',minItems:1,maxItems:128,items:{anyOf:alternatives}}},required:['complete','uncertain_spans','blocks'],$defs:defs};
 let enumCount=0,strings=0;
 const visit=(v:any)=>{if(typeof v==='string'){strings+=v.length;return;}if(!v||typeof v!=='object')return;
  if(Array.isArray(v.enum)){enumCount+=v.enum.length;if(v.enum.length>250&&v.enum.reduce((n:number,s:unknown)=>n+(typeof s==='string'?s.length:0),0)>15000)fail('schema enum-string capacity');}
  for(const [k,x]of Object.entries(v)){strings+=k.length;visit(x);}};
 visit(result);if(enumCount>1000||strings>120000)fail('schema capacity; no truncated grid');return result;
}

/** Explicit administrator input, not an automatic producer or an authenticity/visibility proof. */
export function validatePdfNativeGridObservation(value:unknown,expected?:{sourceHash:string;physicalPage:number;frame:PdfNativeGridFrame}):PdfNativeGridObservation{
 const v=value as PdfNativeGridObservation;
 if(!exact(v,['version','sourceHash','physicalPage','frame','image','producer','nativeObservationSha256','grids','observations','sidecarSha256'])||v.version!==PDF_NATIVE_GRID_VERSION||!hex(v.sourceHash)||!integer(v.physicalPage,1,100000)||!hex(v.nativeObservationSha256)||!hex(v.sidecarSha256))fail('source/envelope');
 const f=v.frame;
 if(!exact(f,['rect','mediaBox','cropBox','rotation'])||!box(f.rect)||f.rect[0]!==0||f.rect[1]!==0||f.rotation!==0||!same(f.rect,f.mediaBox)||!same(f.rect,f.cropBox))fail('unsupported frame');
 if(expected&&(v.sourceHash!==expected.sourceHash||v.physicalPage!==expected.physicalPage||f.rotation!==expected.frame.rotation||!same(f.rect,expected.frame.rect)||!same(f.mediaBox,expected.frame.mediaBox)||!same(f.cropBox,expected.frame.cropBox)))fail('actual PDF source/frame mismatch');
 if(!exact(v.image,['sha256','width','height'])||!hex(v.image.sha256)||!integer(v.image.width,1,2500)||!integer(v.image.height,1,2500)||Math.abs(v.image.width/v.image.height-f.rect[2]/f.rect[3])>1e-6)fail('image/frame');
 if(!exact(v.producer,['name','version','policy'])||![v.producer.name,v.producer.version,v.producer.policy].every(short))fail('producer');
 if(!exact(v.observations,['body','sha256'])||typeof v.observations.body!=='string'||Buffer.byteLength(v.observations.body)>200000||!hex(v.observations.sha256)||hash(v.observations.body)!==v.observations.sha256)fail('observation bytes/hash');
 try{const body=JSON.parse(v.observations.body);if(!body||typeof body!=='object'||Array.isArray(body))fail('observation JSON object');}catch{fail('observation JSON object');}
 if(!Array.isArray(v.grids)||!v.grids.length||v.grids.length>VISUAL_BLOCK_LIMITS.tables)fail('grids capacity');
 const ids=new Set<string>();let count=0;
 for(const g of v.grids){
  if(!exact(g,['id','bbox','rowCount','columnCount','cells'])||!id(g.id)||ids.has(g.id)||!box(g.bbox)||!inside(g.bbox,f.rect)||!integer(g.rowCount,1,100)||!integer(g.columnCount,1,64)||!Array.isArray(g.cells)||!g.cells.length||g.cells.length>2048||(count+=g.cells.length)>4096)fail('grid shape/capacity');ids.add(g.id);
  const occupied=Array.from({length:g.rowCount},()=>Array(g.columnCount).fill(false)),xs:Array<number|undefined>=Array(g.columnCount+1),ys:Array<number|undefined>=Array(g.rowCount+1);
  const boundary=(list:Array<number|undefined>,i:number,n:number)=>{if(list[i]!==undefined&&list[i]!==n)fail('inconsistent physical boundaries');list[i]=n;};
  for(const c of g.cells){
   if(!exact(c,['id','row','column','rowSpan','columnSpan','bbox'])||!id(c.id)||ids.has(c.id)||!integer(c.row,0,g.rowCount-1)||!integer(c.column,0,g.columnCount-1)||!integer(c.rowSpan,1,g.rowCount)||!integer(c.columnSpan,1,g.columnCount)||c.row+c.rowSpan>g.rowCount||c.column+c.columnSpan>g.columnCount||!box(c.bbox)||!inside(c.bbox,g.bbox))fail('cell source geometry');ids.add(c.id);
   boundary(xs,c.column,c.bbox[0]);boundary(xs,c.column+c.columnSpan,c.bbox[2]);boundary(ys,c.row,c.bbox[1]);boundary(ys,c.row+c.rowSpan,c.bbox[3]);
   for(let r=c.row;r<c.row+c.rowSpan;r++)for(let col=c.column;col<c.column+c.columnSpan;col++){if(occupied[r][col])fail('overlapping physical slots');occupied[r][col]=true;}
  }
  if(occupied.some(row=>row.some(slot=>!slot))||xs[0]!==g.bbox[0]||xs.at(-1)!==g.bbox[2]||ys[0]!==g.bbox[1]||ys.at(-1)!==g.bbox[3]||
   Array.from(xs).some((n,i)=>n===undefined||(i>0&&n<=xs[i-1]!))||Array.from(ys).some((n,i)=>n===undefined||(i>0&&n<=ys[i-1]!)))fail('incomplete physical boundaries/slots');
 }
 for(let i=0;i<v.grids.length;i++)for(let j=i+1;j<v.grids.length;j++){const a=v.grids[i].bbox,b=v.grids[j].bbox;if(Math.min(a[2],b[2])>Math.max(a[0],b[0])&&Math.min(a[3],b[3])>Math.max(a[1],b[1]))fail('overlapping grid candidates');}
 const {sidecarSha256,...unsigned}=v;if(digest(unsigned)!==sidecarSha256||Buffer.byteLength(JSON.stringify(v))>1024*1024)fail('sidecar identity/capacity');schema(v);return v;
}
export function assertPdfNativeGridImage(value:PdfNativeGridObservation,png:Uint8Array):void{
 const b=Buffer.from(png);if(b.length<24||b.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||hash(b)!==value.image.sha256||b.readUInt32BE(16)!==value.image.width||b.readUInt32BE(20)!==value.image.height)fail('actual overview PNG mismatch');
}
export const nativeGridResponseSchema=(value:PdfNativeGridObservation)=>schema(validatePdfNativeGridObservation(value));
export const nativeGridInputText=(value:PdfNativeGridObservation)=>'Untrusted source-bound physical grid observations; native text may be covered and OCR may be false. Coordinates use the original full overview top-left page frame, not detail-view pixels. Header/group associations and visibility are unassessed.\n'+JSON.stringify(value);
export function nativeGridCacheParser(baseParser:string,value:PdfNativeGridObservation):string{
 return PDF_NATIVE_GRID_RESPONSE_VERSION+':'+digest({baseParser,sidecarSha256:value.sidecarSha256,schemaSha256:digest(nativeGridResponseSchema(value)),promptSha256:hash(PDF_NATIVE_GRID_PROMPT)});
}

export function derivePdfNativeGridPage(rawOutput:string,observation:PdfNativeGridObservation){
 validatePdfNativeGridObservation(observation);if(typeof rawOutput!=='string'||rawOutput.length>200000)fail('response capacity');
 const value=JSON.parse(rawOutput);
 if(!exact(value,['complete','uncertain_spans','blocks'])||value.complete!==true||!Array.isArray(value.uncertain_spans)||value.uncertain_spans.length>100||value.uncertain_spans.some((s:unknown)=>typeof s!=='string'||s.length>1000||visualTextControlIssue(s))||!Array.isArray(value.blocks)||!value.blocks.length||value.blocks.length>128)fail('incomplete response/envelope');
 const grids=new Map(observation.grids.map(g=>[g.id,g])),seen=new Set<string>(),blocks:VisualPageContent['blocks']=[],searchParts:string[]=[],columnLabelObservations:Array<{gridId:string;status:string;provenance:'ai-derived-unverified';labels:Array<{fromColumnId:string;toColumnId:string;text:string}>}>=[];
 for(const block of value.blocks){
  if(block?.kind==='text'){
   const textPage=validateVisualPageContent({complete:true,uncertain_spans:[],blocks:[block]});blocks.push(textPage.blocks[0]);searchParts.push(visualPageSearchText(textPage));continue;
  }
  if(!exact(block,['kind','gridId','status','cells','columnLabels'])||block.kind!=='gridRef'||!grids.has(block.gridId)||seen.has(block.gridId)||block.status!=='table'||!Array.isArray(block.cells))fail('unknown/duplicate/uncertain/not-table grid reference');
  const g=grids.get(block.gridId)!,byId=new Map(g.cells.map(c=>[c.id,c])),used=new Set<string>();seen.add(g.id);
  const labelSet=block.columnLabels,columns=Array.from({length:g.columnCount},(_,i)=>'c'+i);
  if(!exact(labelSet,['status','labels'])||!['observed','none','uncertain'].includes(labelSet.status)||!Array.isArray(labelSet.labels)||labelSet.labels.length>128||
   (labelSet.status==='observed'&&!labelSet.labels.length)||(labelSet.status==='none'&&labelSet.labels.length))fail('column-label status');
  for(const label of labelSet.labels){
   if(!exact(label,['fromColumnId','toColumnId','text'])||!columns.includes(label.fromColumnId)||!columns.includes(label.toColumnId)||columns.indexOf(label.fromColumnId)>columns.indexOf(label.toColumnId)||typeof label.text!=='string'||label.text.length>4096)fail('column-label source range');
   validateVisualPageContent({complete:true,uncertain_spans:[],blocks:[{kind:'text',text:label.text}]});
  }
  const labels=labelSet.labels.map((label:any)=>({...label}));columnLabelObservations.push({gridId:g.id,status:labelSet.status,provenance:'ai-derived-unverified',labels});
  if(block.cells.length!==g.cells.length)fail('missing/extra source cells');
  const annotations=new Map<string,any>();
  for(const c of block.cells){
   if(!exact(c,['cellId','text','contentStatus','bold'])||!byId.has(c.cellId)||used.has(c.cellId)||!['legible','blank'].includes(c.contentStatus)||typeof c.text!=='string'||c.text.length>4096||!['all','none','mixed','uncertain'].includes(c.bold)||
    (c.contentStatus==='blank'?c.text!=='':!c.text.trim()))fail('unknown/duplicate/uncertain cell content');used.add(c.cellId);annotations.set(c.cellId,c);
  }
  const table:VisualTableBlock={kind:'table',rowCount:g.rowCount,columnCount:g.columnCount,cells:g.cells.map(c=>{const a=annotations.get(c.id);return {row:c.row,column:c.column,rowSpan:c.rowSpan,columnSpan:c.columnSpan,headerRole:'none',text:a.text,bold:a.bold};})};
  validateVisualPageContent({complete:true,uncertain_spans:[],blocks:[table]});blocks.push(table);
  const parts=[`Source-bound physical grid ${g.id}; physicalPage=${observation.physicalPage}; sourceHash=${observation.sourceHash}; sidecar=${observation.sidecarSha256}; header/group associations=unassessed; visibility=unverified; semantic table verification=false.`];
  parts.push(`AI-derived column-label observations; status=${labelSet.status==='none'?'model-asserted-none':labelSet.status}; provenance=unverified; hierarchy=unassessed; group associations=unassessed.`);
  for(const c of g.cells){const a=annotations.get(c.id);parts.push(`Physical cell ${c.id}; row=${c.row}; column=${c.column}; span=${c.rowSpan}x${c.columnSpan}; bbox=${JSON.stringify(c.bbox)}; contentStatus=${a.contentStatus}; bold=${a.bold}; header/group associations=unassessed.`);
   const applicable=labels.filter((h:any)=>columns.indexOf(h.fromColumnId)<c.column+c.columnSpan&&columns.indexOf(h.toColumnId)>=c.column);
   for(const h of applicable)parts.push(`AI-derived unverified column-label candidate (${h.fromColumnId}..${h.toColumnId}; no inferred hierarchy) [UTF-8 bytes=${Buffer.byteLength(h.text)}]\n${h.text}`);
   parts.push(`Value [UTF-8 bytes=${Buffer.byteLength(a.text)}]\n${a.text}`);}
  searchParts.push(parts.join('\n'));
 }
 if(seen.size!==observation.grids.length)fail('unprovided source grid');
 const content=validateVisualPageContent({complete:true,uncertain_spans:value.uncertain_spans,blocks});
 const prefix=value.uncertain_spans.length?visualPageSearchText({complete:true,uncertain_spans:value.uncertain_spans,blocks:[{kind:'text',text:'[Source-bound physical grid derivation; not verified source visibility or semantics.]'}]})+'\n\n':'';
 const searchText=prefix+searchParts.join('\n\n');if(searchText.length>100000)fail('derived search capacity; no truncation');
 return {version:PDF_NATIVE_GRID_RESPONSE_VERSION,sidecarSha256:observation.sidecarSha256,content,searchText,columnLabelObservations,headerGroupAssociations:'unassessed' as const,visibilityVerified:false,semanticTableVerified:false};
}

function checkOcr(ocr:LocalImageOcrObservation,value:PdfNativeGridObservation){
 if(ocr?.image!==null&&(!ocr?.image||ocr.image.sha256!==value.image.sha256||ocr.image.width!==value.image.width||ocr.image.height!==value.image.height))fail('OCR image binding');
 if(ocr?.status==='available'){if(!ocr.image||ocr.engine!=='tesseract'||ocr.language!=='eng+chi_sim'||typeof ocr.tsv!=='string'||Buffer.byteLength(ocr.tsv)>256*1024||!ocr.tsv.startsWith('level\tpage_num\t')||hash(ocr.tsv)!==ocr.tsvSha256)fail('OCR identity');}
 else if(ocr?.status!=='unavailable'||!short(ocr.reason))fail('OCR unavailable status');
}
export function encodePdfNativeGridCache(binding:VisualPageBinding,value:PdfNativeGridObservation,requestSha256:string,ocr:LocalImageOcrObservation,rawOutput:string):string{
 if(!hex(requestSha256)||binding.sourceHash!==value.sourceHash||binding.physicalPage!==value.physicalPage||!binding.parser.startsWith(PDF_NATIVE_GRID_RESPONSE_VERSION+':'))fail('request/source identity');checkOcr(ocr,value);const derivation=derivePdfNativeGridPage(rawOutput,value);
 const artifact={version:PDF_NATIVE_GRID_RESPONSE_VERSION,binding,sidecar:value,requestSha256,ocr,rawOutput,rawOutputSha256:hash(rawOutput),derivation};return JSON.stringify({...artifact,artifactSha256:digest(artifact)});
}
export function readPdfNativeGridCache(body:string,binding:VisualPageBinding,value:PdfNativeGridObservation,requestSha256:string){
 try{
  const cache=JSON.parse(body),{artifactSha256,...artifact}=cache;
  if(cache.version!==PDF_NATIVE_GRID_RESPONSE_VERSION||binding.sourceHash!==value.sourceHash||binding.physicalPage!==value.physicalPage||!binding.parser.startsWith(PDF_NATIVE_GRID_RESPONSE_VERSION+':')||!same(cache.binding,binding)||!same(cache.sidecar,value)||cache.requestSha256!==requestSha256||!hex(requestSha256)||typeof cache.rawOutput!=='string'||cache.rawOutputSha256!==hash(cache.rawOutput)||artifactSha256!==digest(artifact))fail('cache identity');
  checkOcr(cache.ocr,value);const derived=derivePdfNativeGridPage(cache.rawOutput,value);if(!same(cache.derivation,derived))fail('cache derivation');return derived;
 }catch(error){throw new PdfVisualStructureError(`原生格缓存无效：${(error as Error).message}；原值保留，不重新请求`,'PDF_VISUAL_TEXT_STRUCTURE_INVALID',body,'cached-page-text');}
}
