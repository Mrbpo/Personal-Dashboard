import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {pdfFormulaSamples} from './pdf-formula-samples.mjs';

if(!process.env.KERNEL_DATABASE_URL?.includes('/pdf_acceptance_'))throw new Error('Use the isolated PDF acceptance database');
const root=resolve(process.env.PDF_BENCHMARK_DIR||'/pdf-data/corpus');
const {kernel}=await import('../lib/kernel/service.ts');
const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
const {enrichParsedPdfFormulae}=await import('../lib/document-parser.ts');
const library=await import('../lib/library.ts');
const {database}=await import('../lib/database.ts');
await migrateKernel();
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8')),owner='public-pdf-benchmark';
const results=[];
try{
 const documents=await library.listDocuments(owner);
 // Derivatives from an earlier sampling attempt cannot compete with originals.
 for(const document of documents.filter(row=>/^.+\.pdf original page \d+\.pdf$/.test(row.name)))
  await library.removeDocument(owner,document.id);
 for(const sample of pdfFormulaSamples){
  const item=manifest.find(row=>row.path===sample.path),courseId=`pdf-benchmark-${item.group}`;
  const document=documents.find(row=>row.hash===item.sha256&&row.origin_key===JSON.stringify([courseId,item.source_url]));
  if(!document)throw new Error(`Original PDF missing: ${sample.path}`);
  const id=document.id,started=Date.now(),parsed=await kernel.parsedDocument(owner,id);
  const target=parsed.find(row=>row.page_number===sample.page);
  if(!target)throw new Error(`Original page not transcribed: ${sample.path}:${sample.page}`);
  let body=target.body,warnings=parsed[0]?.warnings||[];
  if(!body.includes('\\[')){
   const enhanced=await enrichParsedPdfFormulae(id,await readFile(join(root,sample.path)),
    [{pageNumber:sample.page,locator:target.locator,text:body}],[sample.page]);
   body=enhanced.pages[0].text;warnings=[...warnings,...enhanced.warnings];
   await kernel.ingestParsedDocument({id,ownerId:owner,courseId,name:document.name,hash:document.hash,mime:document.mime,
    origin:document.origin,originKey:document.origin_key,createdAt:document.created_at},
    parsed.map(page=>({pageNumber:page.page_number,locator:page.locator,text:page.page_number===sample.page?body:page.body})),
    {parserVersion:'pdf-benchmark-selected-formula-v1',expectedPages:parsed.length,warnings,
     extractionMethod:'existing-full-transcription-plus-selected-original-page-formula'});
  }
  const queries=[];
  for(const formula of sample.formulae){
   const kernelHits=await kernel.searchDocumentText(owner,formula,{limit:5});
   const libraryHits=await library.searchLibrary(owner,formula,'',false,{limit:5});
   queries.push({expectedFormula:formula,kernelTop5Hit:kernelHits.some(hit=>hit.document_id===id&&hit.page_number===sample.page),
    libraryTop5Hit:libraryHits.some(hit=>hit.document_id===id&&hit.page_number===sample.page),
    kernelHits:kernelHits.map(hit=>({documentId:hit.document_id,page:hit.page_number,score:hit.score})),
    libraryHits:libraryHits.map(hit=>({documentId:hit.document_id,page:hit.page_number,score:hit.score}))});
  }
  results.push({...sample,documentId:id,sourceUrl:item.source_url,sourceSha256:item.sha256,
   originalPdfPage:sample.page,body,warnings,durationMs:Date.now()-started,queries,
   mathematicalReview:'pending independent manual comparison; lexical retrieval alone does not prove formula correctness'});
  await mkdir(join(root,'reports'),{recursive:true});
  await writeFile(join(root,'reports','formulas-progress.json'),JSON.stringify(results,null,2));
  console.log(JSON.stringify({action:'formula-sample',source:sample.path,sourcePage:sample.page,durationMs:Date.now()-started,
   warnings,formulaQueries:queries.length,searchHits:queries.filter(row=>row.kernelTop5Hit&&row.libraryTop5Hit).length}));
 }
 const usage=(await database.prepare('SELECT kind,COUNT(*) calls,COALESCE(SUM(COALESCE(charged,reserved)),0) usd FROM ai_ledger GROUP BY kind').all()).results;
 await writeFile(join(root,'reports','formulas.json'),JSON.stringify({samplesSha256:createHash('sha256').update(JSON.stringify(pdfFormulaSamples)).digest('hex'),
  scope:'Nine independently authored formulas on three original pages, searched across all 19 original PDFs; no derivative PDFs',usage,results},null,2));
}finally{await kernelPool().end();}
