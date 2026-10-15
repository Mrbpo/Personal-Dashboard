import { database as legacy } from '../database.ts';
import { PDFArray, PDFDocument, PDFName, PDFStream } from 'pdf-lib';
import { digest, getDocument, readBlob, splitText } from '../library.ts';
import { kernel } from './service.ts';
import { decodeDoclingResult, DOCLING_PARSER_VERSION, DOCLING_TEXT_PARSER_VERSION } from './docling-result.ts';
import {rememberDoclingTask,doclingJobPayload,rememberDoclingProgress} from './jobs.ts';
import {convertDoclingBatches,requestDoclingResult,storeDoclingResult,type DoclingProgress,type DecodedDocling} from './docling-batches.ts';
import {preparePdfVisualEvidence} from './pdf-visual-evidence.ts';
import {enrichParsedPdfFormulae,transcribePdfVisualPages} from '../document-parser.ts';
import {localPdfTextPages} from '../local-ocr.ts';
import {prepareNativeTableCandidates} from './document-table-candidates.ts';
import {configuredPdfNativeHints,PDF_NATIVE_HINT_POLICY} from '../pdf-native-hints.ts';

export function nativePdfTextIsComplete(pages:string[]|null,expectedPages:number,blankPages:number[]=[]):boolean{
  if(!pages||pages.length!==expectedPages)return false;
  const fingerprint=(line:string)=>line.toLowerCase().replace(/\d+/g,'#').replace(/\s+/g,' ').trim();
  const repeated=new Map<string,number>();
  for(const page of pages){
    const lines=page.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
    for(const key of new Set([...lines.slice(0,3),...lines.slice(-3)].map(fingerprint)))
      repeated.set(key,(repeated.get(key)||0)+1);
  }
  // Repeated headers/footer labels may exceed 300 characters on four-up scans.
  // Count unique prose, rather than accepting the size of those repeated labels.
  const meaningful=pages.map(page=>page.split(/\r?\n/).filter(line=>
    (repeated.get(fingerprint(line))||0)<Math.max(2,Math.ceil(expectedPages*.6))).join('\n').replace(/\s+/g,' ').trim());
  return meaningful.every((page,index)=>page.length>=40||blankPages.includes(index+1))&&
    meaningful.filter(page=>page.length>=300).length>expectedPages*.5;
}

