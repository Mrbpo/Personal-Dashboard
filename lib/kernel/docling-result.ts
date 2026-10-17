import {assessPdfFormulaPreservation} from '../pdf-formulas.ts';
import {DOCLING_SOURCE_MATH_VERSION,doclingMathRaw,type DoclingMathNode,type DoclingSourceMath} from './docling-source-math.ts';
/** Decode Docling's document tree, whose references carry reading order and PDF provenance. */
export const DOCLING_PARSER_VERSION = 'docling-v3-source-preserved-search';
export const DOCLING_TEXT_PARSER_VERSION = 'docling-v3-source-preserved-text-search';
export function configuredDoclingParser(): string {
  return process.env.DOCLING_FORMULA_ENRICHMENT === 'false' ? DOCLING_TEXT_PARSER_VERSION : DOCLING_PARSER_VERSION;
}
export type DoclingPage = { locator: string; text: string; pageNumber: number };
export type DoclingRegion={pictureRef:string;pageNumber:number;derivedPageNumber:number;
 pageSize:{width:number;height:number};bbox:{l:number;t:number;r:number;b:number;coord_origin:'BOTTOMLEFT'|'TOPLEFT'};
 textReferences:Array<{ref:string;parentRef:string|null;text:string;provenance:unknown[]}>;
 resultBlobSha256?:string;derivedInputSha256?:string;copyIndices?:number[]};
export type DoclingVisualLayout={status:'available'|'unavailable';regions:DoclingRegion[];
 pageSizes:Array<{pageNumber:number;width:number;height:number}>;reason?:string;
 unavailablePictures?:Array<{pictureRef:string;provenance:unknown[]}>;
 resultReferences?:Array<{resultBlobSha256:string;derivedInputSha256:string;copyIndices:number[]}>};
/** Native parser output only. Raw fields and strings remain unchanged; this is
 * not original quotation evidence or a canonical fact. */
export type DoclingNativeTable = {reference:string;pageNumbers:number[];raw:Record<string,unknown>;
  cellTexts:Array<{cellIndex:number;text:string}>;captions:Array<{reference:string;raw:Record<string,unknown>}>;
  result?:{resultBlobSha256:string;derivedInputSha256:string;optionsHash:string;copyIndices:number[]}};
type Json = Record<string, unknown>;

function object(value: unknown): Json | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined;
}
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
// Orig is source extraction, not enriched LaTeX. Keep it verbatim when the
// normalized text is empty; otherwise valid source content would disappear.
function nodeContent(node: Json): string {
  return text(node.text) ? node.text as string : text(node.orig) ? node.orig as string : '';
}

const nodeReference=/^#\/(texts|tables|pictures|groups|key_value_items|form_items|field_regions|field_items)\/\d+$/;
function resolveNode(document:Json,reference:unknown):{ref:string;node:Json}{
  const ref=object(reference)?.$ref;
  if(typeof ref!=='string'||!nodeReference.test(ref))throw new Error('Docling contains an invalid document reference');
  const [,collection,index]=ref.split('/'),node=object(list(document[collection])[Number(index)]);
  if(!node)throw new Error(`Docling reference does not exist: ${ref}`);
  return {ref,node};
}

