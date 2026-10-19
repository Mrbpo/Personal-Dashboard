import {PDFArray,PDFDocument,PDFName,PDFStream} from 'pdf-lib';
import {digest,readBlob} from '../library.ts';
import {kernelPool} from './db.ts';
import {kernel} from './service.ts';
import {validateDoclingProgress,decodeDerivedDoclingResult,type DoclingIdentity,type DoclingProgress} from './docling-batches.ts';
import type {DoclingVisualLayout,DoclingNativeTable} from './docling-result.ts';
import {preparePdfVisualEvidence,pdfVisualCanonical} from './pdf-visual-evidence.ts';
import {prepareNativeTableCandidates} from './document-table-candidates.ts';
import {bindDoclingSourceMath,prepareDoclingSourceMath,type DoclingSourceMath,type PreparedDoclingSourceMath} from './docling-source-math.ts';
import {PDF_INTERNAL_LINK_POLICY,type PdfInternalLinks} from './pdf-internal-links.ts';

export const CACHED_DOCLING_REPLAY_VERSION='docling-cached-replay-v2-list-markers';
const rawMethods=new Set(['docling-text','docling-original-text-fallback','cached-docling-redecode']);
type Document={id:string;owner_id:string;course_id:string|null;name:string;source_hash:string;origin:string;origin_key:string;
 created_at:Date;current_version_id:string;source_version_id:string;page_count:number;parser_version:string;warnings:string[];raw_sha256:string;raw_value:Record<string,unknown>};
type Page={page_number:number;locator:string;body:string;evidence_id:string;parser_version:string;model:string|null;extraction_method:string};
type Provenance={pageNumber:number;extractionMethod:string;parserVersion:string;model?:string;
 basedOn:{versionId:string;sourceVersionId:string;evidenceId:string}};
export type CachedDoclingAudit={schema:1;owner:string;documentId:string;sourceHash:string;expectedCurrentVersion:string;
 decision:'eligible'|'unchanged';pageCount:number;changedPages:number[];warnings:string[];pages:Array<{pageNumber:number;locator:string;text:string}>;
 pageProvenance:Provenance[];document:Document;batchProvenance:DoclingProgress;visualLayout:DoclingVisualLayout;nativeTables:DoclingNativeTable[];
 sourceMath?:PreparedDoclingSourceMath;
 visualEvidence:{status:'missing'|'matching'|'layout-changed'|'render-incomplete';manifestSha256:string|null;contentSha256:string|null;layoutSha256:string;
 internalLinks?:'recorded'|'not-recorded'};visualOnly:boolean;reviewHash:string};
const normalizedWarnings=(warnings:string[])=>[...new Set(warnings.map(w=>w.trim()).filter(Boolean))].sort();

