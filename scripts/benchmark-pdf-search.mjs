import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PDFDocument} from 'pdf-lib';
import {buildPdfSearchQuestions} from './pdf-search-questions.mjs';
if(process.argv.includes('--text-only'))process.env.DOCLING_FORMULA_ENRICHMENT='false';

const execute=promisify(execFile),root=resolve(process.env.PDF_BENCHMARK_DIR||'/pdf-data/corpus');
const manifest=JSON.parse(await readFile(join(root,'manifest.json'),'utf8'));
const questionsOnly=process.argv.includes('--questions-only'),searchOnly=process.argv.includes('--search-only');
if(process.argv.includes('--text-only'))process.env.DOCLING_FORMULA_ENRICHMENT='false';
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7);
const onlyGroup=process.argv.find(arg=>arg.startsWith('--group='))?.slice(8);
if(questionsOnly){
  const questions=await buildPdfSearchQuestions(root,manifest);
  await writeFile(join(root,'questions.json'),JSON.stringify(questions,null,2));
  console.log(JSON.stringify({action:'independent-questions',questions:questions.questions.length,expectationSha256:questions.expectationSha256}));
  process.exit(0);
}
if(!process.env.KERNEL_DATABASE_URL?.includes('/pdf_acceptance_'))throw new Error('Use a dedicated PDF acceptance database');
const {kernel}=await import('../lib/kernel/service.ts');
const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
const library=await import('../lib/library.ts');
const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
const {configuredDoclingParser,DOCLING_PARSER_VERSION}=await import('../lib/kernel/docling-result.ts');
await migrateKernel();
const owner='public-pdf-benchmark';
const records=[];
if(!searchOnly){
 if(process.env.PDF_SCAN_TRANSCRIPTION_BACKEND!=='ai'){
  let ready=false;
  for(let attempt=0;attempt<60;attempt++){
    try{ready=(await fetch(process.env.DOCLING_URL.replace(/\/$/,'')+'/docs',{signal:AbortSignal.timeout(3000)})).ok;}catch{/* Wait for model startup. */}
    if(ready)break;
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!ready)throw new Error('Docling did not become ready; no corpus conversion submitted');
 }
for(const item of manifest){
  if(only&&item.path!==only)continue;
  if(onlyGroup&&item.group!==onlyGroup)continue;
  const courseId=`pdf-benchmark-${item.group}`;
  await kernel.upsertCourse({id:courseId,name:`Public MIT OCW ${item.group}`,course_code:`PDF-${item.group.toUpperCase()}`});
  const file=join(root,item.path),bytes=await readFile(file);
  const count=(await PDFDocument.load(bytes)).getPageCount();
  const {stdout}=await execute('pdftotext',['-layout','-enc','UTF-8',file,'-'],{maxBuffer:16*1024*1024});
  const nativePages=stdout.split('\f').slice(0,count);
  await writeFile(join(root,item.path+'.reference.json'),JSON.stringify(nativePages));
  const id=await library.saveDocument(owner,courseId,'upload',item.source_url,item.title+'.pdf','application/pdf',bytes);
  const row=await library.getDocument(owner,id),record={...item,documentId:id,pageCount:count,status:row.status};
  console.log(JSON.stringify({action:'convert',file:item.path,pages:count,existingStatus:row.status}));
  const at=Date.now();
  const original=globalThis.fetch;
  globalThis.fetch=async(...args)=>{
    const response=await original(...args);
    if(String(args[0]).includes('api.openai.com/v1/responses')&&response.ok)
      await writeFile(join(root,item.path+'.ai-response.json'),JSON.stringify(await response.clone().json()));
    if(String(args[0]).includes('/convert/file/async')&&response.ok)await writeFile(join(root,item.path+'.task.json'),JSON.stringify(await response.clone().json()));
    if(String(args[0]).includes('/v1/result/')&&response.ok)await writeFile(join(root,item.path+'.docling.json'),JSON.stringify(await response.clone().json()));
    return response;
  };
  try{
    const parsed=await kernel.parsedDocument(owner,id);
    if(process.argv.includes('--force-reparse')||!parsed.length||![configuredDoclingParser(),DOCLING_PARSER_VERSION].includes(parsed[0].parser_version)){
      let savedResult,savedTaskId;
      if(process.argv.includes('--reuse-conversions'))try{savedResult=JSON.parse(await readFile(join(root,item.path+'.docling.json'),'utf8'));}catch{/* Not converted before. */}
      if(!savedResult&&process.argv.includes('--reuse-conversions'))try{savedTaskId=JSON.parse(await readFile(join(root,item.path+'.task.json'),'utf8')).task_id;}catch{/* No prior remote task. */}
      record.replayedActualDoclingOutput=Boolean(savedResult);
      record.resumedActualDoclingTask=Boolean(savedTaskId);
      await convertDocumentWithDocling(owner,id,undefined,savedResult,savedTaskId);
    }
    const pages=await kernel.parsedDocument(owner,id);
    record.status=(await library.getDocument(owner,id)).status;
    record.parsedPages=pages.length;
    record.characters=pages.reduce((sum,page)=>sum+page.body.length,0);
    record.warnings=pages[0]?.warnings||[];
    record.extractionMethod=pages[0]?.extraction_method||null;
    await writeFile(join(root,item.path+'.parsed.json'),JSON.stringify(pages));
  }catch(error){record.status='failed';record.error=error.message;}
  finally{globalThis.fetch=original;}
  record.durationMs=Date.now()-at;records.push(record);
  console.log(JSON.stringify({action:'converted',file:item.path,status:record.status,pages:record.parsedPages,error:record.error,durationMs:record.durationMs}));
  await mkdir(resolve(root,'reports'),{recursive:true});
  await writeFile(join(root,'reports',only?'single-conversion.json':onlyGroup?`${onlyGroup}-conversion.json`:'conversion.json'),JSON.stringify(records,null,2));
  if(record.status==='failed')break;
}
}
if(searchOnly||(!only&&!process.argv.includes('--convert-only'))){
  await runSearchAcceptance();
}
await kernelPool().end();
if(records.some(row=>row.status==='failed'))process.exitCode=1;