export function decodeDoclingResult(result: unknown, expectedPages?: number, options: {verifiedBlankPages?: number[];formulaEnriched?:boolean;pageRange?:readonly [number,number]} = {}): {pages: DoclingPage[]; totalPages: number; warnings: string[];formulaPageNumbers:number[];visualLayout:DoclingVisualLayout;nativeTables:DoclingNativeTable[];sourceMath?:DoclingSourceMath[]} {
  const response = object(result);
  if (response?.status !== 'success') throw new Error(`Docling conversion is incomplete (${response?.status || 'missing status'})`);
  if (list(response.errors).length) throw new Error('Docling reported conversion errors');
  const document = object(object(response.document)?.json_content);
  if (!document) throw new Error('Docling returned no structured document with page provenance');
  const manifest = object(document.pages);
  const pageNumbers = Object.entries(manifest || {}).map(([key, value]) => {
    const page = object(value);
    const number = Number(key);
    if (!Number.isInteger(number) || number < 1 || page?.page_no !== number) throw new Error('Docling has invalid PDF page metadata');
    return number;
  }).sort((a, b) => a - b);
  const totalPages = expectedPages ?? pageNumbers.length;
  const [first,last]=options.pageRange??[1,totalPages];
  // Ranged responses must retain original PDF page numbers. Never infer an offset
  // from a locally renumbered response or accept pages outside the requested range.
  if (!Number.isInteger(totalPages) || totalPages < 1 || !Number.isInteger(first)||!Number.isInteger(last)||
    first<1||last<first||last>totalPages||pageNumbers.length!==last-first+1||
    pageNumbers.some((number, index) => number !== index + first)) {
    throw new Error('Docling page manifest is incomplete');
  }
  const body = object(document.body);
  if (!body || !Array.isArray(body.children)) throw new Error('Docling returned no document reading order');
  const parts = new Map(pageNumbers.map(number => [number, [] as string[]]));
  const occupied = new Set<number>();
  const visited = new Set<string>();
  const warnings: string[] = [];
  const sourceFallback=new WeakSet<Json>(),selectedContent=new WeakMap<Json,string>();
  function content(node:Json):string{
    const known=selectedContent.get(node);if(known!==undefined)return known;
    let value=nodeContent(node);
    if(node.label==='formula'&&text(node.orig)&&text(node.text)){
      const assessment=assessPdfFormulaPreservation(node.orig as string,node.text as string);
      if(assessment.status!=='characters-preserved'){
        value=node.orig as string;sourceFallback.add(node);
        warnings.push(`公式增强未通过原字符保留检查（${assessment.status}: ${assessment.reason}）；保留完整原始抽取文本，未验证公式语义和上下标`);
      }
    }
    selectedContent.set(node,value);return value;
  }
  const formulaPageNumbers=new Set<number>();
  const nativeTables:DoclingNativeTable[]=[];
  const mathNodes=new Map<string,DoclingMathNode>();
  if(options.formulaEnriched === false) warnings.push('公式增强未启用；正文可检索，公式须核对原 PDF');
  const verifiedBlankPages = new Set(options.verifiedBlankPages || []);
  const regions:DoclingRegion[]=[];
  const unavailablePictures:NonNullable<DoclingVisualLayout['unavailablePictures']>=[];

  function resolve(reference: unknown): {ref: string; node: Json} {
    return resolveNode(document!,reference);
  }

  function provenance(node: Json): Json[] {
    const values = list(node.prov).map(value => object(value));
    if (!values.length || values.some(value => !value || !Number.isInteger(value.page_no) || !parts.has(value.page_no as number))) {
      throw new Error(`Docling item has missing or invalid page provenance (${node.self_ref || node.label || 'unknown'})`);
    }
    return values as Json[];
  }

  function add(node: Json, content: string): void {
    const locations = provenance(node);
    for (const location of locations) occupied.add(location.page_no as number);
    if (!content) return;
    const numbers = new Set(locations.map(location => location.page_no));
    if (numbers.size === 1) {
      parts.get(locations[0].page_no as number)!.push(content);
      return;
    }
    // Spanning text must have valid, complete character ranges; do not guess a page.
    let consumed = 0;
    for (const location of locations) {
      const span = list(location.charspan);
      const [start, end] = span;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start !== consumed || (end as number) <= (start as number) || (end as number) > content.length) {
        throw new Error('Docling spanning item has ambiguous page character ranges');
      }
      parts.get(location.page_no as number)!.push(content.slice(start as number, end as number));
      consumed = end as number;
    }
    if (consumed !== content.length) throw new Error('Docling spanning item loses text between pages');
  }

  function noteFormula(node: Json): void {
    if(node.label!=='formula')return;
    content(node);
    const locations=provenance(node);
    for(const location of locations)formulaPageNumbers.add(location.page_no as number);
    if((!text(node.text)||sourceFallback.has(node))&&text(node.orig))warnings.push(`第 ${locations[0].page_no} 页公式保留原始抽取文本；未验证 LaTeX、符号和上下标，请核对原 PDF`);
    // Enrichment describes execution, not source fidelity. A nonempty model
    // result (including valid-looking LaTeX) has not been checked against print.
    else if(text(node.text))for(const location of locations)warnings.push(`第 ${location.page_no} 页机器公式未核验符号和上下标，请核对原 PDF`);
  }

  const script=(node:Json)=>object(node.formatting)?.script;
  const isInline=(node:Json)=>node.label==='inline';
  const escape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  function noteMath(ref:string,node:Json,ancestors:Set<string>,role:DoclingMathNode['role'],numbers:number[]){
    if(node.self_ref!==undefined&&node.self_ref!==ref)throw Error('Docling math self reference differs');
    mathNodes.set(ref,{reference:ref,path:[...ancestors,ref],role,raw:doclingMathRaw(node),
      derivedPageNumbers:[...new Set(numbers)],pageNumbers:[...new Set(numbers)]});
    if(mathNodes.size>10000)throw Error('Docling source math exceeds node limit');
  }
  // Only an explicit native InlineGroup permits inline concatenation. Do not
  // infer a base or a math mode from proximity, font size or flattened strings.
  function inline(reference:unknown,ancestors:Set<string>):Map<number,string>{
    const {ref,node}=resolve(reference);
    if(ancestors.has(ref)||ancestors.size>=128||visited.has(ref))throw Error('Docling inline order is cyclic or shared');
    visited.add(ref);const next=new Set([...ancestors,ref]),output=new Map<number,string>();
    if(ref.startsWith('#/groups/')&&isInline(node)){
      if(content(node).trim())throw Error('Docling inline container has ambiguous own text');
      for(const child of list(node.children))for(const [page,value]of inline(child,next))output.set(page,(output.get(page)||'')+value);
      noteMath(ref,node,ancestors,'inline-group',[...output.keys()]);return output;
    }
    if(!ref.startsWith('#/texts/'))throw Error('Unsupported Docling inline child; original raw retained');
    const children=list(node.children);
    if(children.length){
      if(content(node).trim()||children.length!==1||!isInline(resolve(children[0]).node))throw Error('Docling inline parent content is ambiguous');
      const nested=inline(children[0],next);noteMath(ref,node,ancestors,'inline-text',[...nested.keys()]);return nested;
    }
    const locations=provenance(node),numbers=[...new Set(locations.map(p=>p.page_no as number))];
    if(numbers.length!==1)throw Error('Docling inline span has ambiguous page boundaries');
    noteFormula(node);const formula=node.label==='formula',fallback=(!text(node.text)||sourceFallback.has(node))&&Boolean(text(node.orig));
    let value=content(node);
    // Reuse orig fallback for empty/blank normalized text, then retain literal
    // whitespace only when neither field contains readable source content.
    if(!formula&&!value)value=typeof node.text==='string'&&node.text.length?node.text:typeof node.orig==='string'?node.orig:'';
    if(formula&&!value.trim()&&options.formulaEnriched!==false)throw Error('Docling inline formula has no readable LaTeX');
    if(formula&&value&&!fallback&&options.formulaEnriched!==false)value=`\\(${value}\\)`;
    const position=script(node);
    if(position==='sub'||position==='super')value=`<${position==='sub'?'sub':'sup'}>${escape(value)}</${position==='sub'?'sub':'sup'}>`;
    else if(position!==undefined&&position!==null&&position!=='baseline')warnings.push('行内脚本角色未知；保留原字符串，未推断上下标');
    for(const number of numbers)occupied.add(number);
    output.set(numbers[0],value);noteMath(ref,node,ancestors,formula?'inline-formula':position==='sub'||position==='super'?'script':'inline-text',numbers);
    return output;
  }

  function cellText(cell: Json, ancestors: Set<string>, tablePages: Set<unknown>): string {
    if (!cell.ref) return content(cell);
    const collect = (reference: unknown, stack: Set<string>): string => {
      const {ref, node} = resolve(reference);
      if (stack.has(ref)) throw new Error('Docling document references contain a cycle');
      if(ref.startsWith('#/groups/')&&isInline(node)){
        const output=inline(reference,stack);
        if([...output.keys()].some(page=>!tablePages.has(page)))throw Error('Docling rich inline cell page is ambiguous');
        return [...output.values()].join(' ');
      }
      visited.add(ref);
      const next = new Set([...stack, ref]);
      if (!ref.startsWith('#/groups/')) {
        if (provenance(node).some(location => !tablePages.has(location.page_no))) throw new Error('Docling rich table cell has ambiguous page provenance');
        noteFormula(node);
        if(node.label==='formula'||script(node)==='sub'||script(node)==='super')noteMath(ref,node,stack,
          node.label==='formula'?'unscoped-formula':'script',provenance(node).map(p=>p.page_no as number));
      }
      return [content(node), ...list(node.children).map(child => collect(child, next))].filter(Boolean).join(' ');
    };
    return collect(cell.ref, ancestors) || content(cell);
  }

  function tableText(node: Json, ancestors: Set<string>,reference:string): string {
    const data = object(node.data);
    if (!data) throw new Error('Docling table has no structured data');
    const cells = list(data.table_cells).map(value => {
      const cell = object(value);
      if (!cell || !Number.isInteger(cell.start_row_offset_idx) || !Number.isInteger(cell.start_col_offset_idx) ||
          (cell.start_row_offset_idx as number) < 0 || (cell.start_col_offset_idx as number) < 0) {
        throw new Error('Docling table has invalid cell coordinates');
      }
      return cell;
    }).sort((a, b) => (a.start_row_offset_idx as number) - (b.start_row_offset_idx as number) || (a.start_col_offset_idx as number) - (b.start_col_offset_idx as number));
    const rows = new Map<number, string[]>();
    const tablePages = new Set(provenance(node).map(location => location.page_no));
    const cellIndices=new Map(list(data.table_cells).map((cell,index)=>[cell,index]));
    const cellTexts:DoclingNativeTable['cellTexts']=[];
    for (const cell of cells) {
      const row = cell.start_row_offset_idx as number;
      const values = rows.get(row) || [];
      const column = cell.start_col_offset_idx as number;
      while (values.length <= column) values.push('');
      const original=cellText(cell, ancestors, tablePages);
      cellTexts.push({cellIndex:cellIndices.get(cell)!,text:original});
      const content = original.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
      if (values[column] && content) throw new Error('Docling table has overlapping cell coordinates');
      values[column] = content;
      rows.set(row, values);
    }
    const columnCount = Math.max(Number.isInteger(data.num_cols) ? data.num_cols as number : 0, ...[...rows.values()].map(row => row.length));
    const content = [...rows.values()].map(row => {
      while (row.length < columnCount) row.push('');
      return `| ${row.join(' | ')} |`;
    }).join('\n');
    if (!cells.length || !cells.some(cell => nodeContent(cell) || cell.ref)) throw new Error('Docling table contains no readable cells');
    nativeTables.push({reference,pageNumbers:[...tablePages] as number[],raw:structuredClone(node),
      cellTexts:cellTexts.sort((a,b)=>a.cellIndex-b.cellIndex),captions:list(node.captions).map(value=>{
        const caption=resolve(value);return {reference:caption.ref,raw:structuredClone(caption.node)};
      })});
    return content;
  }

  function visit(reference: unknown, ancestors = new Set<string>()): void {
    const {ref, node} = resolve(reference);
    if (ancestors.has(ref)) throw new Error('Docling document references contain a cycle');
    if (visited.has(ref)) return;
    if(ref.startsWith('#/groups/')&&isInline(node)){
      for(const [page,value]of inline(reference,ancestors))parts.get(page)!.push(value);
      for(const child of [...list(node.captions),...list(node.footnotes),...list(node.references)])visit(child,new Set([...ancestors,ref]));
      return;
    }
    visited.add(ref);
    const next = new Set([...ancestors, ref]);
    if (ref.startsWith('#/tables/')) add(node, tableText(node, next,ref));
    else if (ref.startsWith('#/pictures/')) {
      // Captions/child text remain searchable; pixels cannot be treated as transcribed text.
      add(node, '');
      warnings.push(`第 ${provenance(node)[0].page_no} 页含图片；仅索引已识别文字和图注`);
      for(const location of provenance(node)){
        const pageNumber=location.page_no as number,size=object(object(manifest?.[String(pageNumber)])?.size),box=object(location.bbox);
        // Older valid text caches can lack optional region geometry. Keep their
        // text/page provenance, preserve raw prov, and make visual incompleteness explicit.
        if(!size||!box){unavailablePictures.push({pictureRef:ref,provenance:structuredClone(provenance(node))});continue;}
        if(![size.width,size.height].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)||
          ![box.l,box.t,box.r,box.b].every(n=>typeof n==='number'&&Number.isFinite(n))||
          !['BOTTOMLEFT','TOPLEFT'].includes(String(box.coord_origin)))throw new Error('Docling picture has invalid region geometry');
        const {l,t,r,b}=box as {l:number;t:number;r:number;b:number},width=size.width as number,height=size.height as number;
        const top=box.coord_origin==='BOTTOMLEFT'?height-t:t,bottom=box.coord_origin==='BOTTOMLEFT'?height-b:b;
        if(l<0||r>width||l>=r||top<0||bottom>height||top>=bottom)throw new Error('Docling picture bbox exceeds its actual page');
        regions.push({pictureRef:ref,pageNumber,derivedPageNumber:pageNumber,pageSize:{width,height},
          bbox:{l,t,r,b,coord_origin:box.coord_origin as 'BOTTOMLEFT'|'TOPLEFT'},
          textReferences:list(document!.texts).flatMap((value,index)=>{const child=object(value);
            return child&&object(child.parent)?.$ref===ref?[{ref:`#/texts/${index}`,parentRef:ref,text:content(child),provenance:list(child.prov)}]:[];})});
      }
    } else if (!ref.startsWith('#/groups/') && !ref.startsWith('#/field_regions/') && !ref.startsWith('#/field_items/')) {
      const value = content(node);
      if(value.trim()&&list(node.children).some(child=>isInline(resolve(child).node)))throw Error('Docling inline parent content is ambiguous');
      const originalFallback = (!text(node.text)||sourceFallback.has(node)) && Boolean(text(node.orig));
      noteFormula(node);
      if(node.label==='formula'||script(node)==='sub'||script(node)==='super'){
        noteMath(ref,node,ancestors,node.label==='formula'?'block-formula':'script',provenance(node).map(p=>p.page_no as number));
        if(node.label!=='formula')warnings.push('非行内分组的脚本保留原位置和字符串；未推断所属基符号');
      }
      if (node.label === 'formula' && !value.trim()) {
        if(options.formulaEnriched !== false)throw new Error('Docling formula has no readable LaTeX');
        warnings.push(`第 ${provenance(node)[0].page_no} 页有公式尚未转写，请核对原 PDF`);
      }
      add(node, node.label === 'formula' && value && !originalFallback && options.formulaEnriched !== false ? `$$\n${value}\n$$` : value);
    }
    for (const child of [...list(node.children), ...list(node.captions), ...list(node.footnotes), ...list(node.references)]) visit(child, next);
  }

  for (const reference of list(object(document.furniture)?.children)) visit(reference);
  for (const reference of body.children) visit(reference);
  // A malformed tree must not silently discard text residing outside the body hierarchy.
  for (const collection of ['texts', 'tables', 'pictures']) {
    list(document[collection]).forEach((value, index) => {
      const node = object(value);
      if (!visited.has(`#/${collection}/${index}`) && ((node && nodeContent(node)) || collection !== 'texts')) {
        throw new Error(`Docling contains unreferenced content: #/${collection}/${index}`);
      }
    });
  }
  const pages = pageNumbers.map(pageNumber => {
    const content = parts.get(pageNumber)!.join('\n\n').trim();
    if (!content && occupied.has(pageNumber)) throw new Error(`Docling page ${pageNumber} has content but no readable transcription`);
    if (!content && !verifiedBlankPages.has(pageNumber)) throw new Error(`Docling page ${pageNumber} is blank_or_unreadable; original blank page was not verified`);
    if (!content) warnings.push(`第 ${pageNumber} 页已核验原始 PDF 无页面内容，保留为空白页`);
    return {pageNumber, locator: `第 ${pageNumber} 页`, text: content};
  });
  if (!pages.some(page => page.text)&&!options.pageRange) throw new Error('Docling returned no readable text');
  const pageSizes=pageNumbers.flatMap(pageNumber=>{const size=object(object(manifest?.[String(pageNumber)])?.size);
    return size&&[size.width,size.height].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)?
      [{pageNumber,width:size.width as number,height:size.height as number}]:[];});
  const sourceMath=mathNodes.size?[{policy:DOCLING_SOURCE_MATH_VERSION,nodes:[...mathNodes.values()]}]:undefined;
  if(sourceMath&&Buffer.byteLength(JSON.stringify(sourceMath))>8*1024*1024)throw Error('Docling source math exceeds byte limit');
  return {pages, totalPages, warnings: [...new Set(warnings)],formulaPageNumbers:[...formulaPageNumbers],nativeTables,...(sourceMath?{sourceMath}:{}),
    visualLayout:{status:pageSizes.length===pageNumbers.length&&!unavailablePictures.length?'available':'unavailable',regions,pageSizes,
      ...(unavailablePictures.length?{unavailablePictures,reason:'Docling picture geometry unavailable; original text retained'}:
        pageSizes.length===pageNumbers.length?{}:{reason:'Docling page sizes unavailable'})}};
}