export async function convertDocumentWithDocling(owner: string, id: string, job?:{id:string;leaseToken:string;taskId?:string;formulaEnriched?:boolean;formulaBackend?:string;scanBackend?:string;nativeTextHints?:string|false;progress?:unknown;sourceHash?:string},savedResult?:Record<string,unknown>,savedTaskId?:string): Promise<void> {
  const base=process.env.DOCLING_URL;
  if(!base)throw new Error('DOCLING_URL is required for v1 PDF parsing');
  const document=await getDocument(owner,id);
  if(document.mime!=='application/pdf')return;
  const bytes=await readBlob(document.hash);
  if(digest(bytes)!==document.hash)throw new Error('Original PDF checksum mismatch');
  const expectedCurrentVersion=process.env.KERNEL_DATABASE_URL?await kernel.documentIngestionHead(owner,id,document.hash):undefined;
  const payload=job?await doclingJobPayload(job.id,job.leaseToken):undefined;
  if(payload&&(payload.owner!==owner||payload.id!==id||
    (payload.sourceHash!==undefined&&payload.sourceHash!==document.hash)))throw new Error('PDF ingestion source identity mismatch');
  if(job?.sourceHash&&job.sourceHash!==document.hash)throw new Error('PDF ingestion source identity mismatch');
  const progress=payload?.doclingProgress??job?.progress;
  const legacyTaskId=job?.taskId??(payload?.doclingTaskId as string|undefined)??savedTaskId;
  const originalPdf=await PDFDocument.load(bytes,{updateMetadata:false});
  const originalPages=originalPdf.getPageCount();
  if(originalPages>500)throw new Error('PDF 超过 500 页，请分册导入');
  const verifiedBlankPages=originalPdf.getPages().flatMap((page,index)=>{
    // Absence of extracted objects is not evidence of a blank scan. Only accept pages
    // with no drawing/text stream and no annotation appearance in the original PDF.
    if(page.node.Annots()?.size())return [];
    const contents=page.node.Contents();
    const streams=contents instanceof PDFArray?contents.asArray().map(ref=>originalPdf.context.lookup(ref)):[contents];
    const blank=streams.every(stream=>stream===undefined || (stream instanceof PDFStream &&
      (stream.getContentsSize()===0 || (!stream.dict.has(PDFName.of('Filter')) && !stream.getContentsString().trim()))));
    return blank?[index+1]:[];
  });
  const formulaEnriched=payload?.formulaEnriched??job?.formulaEnriched??(process.env.DOCLING_FORMULA_ENRICHMENT!=='false');
  if(typeof formulaEnriched!=='boolean')throw new Error('Invalid PDF formula enrichment setting');
  const formulaBackend=payload?.formulaBackend??job?.formulaBackend??process.env.DOCLING_FORMULA_BACKEND??'ai';
  if(typeof formulaBackend!=='string')throw new Error('Unknown PDF formula backend');
  if(!['ai','docling'].includes(formulaBackend))throw new Error('Unknown PDF formula backend');
  const localFormula=formulaEnriched&&formulaBackend==='docling';
  const formulaPreset=process.env.DOCLING_FORMULA_PRESET||'codeformulav2';
  const headers:HeadersInit=process.env.DOCLING_API_KEY?{'X-Api-Key':process.env.DOCLING_API_KEY}:{};
  const endpoint=base.replace(/\/$/,'');
  const native=localFormula||process.env.DOCLING_NATIVE_TEXT_FASTPATH==='false'||savedResult||legacyTaskId||progress?null:await localPdfTextPages(bytes);
  // Keep the strict native gate: sparse/image-only bodies still need parsing.
  const nativeComplete=nativePdfTextIsComplete(native,originalPages,verifiedBlankPages);
  const scanBackend=payload?.scanBackend??job?.scanBackend??process.env.PDF_SCAN_TRANSCRIPTION_BACKEND??'docling';
  if(typeof scanBackend!=='string')throw new Error('Unknown PDF scan backend');
  if(!['ai','docling'].includes(scanBackend))throw new Error('Unknown PDF scan backend');
  // Existing/new queued jobs without this field remain disabled. Queued jobs
  // freeze their trusted opt-in rather than inheriting worker environment drift.
  const nativeTextHints=payload?payload.nativeTextHints:job?.nativeTextHints??configuredPdfNativeHints();
  if(nativeTextHints!==undefined&&nativeTextHints!==false&&nativeTextHints!==PDF_NATIVE_HINT_POLICY)throw new Error('Unknown PDF native hint policy');
  const visual=!savedResult&&!legacyTaskId&&!progress&&!nativeComplete&&scanBackend==='ai';
  const prepare=async(start:number,end:number)=>{
    const copyIndices=Array.from({length:end-start+1},(_,i)=>start+i-1);
    const derived=await PDFDocument.create();
    // Stable metadata makes reconstruction and its checksum reproducible on retry.
    derived.setCreationDate(new Date(0));derived.setModificationDate(new Date(0));
    derived.setProducer('Study Kernel Docling derived-v1');derived.setCreator('Study Kernel');
    for(const page of await derived.copyPages(originalPdf,copyIndices))derived.addPage(page);
    const inputBytes=await derived.save();
    if((await PDFDocument.load(inputBytes,{updateMetadata:false})).getPageCount()!==copyIndices.length)
      throw new Error('Docling derived PDF page count mismatch');
    const value=new FormData();
    value.append('files',new Blob([new Uint8Array(inputBytes)],{type:'application/pdf'}),'pages.pdf');
    value.append('from_formats','pdf');value.append('to_formats','md');value.append('to_formats','json');
    value.append('do_ocr','true');value.append('do_table_structure','true');
    value.append('do_formula_enrichment',String(localFormula));value.append('code_formula_preset',formulaPreset);
    value.append('abort_on_error','true');
    value.append('page_range','1');value.append('page_range',String(copyIndices.length));
    return {form:value,inputHash:digest(inputBytes),copyIndices};
  };
  let currentProgress:DoclingProgress|undefined;
  let result=savedResult;
  // An old task ID has no range metadata: only resume that full response; never
  // submit a new whole-document request or reinterpret its pages as a batch.
  if(!result&&legacyTaskId)result=await requestDoclingResult(endpoint,headers,undefined,legacyTaskId,
    async taskId=>{if(job)await rememberDoclingTask(job.id,job.leaseToken,taskId);});
  const decoded:DecodedDocling=result?decodeDoclingResult(result,originalPages,{verifiedBlankPages,formulaEnriched:localFormula}):
    visual?{pages:await transcribePdfVisualPages(id,bytes,{expectedSourceHash:document.hash,
      pageNumbers:Array.from({length:originalPages},(_,index)=>index+1),
      ...(nativeTextHints?{nativeTextHints}:{} )}),totalPages:originalPages,
      warnings:['AI 视觉转写；数学、手写及图表请核对原 PDF'],formulaPageNumbers:[],nativeTables:[],
      visualLayout:{status:'unavailable' as const,regions:[],pageSizes:[],reason:'Visual transcription has no Docling layout'}}:
    nativeComplete?{pages:native!.map((text,index)=>({text,pageNumber:index+1,locator:`第 ${index+1} 页`})),
      totalPages:originalPages,warnings:formulaEnriched?[]:['公式增强未启用；正文可检索，公式须核对原 PDF'],formulaPageNumbers:[],nativeTables:[],
      visualLayout:{status:'unavailable' as const,regions:[],pageSizes:[],reason:'Native text path has no Docling layout'}}:
    await convertDoclingBatches({identity:{owner,documentId:id,sourceHash:document.hash,totalPages:originalPages,
      optionsHash:digest(JSON.stringify({transport:'docling-derived-v1',endpoint,parser:formulaEnriched?DOCLING_PARSER_VERSION:DOCLING_TEXT_PARSER_VERSION,
        doOcr:true,doTableStructure:true,localFormula,formulaBackend,formulaPreset,scanBackend}))},
      progress,verifiedBlankPages,formulaEnriched:localFormula,endpoint,headers,prepare,
      persist:async value=>{
        if(job)await rememberDoclingProgress(job.id,job.leaseToken,value);
        currentProgress=structuredClone(value);
      }});
  let pages=decoded.pages,warnings=decoded.warnings;
  const totalPages=decoded.totalPages;
  if(visual)warnings=[...warnings,...pages.filter(page=>page.text.includes('[无法可靠辨认')).map(page=>`第 ${page.pageNumber} 页含无法可靠辨认的片段，须核对原 PDF`)];
  if(formulaEnriched&&!visual&&(!localFormula||nativeComplete)){
    const enhanced=await enrichParsedPdfFormulae(id,bytes,pages,decoded.formulaPageNumbers);
    pages=enhanced.pages;
    warnings=[...warnings.filter(warning=>!warning.startsWith('公式增强未启用')), ...enhanced.warnings];
  }
  const parserVersion=formulaEnriched?DOCLING_PARSER_VERSION:DOCLING_TEXT_PARSER_VERSION;
  const current=await getDocument(owner,id);
  if(current.hash!==document.hash)throw new Error('Original PDF changed during conversion');
  if(digest(await readBlob(current.hash))!==document.hash)throw new Error('Original PDF checksum changed during conversion');
  if(result){
    const copyIndices=Array.from({length:originalPages},(_,index)=>index);
    const resultBlobSha256=await storeDoclingResult({identity:{owner,documentId:id,sourceHash:document.hash,totalPages:originalPages,
      inputHash:document.hash,copyIndices},result});
    decoded.visualLayout.regions=decoded.visualLayout.regions.map(region=>({...region,resultBlobSha256,
      derivedInputSha256:document.hash,copyIndices}));
    decoded.visualLayout.resultReferences=[{resultBlobSha256,derivedInputSha256:document.hash,copyIndices}];
  }
  const pdfVisuals=await preparePdfVisualEvidence({owner,documentId:id,sourceHash:document.hash,pdfBytes:bytes,layout:decoded.visualLayout});
  const nativeTables=await prepareNativeTableCandidates({owner,documentId:id,sourceHash:document.hash,
    tables:decoded.nativeTables});
  await kernel.ingestParsedDocument({id:document.id,ownerId:owner,courseId:document.course_id,name:document.name,
    hash:document.hash,mime:document.mime,origin:document.origin,originKey:document.origin_key,createdAt:document.created_at},pages,
    {parserVersion,expectedPages:totalPages,warnings,nativeTables,pdfVisuals,expectedCurrentVersion,
      ingestionLease:job?{id:job.id,token:job.leaseToken}:undefined,
      batchProvenance:currentProgress?{schema:currentProgress.schema,identity:currentProgress.identity,
        batchSize:currentProgress.batchSize,batches:currentProgress.batches}:undefined,extractionMethod:visual?'ai-visual-page-transcription':nativeComplete?
      (formulaEnriched?'native-text-plus-ai-formula':'native-text'):formulaEnriched?`docling-plus-${formulaBackend}-formula`:'docling-text'});
  const chunks=pages.flatMap(page=>splitText(page.text).map(body=>({locator:page.locator,body})));
  // Search chunks are a rebuildable cache. The original blob and provenance remain available.
  await legacy.batch([
    legacy.prepare('DELETE FROM library_parse_pages WHERE document_id=? AND parser IN (?,?)').bind(id,'docling-v1',parserVersion),
    ...pages.map(page=>legacy.prepare('INSERT INTO library_parse_pages(document_id,parser,page,body) VALUES (?,?,?,?)')
      .bind(id,parserVersion,page.pageNumber-1,page.text)),
    legacy.prepare('DELETE FROM library_vectors WHERE chunk_id IN (SELECT id FROM library_chunks WHERE document_id=?)').bind(id),
    legacy.prepare('DELETE FROM library_chunks WHERE document_id=?').bind(id),
    ...chunks.map((chunk,index)=>legacy.prepare('INSERT INTO library_chunks(id,document_id,position,locator,body,hash) VALUES (?,?,?,?,?,?)')
      .bind(`${id}:${index}`,id,index,chunk.locator,chunk.body,digest(chunk.body))),
    legacy.prepare("UPDATE library_documents SET status='ready',error=? WHERE id=? AND deleted=0").bind(warnings.join('；')||null,id),
  ]);
}