/** No remote fallback: missing/corrupt drafts must fail, never request parsing. */
export async function decodeCachedDoclingReplay(original:Uint8Array,identity:DoclingIdentity,value:unknown,
 load:(hash:string)=>Promise<Uint8Array>=readBlob){
 if(!/^[a-f0-9]{64}$/.test(identity.sourceHash)||! /^[a-f0-9]{64}$/.test(identity.optionsHash)||
  !identity.owner||!identity.documentId||digest(original)!==identity.sourceHash)throw new Error('Cached replay original or options identity mismatch');
 const pdf=await PDFDocument.load(original,{updateMetadata:false}),count=pdf.getPageCount();
 if(count!==identity.totalPages||count<1||count>500)throw new Error('Cached replay original page count mismatch');
 const progress=validateDoclingProgress(value,identity);
 let parserPdf=pdf;
 if(identity.sourceEncodingReceiptHash){
  const receipt=await load(identity.sourceEncodingReceiptHash);
  if(digest(receipt)!==identity.sourceEncodingReceiptHash)throw new Error('Cached replay source encoding receipt checksum mismatch');
  const saved=JSON.parse(Buffer.from(receipt).toString('utf8')) as {proof?:{version?:string;referenceDictionarySha256?:string}},referenceHash=saved.proof?.referenceDictionarySha256;
  const {prepareSourceFontInput,validateFontReferenceDictionary}=await import('./docling.ts');
  let references;
  if(referenceHash!==undefined){
   if(!/^[a-f0-9]{64}$/.test(referenceHash))throw new Error('Cached replay reference identity invalid');
   const asset=await load(referenceHash);if(digest(asset)!==referenceHash)throw new Error('Cached replay reference asset checksum mismatch');
   references=validateFontReferenceDictionary(JSON.parse(Buffer.from(asset).toString('utf8')));
  }
  // Historical v1 must retain its original simple-TT and top-level-only proof
  // traversal, including on sources that also contain CID fonts.
  const prepared=await prepareSourceFontInput(original,undefined,references,
   saved.proof?.version==='source-font-reference-v3'?'source-font-reference-v3':saved.proof?.version==='source-font-reference-v2'?'source-font-reference-v2':'source-font-reference-v1');
  if(!prepared.proof||digest(JSON.stringify({kind:prepared.proof.version,proof:prepared.proof}))!==identity.sourceEncodingReceiptHash||
   digest(prepared.bytes)!==prepared.proof.inputHash)throw new Error('Cached replay source encoding proof or input mismatch');
  parserPdf=await PDFDocument.load(prepared.bytes,{updateMetadata:false});
 }
 const blank=pdf.getPages().flatMap((page,index)=>{
  if(page.node.Annots()?.size())return [];
  const contents=page.node.Contents(),streams=contents instanceof PDFArray?contents.asArray().map(ref=>pdf.context.lookup(ref)):[contents];
  return streams.every(stream=>stream===undefined||(stream instanceof PDFStream&&
   (stream.getContentsSize()===0||(!stream.dict.has(PDFName.of('Filter'))&&!stream.getContentsString().trim()))))?[index+1]:[];
 });
 const pages:Array<{pageNumber:number;locator:string;text:string}>=[],warnings:string[]=[],nativeTables:ReturnType<typeof decodeDerivedDoclingResult>['nativeTables']=[];
 const sourceMath:DoclingSourceMath[]=[];
 let sourceMathBytes=0;
 const visualLayout:DoclingVisualLayout={status:'available',regions:[],pageSizes:[],resultReferences:[]};
 for(const batch of progress.batches){
  const copyIndices=Array.from({length:batch.end-batch.start+1},(_,i)=>batch.start+i-1);
  const derived=await PDFDocument.create();derived.setCreationDate(new Date(0));derived.setModificationDate(new Date(0));
  derived.setProducer('Study Kernel Docling derived-v1');derived.setCreator('Study Kernel');
  for(const page of await derived.copyPages(parserPdf,copyIndices))derived.addPage(page);
  const input=await derived.save();
  if(!batch.inputHash||batch.inputHash!==digest(input)||JSON.stringify(batch.copyIndices)!==JSON.stringify(copyIndices)||
   (await PDFDocument.load(input,{updateMetadata:false})).getPageCount()!==copyIndices.length)
   throw new Error('Cached replay derived input identity mismatch');
  if(!batch.resultHash){
   if(!copyIndices.every(index=>blank.includes(index+1)))throw new Error('Cached replay is missing a nonblank batch result');
   pages.push(...copyIndices.map(index=>({pageNumber:index+1,locator:`第 ${index+1} 页`,text:''})));
   visualLayout.status='unavailable';visualLayout.reason='Verified blank range has no Docling layout';
   warnings.push(`第 ${batch.start}–${batch.end} 页已核验原始 PDF 无页面内容，保留为空白页`);continue;
  }
  const bytes=await load(batch.resultHash);
  if(digest(bytes)!==batch.resultHash)throw new Error('Cached replay result checksum mismatch');
  const saved=JSON.parse(Buffer.from(bytes).toString('utf8')) as {identity:Record<string,unknown>;result:unknown};
  const expected={...identity,start:batch.start,end:batch.end,inputHash:batch.inputHash,copyIndices};
  if(!saved.identity||Object.keys(saved.identity).length!==Object.keys(expected).length||
   Object.entries(expected).some(([key,expectedValue])=>JSON.stringify(saved.identity[key])!==JSON.stringify(expectedValue)))
   throw new Error('Cached replay result source, options or range identity mismatch');
  // This CLI only replays raw Docling text, never reruns or downgrades AI formula pages.
  const decoded=decodeDerivedDoclingResult(saved.result,{...expected},{verifiedBlankPages:blank,formulaEnriched:false});
  nativeTables.push(...decoded.nativeTables.map(table=>({...table,result:{resultBlobSha256:batch.resultHash!,
   derivedInputSha256:batch.inputHash!,optionsHash:identity.optionsHash,copyIndices:[...copyIndices]}})));
  if(decoded.sourceMath){
   const bound=bindDoclingSourceMath(decoded.sourceMath,{resultBlobSha256:batch.resultHash,
    derivedInputSha256:batch.inputHash,copyIndices,formulaEnriched:false})!;
   sourceMathBytes+=Buffer.byteLength(JSON.stringify(bound));if(sourceMathBytes>8*1024*1024)throw Error('Cached source math exceeds byte limit');sourceMath.push(...bound);
  }
  pages.push(...decoded.pages.map(page=>identity.sourceEncodingReceiptHash?{...page,text:page.text.normalize('NFC')}:page));
  warnings.push(...decoded.warnings);
  if(decoded.visualLayout.status==='unavailable'){visualLayout.status='unavailable';visualLayout.reason=decoded.visualLayout.reason;}
  visualLayout.pageSizes.push(...decoded.visualLayout.pageSizes);
  visualLayout.regions.push(...decoded.visualLayout.regions.map(region=>({...region,resultBlobSha256:batch.resultHash,
   derivedInputSha256:batch.inputHash,copyIndices:[...copyIndices]})));
  if(decoded.visualLayout.unavailablePictures)visualLayout.unavailablePictures=[...(visualLayout.unavailablePictures||[]),...decoded.visualLayout.unavailablePictures];
  visualLayout.resultReferences!.push({resultBlobSha256:batch.resultHash,derivedInputSha256:batch.inputHash,copyIndices});
 }
 if(pages.length!==count||pages.some((page,i)=>page.pageNumber!==i+1)||!pages.some(page=>page.text.trim()))
  throw new Error('Cached replay complete document coverage missing');
 return {pages,warnings:normalizedWarnings(warnings),progress,visualLayout,nativeTables,...(sourceMath.length?{sourceMath}:{})};
}