export const DOCLING_PAGE_REGION_LIMITS=Object.freeze({rawBytes:16*1024*1024,nodes:10000,edges:20000,depth:128,pageBytes:1024*1024,pages:500});
export class DoclingPageRegionError extends Error{
  readonly code:'invalid'|'limit'|'unavailable';
  constructor(code:DoclingPageRegionError['code'],message:string){super(message);this.code=code;this.name='DoclingPageRegionError';}
}
export type DoclingPageRegionNode={reference:string;ordinal:number;path:Array<{reference:string;via:string}>;
 membership:'declared-provenance'|'ancestor-reference';declaredPageNumbers:number[];raw:Record<string,unknown>;
 geometry:{status:'observed';bbox:DoclingRegion['bbox']}|{status:'unknown';reason:string};
 textScope:'single-page'|'multi-page'|'unknown'};
/** Index producer declarations only. No page-body serialization, PDF parsing,
 * semantic roles, visual reading order, clipping or visibility inference. */
export function indexDoclingPageRegions(result:unknown,derivedPage:number,expectedPages:number){
  const fail=(code:DoclingPageRegionError['code'],message:string):never=>{throw new DoclingPageRegionError(code,message);};
  if(!Number.isInteger(expectedPages)||expectedPages<1||expectedPages>DOCLING_PAGE_REGION_LIMITS.pages||
    !Number.isInteger(derivedPage)||derivedPage<1||derivedPage>expectedPages)fail('invalid','Invalid explicit Docling page');
  if(Buffer.byteLength(JSON.stringify(result)??'')>DOCLING_PAGE_REGION_LIMITS.rawBytes)fail('limit','Docling raw exceeds byte limit');
  const response=object(result),document=object(object(response?.document)?.json_content),manifest=object(document?.pages),body=object(document?.body);
  if(response?.status!=='success'||list(response.errors).length||!document||!manifest||!Array.isArray(body?.children))
    fail('invalid','Saved Docling document is incomplete');
  const numbers=Object.entries(manifest!).map(([key,value])=>{const page=object(value),n=Number(key);
    if(!Number.isInteger(n)||page?.page_no!==n)fail('invalid','Invalid Docling page manifest');return n;}).sort((a,b)=>a-b);
  if(numbers.length!==expectedPages||numbers.some((n,i)=>n!==i+1))fail('invalid','Saved Docling page coverage differs');
  const size=object(object(manifest![String(derivedPage)])?.size),pageSize=size&&
    [size.width,size.height].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>0)?{width:size.width as number,height:size.height as number}:null;
  const indexed=new Map<string,DoclingPageRegionNode>(),selected=new Set<string>();let edges=0;
  const geometry=(prov:Json[]):DoclingPageRegionNode['geometry']=>{
    const locations=prov.filter(p=>p.page_no===derivedPage);
    if(locations.length!==1)return {status:'unknown',reason:locations.length?'multiple-page-boxes':'no-page-box'};
    const box=object(locations[0].bbox);
    if(!box||!pageSize)return {status:'unknown',reason:box?'page-size-unavailable':'bbox-unavailable'};
    if(![box.l,box.t,box.r,box.b].every(n=>typeof n==='number'&&Number.isFinite(n))||
      !['BOTTOMLEFT','TOPLEFT'].includes(String(box.coord_origin)))return {status:'unknown',reason:'unsupported-bbox'};
    const {l,t,r,b}=box as {l:number;t:number;r:number;b:number},top=box.coord_origin==='BOTTOMLEFT'?pageSize.height-t:t,
      bottom=box.coord_origin==='BOTTOMLEFT'?pageSize.height-b:b;
    if(l<0||r>pageSize.width||l>=r||top<0||bottom>pageSize.height||top>=bottom)return {status:'unknown',reason:'bbox-outside-page'};
    return {status:'observed',bbox:{l,t,r,b,coord_origin:box.coord_origin as 'BOTTOMLEFT'|'TOPLEFT'}};
  };
  const visit=(reference:unknown,path:DoclingPageRegionNode['path'],via:string)=>{
    if(++edges>DOCLING_PAGE_REGION_LIMITS.edges||path.length>=DOCLING_PAGE_REGION_LIMITS.depth)fail('limit','Docling reference graph exceeds limit');
    const {ref,node}=resolveNode(document!,reference);
    if(path.some(p=>p.reference===ref))fail('invalid','Docling region graph contains a cycle');
    if(indexed.has(ref)){if(selected.has(ref))for(const p of path)selected.add(p.reference);return;}
    if(indexed.size>=DOCLING_PAGE_REGION_LIMITS.nodes)fail('limit','Docling node count exceeds limit');
    if(node.self_ref!==undefined&&node.self_ref!==ref)fail('invalid','Docling node self reference differs');
    if(node.parent!==undefined&&node.parent!==null){const parent=object(node.parent)?.$ref;
      if(parent!=='#/body'&&parent!=='#/furniture')resolveNode(document!,node.parent);}
    const prov=list(node.prov).map(p=>object(p));
    if(prov.some(p=>!p||!Number.isInteger(p.page_no)||!numbers.includes(p.page_no as number)))fail('invalid','Docling node page provenance differs');
    if(!prov.length&&!ref.startsWith('#/groups/')&&!ref.startsWith('#/field_regions/')&&!ref.startsWith('#/field_items/'))
      fail('unavailable','Docling node has no declared page provenance');
    const next=[...path,{reference:ref,via}],pages=[...new Set(prov.map(p=>p!.page_no as number))];
    const fields=['self_ref','label','parent','children','captions','footnotes','references','orig','text','formatting','prov',...(ref.startsWith('#/tables/')?['data']:[])];
    indexed.set(ref,{reference:ref,ordinal:indexed.size,path:next,membership:'ancestor-reference',declaredPageNumbers:pages,
      raw:structuredClone(Object.fromEntries(fields.filter(k=>Object.hasOwn(node,k)).map(k=>[k,node[k]]))),
      geometry:geometry(prov as Json[]),textScope:pages.length===1?'single-page':pages.length>1?'multi-page':'unknown'});
    if(pages.includes(derivedPage)){selected.add(ref);for(const p of path)selected.add(p.reference);}
    for(const key of ['children','captions','footnotes','references']){
      if(node[key]!==undefined&&!Array.isArray(node[key]))fail('invalid','Invalid declared Docling reference array');
      list(node[key]).forEach((child,index)=>visit(child,next,`${key}[${index}]`));
    }
    if(ref.startsWith('#/tables/'))list(object(node.data)?.table_cells).forEach((cell,index)=>{
      if(object(cell)?.ref!==undefined)visit(object(cell)!.ref,next,`data.table_cells[${index}].ref`);
    });
  };
  for(const [root,node]of [['furniture',object(document!.furniture)],['body',body]]as const){
    if(node?.children!==undefined&&!Array.isArray(node.children))fail('invalid','Invalid Docling root children');
    list(node?.children).forEach((ref,index)=>visit(ref,[],`${root}.children[${index}]`));
  }
  for(const collection of ['texts','tables','pictures'])list(document![collection]).forEach((value,index)=>{
    const node=object(value);if(!indexed.has(`#/${collection}/${index}`)&&((node&&nodeContent(node))||collection!=='texts'))
      fail('invalid','Saved Docling document has unreferenced content');
  });
  const nodes=[...indexed.values()].filter(n=>selected.has(n.reference)).map(n=>({...n,
    membership:n.declaredPageNumbers.includes(derivedPage)?'declared-provenance' as const:'ancestor-reference' as const}));
  const output={derivedPage,pageSize,producerDocument:{schemaName:typeof document!.schema_name==='string'?document!.schema_name:null,
    version:typeof document!.version==='string'?document!.version:null},nodes};
  if(Buffer.byteLength(JSON.stringify(output))>DOCLING_PAGE_REGION_LIMITS.pageBytes)fail('limit','Docling page index exceeds byte limit');
  return output;
}