async function runSearchAcceptance(){
  const questionSet=await buildPdfSearchQuestions(root,manifest);
  await mkdir(join(root,'reports'),{recursive:true});
  // Freeze independent expectations before running either search implementation.
  await writeFile(join(root,'questions.json'),JSON.stringify(questionSet,null,2));
  const documents=await library.listDocuments(owner),documentByPath=new Map();
  const corpus=[];
  for(const item of manifest){
    const originKey=JSON.stringify([`pdf-benchmark-${item.group}`,item.source_url]);
    const document=documents.find(row=>row.origin_key===originKey&&row.hash===item.sha256);
    if(document)documentByPath.set(item.path,document.id);
    const parsed=document?await kernel.parsedDocument(owner,document.id):[];
    const reference=JSON.parse(await readFile(join(root,item.path+'.reference.json'),'utf8'));
    corpus.push({path:item.path,group:item.group,sha256:item.sha256,documentId:document?.id||null,
      expectedPages:reference.length,parsedPages:parsed.length,status:document?.status||'missing',
      parserVersion:parsed[0]?.parser_version||null,warnings:parsed[0]?.warnings||[],
      complete:parsed.length===reference.length&&Boolean(parsed.length)&&document?.status==='ready'});
  }
  const pathByDocument=new Map([...documentByPath].map(([path,id])=>[id,path]));
  const aiRerank=process.argv.includes('--ai-rerank'),semantic=process.argv.includes('--semantic')||aiRerank,outcomes=[];
  // AI ordering is a separate, bounded all-library experiment (150 distinct calls).
  const scopes=aiRerank?['all']:['all','course'];
  const concurrency=aiRerank?4:1;
  const startedAt=new Date().toISOString();
  for(const group of ['numerical','probability','mechanics']){
    const questions=questionSet.questions.filter(row=>row.group===group);
    let next=0;
    async function searchNext(){
     while(next<questions.length){
      const question=questions[next++];
      for(const scope of scopes)for(const engine of ['kernel','library']){
        const courseId=scope==='course'?`pdf-benchmark-${group}`:'',started=performance.now();
        let hits=[],error=null;
        try{
          hits=engine==='kernel'?await kernel.searchDocumentText(owner,question.query,{courseId,limit:5,semantic,aiRerank}):
            await library.searchLibrary(owner,question.query,courseId,semantic,{limit:5,kernelSemantic:semantic,aiRerank,embeddingTimeoutMs:12000});
        }catch(failure){error=failure.message;}
        const matchesDocument=hit=>question.expected.some(target=>documentByPath.get(target.path)===hit.document_id);
        const pageNumber=hit=>hit.page_number||Number(hit.locator?.match(/第\s*(\d+)\s*页/u)?.[1]||0);
        const matchesPage=hit=>question.expected.some(target=>documentByPath.get(target.path)===hit.document_id&&target.pages.includes(pageNumber(hit)));
        const rank=hits.findIndex(matchesPage)+1;
        outcomes.push({id:question.id,group,query:question.query,scope,engine,expected:question.expected,
          expectedDocumentAvailable:question.expected.every(target=>documentByPath.has(target.path)),
          top1Document:Boolean(hits[0]&&matchesDocument(hits[0])),top5Document:hits.some(matchesDocument),
          top1Page:Boolean(hits[0]&&matchesPage(hits[0])),top5Page:hits.some(matchesPage),
          reciprocalRank:rank?1/rank:0,durationMs:Math.round(performance.now()-started),error,
          retrievalMode:hits[0]?.retrieval_mode||'no-results',degraded:hits.some(hit=>hit.retrieval_mode==='keyword-fallback'),
          degradedReason:hits[0]?.degraded_reason||null,componentDegraded:hits.some(hit=>hit.degraded_reason),
          hits:hits.map(hit=>({documentId:hit.document_id,path:pathByDocument.get(hit.document_id)||null,
            page:pageNumber(hit),locator:hit.locator,score:hit.score,evidenceId:hit.evidence_id||null,
            parserVersion:hit.parser_version||null,retrievalMode:hit.retrieval_mode||null,excerpt:hit.body.slice(0,500)}))});
      }
     }
    }
    await Promise.all(Array.from({length:concurrency},searchNext));
    await writeFile(join(root,'reports','search-progress.json'),JSON.stringify({retrievalMode:aiRerank?'ai-rerank':semantic?'semantic':'keyword',outcomes},null,2));
    console.log(JSON.stringify({action:'search-group-tested',group,questions:50,outcomes:outcomes.filter(row=>row.group===group).length}));
  }
  const summaries=[];
  for(const group of ['numerical','probability','mechanics'])for(const scope of scopes)for(const engine of ['kernel','library']){
    const rows=outcomes.filter(row=>row.group===group&&row.scope===scope&&row.engine===engine),count=rows.length;
    const fraction=field=>rows.filter(row=>row[field]).length/count;
    const sortedTimes=rows.map(row=>row.durationMs).sort((a,b)=>a-b);
    summaries.push({group,scope,engine,count,top1Document:fraction('top1Document'),top5Document:fraction('top5Document'),
      top1Page:fraction('top1Page'),top5Page:fraction('top5Page'),meanReciprocalRank:rows.reduce((sum,row)=>sum+row.reciprocalRank,0)/count,
      errors:rows.filter(row=>row.error).length,degraded:rows.filter(row=>row.degraded).length,componentDegraded:rows.filter(row=>row.componentDegraded).length,p95DurationMs:sortedTimes[Math.ceil(count*.95)-1]||0});
  }
  const failures=outcomes.filter(row=>!row.top5Page),coverageComplete=corpus.every(row=>row.complete);
  const gate={minimumTop5PageRate:.95,coverageComplete,passed:coverageComplete&&summaries.every(row=>row.count===50&&row.top5Page>=.95&&row.errors===0&&(!semantic||row.degraded===0))};
  const report={startedAt,completedAt:new Date().toISOString(),retrievalMode:aiRerank?'ai-rerank':semantic?'semantic':'keyword',scopes,concurrency,
    questionSetSha256:questionSet.expectationSha256,queryLanguage:questionSet.queryLanguage,
    scope:'All 19 public PDFs are available as distractors; course scope includes 6 or 7 PDFs. No per-document filter.',
    limitations:['These are PDF retrieval locator tests, not AI answer correctness or truth-layer tests.',
      'English public-source questions do not establish Chinese paraphrase retrieval accuracy.',
      'Numerical expectations use independent OCR of handwritten slides; OCR is imperfect and excerpts retain those errors.',
      'Text-mode parses explicitly leave formula transcription unverified; this gate cannot prove mathematical correctness.'],
    corpus,gate,summaries,failures,outcomes};
  await writeFile(join(root,'reports','search.json'),JSON.stringify(report,null,2));
  const rate=value=>`${(value*100).toFixed(1)}%`;
  const summaryText=['# Public PDF retrieval acceptance',`Question set SHA-256: ${report.questionSetSha256}`,
    `Corpus: ${corpus.length} documents; ${corpus.reduce((sum,row)=>sum+row.expectedPages,0)} PDF pages; complete coverage: ${coverageComplete}`,
    `Gate: ${gate.passed?'PASS':'FAIL'} (each group/mode top 5 correct document and page >= 95%)`,
    '| Group | Scope | Engine | Top 1 document | Top 5 document | Top 1 page | Top 5 page |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...summaries.map(row=>`| ${row.group} | ${row.scope} | ${row.engine} | ${rate(row.top1Document)} | ${rate(row.top5Document)} | ${rate(row.top1Page)} | ${rate(row.top5Page)} |`),
    '',...report.limitations.map(value=>`- ${value}`),'',`Failures: ${failures.length}; complete records and cited snippets in search.json.`];
  await writeFile(join(root,'reports','search.md'),summaryText.join('\n'));
  console.log(JSON.stringify({action:'search-gate',...gate,summaries}));
  if(!gate.passed)process.exitCode=1;
}