export async function auditCachedDoclingReplay(owner:string,documentId:string):Promise<CachedDoclingAudit>{
 if(!owner||!documentId)throw new Error('Cached replay owner and document are required');
 const pool=kernelPool();
 const document=(await pool.query<Document>(`SELECT d.id,d.owner_id,d.course_id,d.name,d.source_hash,d.origin,d.origin_key,d.created_at,v.parser_version,
  d.current_version_id,v.source_version_id,v.page_count,v.warnings,s.raw_sha256,s.raw_value
  FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
  JOIN source_item_versions s ON s.id=v.source_version_id
  WHERE d.id=$1 AND d.owner_id=$2 AND NOT d.hidden`,[documentId,owner])).rows[0];
 if(!document||document.raw_sha256!==document.source_hash||!Array.isArray(document.warnings)||document.warnings.some(w=>typeof w!=='string'))
  throw new Error('Cached replay current document/source evidence missing');
 const old=(await pool.query<Page>(`SELECT p.page_number,p.locator,p.body,p.evidence_id,
  coalesce(e.parsed_value->'pageProvenance'->>'parserVersion',v.parser_version) parser_version,
  e.parsed_value->'pageProvenance'->>'model' model,
  coalesce(e.parsed_value->>'extractionMethod',s.raw_value->>'extractionMethod',v.parser_version) extraction_method
  FROM document_text_pages p JOIN document_text_versions v ON v.id=p.version_id
  JOIN source_item_versions s ON s.id=v.source_version_id
  JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id
  WHERE p.version_id=$1 AND v.document_id=$2 ORDER BY p.page_number`,[document.current_version_id,documentId])).rows;
 if(old.length!==document.page_count||old.some((page,i)=>page.page_number!==i+1||!rawMethods.has(page.extraction_method)))
  throw new Error('Cached replay requires complete raw Docling pages; enhanced/native/manual pages are protected');
 const stored=document.raw_value.batchProvenance as DoclingProgress|undefined;
 if(!stored?.identity)throw new Error('Cached replay has no saved derived batch provenance');
 const identity={owner,documentId,sourceHash:document.source_hash,totalPages:document.page_count,optionsHash:stored.identity.optionsHash,
  ...(stored.identity.sourceEncodingReceiptHash!==undefined?{sourceEncodingReceiptHash:stored.identity.sourceEncodingReceiptHash}:{})};
 const decoded=await decodeCachedDoclingReplay(await readBlob(document.source_hash),identity,stored);
 const sourceMath=await prepareDoclingSourceMath({owner,documentId,sourceHash:document.source_hash,pages:decoded.pages,structures:decoded.sourceMath});
 const mathChanged=Boolean(sourceMath&&sourceMath.sha256!==document.raw_value.sourceMathSha256);
 const changedPages=old.filter((page,i)=>page.body!==decoded.pages[i].text).map(page=>page.page_number);
 const candidateWarnings=normalizedWarnings([...document.warnings,...decoded.warnings]);
 const qualityChanged=JSON.stringify(candidateWarnings)!==JSON.stringify(normalizedWarnings(document.warnings));
 const visualRow=(await pool.query<{manifest_sha256:string;content_sha256:string;manifest:{content:{layout:DoclingVisualLayout;renderStatus:string;internalLinks?:PdfInternalLinks}}}>(
  'SELECT manifest_sha256,content_sha256,manifest FROM document_pdf_visual_manifests WHERE version_id=$1 AND source_version_id=$2 AND source_hash=$3',
  [document.current_version_id,document.source_version_id,document.source_hash])).rows[0];
 if(visualRow&&(digest(pdfVisualCanonical(visualRow.manifest))!==visualRow.manifest_sha256||
  digest(pdfVisualCanonical(visualRow.manifest.content))!==visualRow.content_sha256))throw new Error('Cached replay existing visual manifest checksum mismatch');
 const layoutSha256=digest(pdfVisualCanonical(decoded.visualLayout));
 const visualStatus:CachedDoclingAudit['visualEvidence']['status']=!visualRow?'missing':
  digest(pdfVisualCanonical(visualRow.manifest.content.layout))!==layoutSha256?'layout-changed':
  visualRow.manifest.content.renderStatus!=='available'?'render-incomplete':'matching';
 const linkPolicy=process.env.PDF_INTERNAL_LINK_OBSERVATIONS;
 if(linkPolicy&&linkPolicy!=='off'&&linkPolicy!=='goto-v1')throw Error('Unknown PDF internal-link observation policy');
 const hasLinks=visualRow?.manifest.content.internalLinks?.policy===PDF_INTERNAL_LINK_POLICY&&visualRow.manifest.content.internalLinks.semanticVerified===false,
  linksNeeded=linkPolicy==='goto-v1'&&!hasLinks;
 const textChanged=Boolean(changedPages.length||qualityChanged),decision=textChanged||mathChanged||visualStatus!=='matching'||linksNeeded?'eligible':'unchanged';
 const warnings=textChanged?normalizedWarnings([...candidateWarnings,
  '缓存 Docling 原始结果重读；公式、符号、上下标及 LaTeX 未完全核验，请保留原 PDF 为证据']):candidateWarnings;
 const pageProvenance=old.map(page=>({pageNumber:page.page_number,
  extractionMethod:changedPages.includes(page.page_number)?'cached-docling-redecode':page.extraction_method,
  parserVersion:changedPages.includes(page.page_number)?CACHED_DOCLING_REPLAY_VERSION:page.parser_version,
  ...(page.model?{model:page.model}:{}),basedOn:{versionId:document.current_version_id,
   sourceVersionId:document.source_version_id,evidenceId:page.evidence_id}}));
 const audit={schema:1 as const,owner,documentId,sourceHash:document.source_hash,expectedCurrentVersion:document.current_version_id,
  decision:decision as CachedDoclingAudit['decision'],pageCount:document.page_count,changedPages,warnings,
  pages:decoded.pages,pageProvenance,document,batchProvenance:decoded.progress,visualLayout:decoded.visualLayout,nativeTables:decoded.nativeTables,...(sourceMath?{sourceMath}:{}),
  visualEvidence:{status:visualStatus,manifestSha256:visualRow?.manifest_sha256??null,contentSha256:visualRow?.content_sha256??null,layoutSha256,
   ...(linkPolicy==='goto-v1'?{internalLinks:hasLinks?'recorded' as const:'not-recorded' as const}:{})},
  visualOnly:!textChanged&&!mathChanged&&(visualStatus!=='matching'||linksNeeded)};
 return {...audit,reviewHash:digest(JSON.stringify(audit))};
}

export async function applyCachedDoclingReplay(reviewed:CachedDoclingAudit,expectedCurrentVersion:string,
 renderer?:Parameters<typeof preparePdfVisualEvidence>[1]){
 if(!expectedCurrentVersion||reviewed.expectedCurrentVersion!==expectedCurrentVersion)throw new Error('Cached replay explicit current-version guard mismatch');
 const current=await auditCachedDoclingReplay(reviewed.owner,reviewed.documentId);
 if(current.expectedCurrentVersion!==expectedCurrentVersion||current.reviewHash!==reviewed.reviewHash)
  throw new Error('Cached replay source/cache/current version changed after audit');
 if(current.decision==='unchanged')return {action:'unchanged',currentVersion:expectedCurrentVersion};
 const d=current.document;
 const pdfVisuals=await preparePdfVisualEvidence({owner:d.owner_id,documentId:d.id,sourceHash:d.source_hash,
  pdfBytes:await readBlob(d.source_hash),layout:current.visualLayout},renderer);
 const nativeTables=await prepareNativeTableCandidates({owner:d.owner_id,documentId:d.id,sourceHash:d.source_hash,tables:current.nativeTables});
 if(current.visualOnly&&pdfVisuals.contentSha256===current.visualEvidence.contentSha256){
  const unchanged=(await kernelPool().query(`SELECT d.id FROM document_texts d
   JOIN document_text_versions v ON v.id=d.current_version_id AND v.document_id=d.id
   JOIN source_item_versions s ON s.id=v.source_version_id AND s.source_item_id=d.source_item_id
   JOIN document_pdf_visual_manifests m ON m.version_id=v.id AND m.source_version_id=s.id AND m.source_hash=d.source_hash
   WHERE d.owner_id=$1 AND d.id=$2 AND d.current_version_id=$3 AND v.source_version_id=$4 AND d.source_hash=$5
   AND s.raw_sha256=$5 AND NOT d.hidden AND m.manifest_sha256=$6 AND m.content_sha256=$7`,
   [d.owner_id,d.id,expectedCurrentVersion,d.source_version_id,d.source_hash,current.visualEvidence.manifestSha256,pdfVisuals.contentSha256])).rows;
  if(unchanged.length!==1)throw new Error('Cached replay current source changed while preparing unchanged visuals');
  return {action:'unchanged',currentVersion:expectedCurrentVersion,visualStatus:pdfVisuals.content.renderStatus};
 }
 await kernel.ingestParsedDocument({id:d.id,ownerId:d.owner_id,courseId:d.course_id||'',name:d.name,hash:d.source_hash,
  mime:'application/pdf',origin:d.origin,originKey:d.origin_key,createdAt:d.created_at.toISOString()},current.pages,
  {parserVersion:current.visualOnly?d.parser_version:CACHED_DOCLING_REPLAY_VERSION,
   extractionMethod:current.visualOnly?String(d.raw_value.extractionMethod||d.parser_version):'mixed-cached-docling-redecode',expectedPages:current.pageCount,
   expectedCurrentVersion,warnings:current.warnings,pageProvenance:current.pageProvenance,batchProvenance:current.batchProvenance,pdfVisuals,nativeTables,sourceMath:current.sourceMath});
 return {action:'published',currentVersion:(await kernelPool().query<{current_version_id:string}>(
  'SELECT current_version_id FROM document_texts WHERE id=$1 AND owner_id=$2',[d.id,d.owner_id])).rows[0].current_version_id};
}
