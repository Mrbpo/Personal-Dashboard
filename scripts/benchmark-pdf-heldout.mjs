import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve,join,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PDFDocument} from 'pdf-lib';

const root=resolve(process.env.PDF_HELDOUT_DIR||'/pdf-data/heldout');
const groups=(process.env.PDF_HELDOUT_GROUPS||'stanford,algorithms,systems').split(',');
if(groups.length!==3||new Set(groups).size!==3||groups.some(group=>!/^[a-z][a-z0-9]*$/u.test(group)))
 throw new Error('Exactly three named independent corpora are required');
const hash=value=>createHash('sha256').update(value).digest('hex');
const originalPath=item=>join(item.materialRoot||root,item.group,basename(item.path));
async function referenceFor(item){
 try{return JSON.parse(await readFile(originalPath(item)+'.reference.json','utf8'));}
 catch(error){
  if(error.code!=='ENOENT')throw error;
  return JSON.parse(await readFile(originalPath(item).replace(/\.pdf$/u,'.reference.json'),'utf8'));
 }
}
const expected=[],materials=[];
for(const group of groups){
 const manifest=JSON.parse(await readFile(join(root,group,'manifest.json'),'utf8'));
 const data=JSON.parse(await readFile(join(root,group,'questions.json'),'utf8'));
 if(!Array.isArray(manifest)||manifest.length<12||data.questions?.length!==50)throw new Error(`Incomplete heldout set: ${group}`);
 const byPath=new Map(manifest.map(item=>[item.path,item]));
 if(byPath.size!==manifest.length)throw new Error(`Duplicate material identity: ${group}`);
 for(const item of manifest){
  if(item.group!==group||![basename(item.path),`data/pdf-heldout/${group}/${basename(item.path)}`].includes(item.path)||!item.path.endsWith('.pdf'))throw new Error('Invalid material path/group');
  const bytes=await readFile(originalPath(item));
  if(hash(bytes)!==item.sha256||bytes.length!==item.bytes)throw new Error(`Original hash/length changed: ${group}/${item.path}`);
  if((await PDFDocument.load(bytes,{updateMetadata:false})).getPageCount()!==item.page_count)throw new Error('Original PDF page count changed');
  materials.push({...item,group});
 }
 for(const question of data.questions){
  if(question.group!==group||!question.query?.trim()||!question.expected?.length)throw new Error('Invalid frozen question');
  const reference=question.reference,item=byPath.get(reference?.path);
  if(!item||reference.sourceUrl!==item.source_url||hash(reference.excerpt)!==reference.sha256||reference.anchor.length<10||reference.excerpt.length>1000)
   throw new Error(`Invalid independent evidence: ${question.id}`);
  const original=await referenceFor(item);
  const page=original.pages?.find(row=>(row.page??row.page_number)===reference.page);
  if(!page?.text?.includes(reference.anchor)||!page.text.includes(reference.excerpt))throw new Error(`Anchor absent from original page: ${question.id}`);
  if(!question.expected.some(target=>target.path===item.path&&target.pages.includes(reference.page)))throw new Error('Evidence does not support expected location');
  for(const target of question.expected){
   const material=byPath.get(target.path);
   if(!material||!target.pages?.length||target.pages.some(page=>!Number.isInteger(page)||page<1||page>material.page_count))throw new Error('Invalid actual PDF page');
  }
  expected.push(question);
 }
}
if(new Set(expected.map(row=>row.id)).size!==150)throw new Error('Duplicate question identity');
// Fresh validation retains the entire earlier corpus as distractors. Questions
// are frozen only for the three fresh groups; no query ever filters to a group.
if(process.env.PDF_DISTRACTOR_DIR){
 const distractorRoot=resolve(process.env.PDF_DISTRACTOR_DIR);
 for(const group of ['stanford','algorithms','systems']){
  const manifest=JSON.parse(await readFile(join(distractorRoot,group,'manifest.json'),'utf8'));
  if(!Array.isArray(manifest)||new Set(manifest.map(item=>item.path)).size!==manifest.length)throw new Error('Invalid distractor manifest');
  for(const item of manifest){
   if(item.group!==group||![basename(item.path),`data/pdf-heldout/${group}/${basename(item.path)}`].includes(item.path)||!item.path.endsWith('.pdf'))throw new Error('Invalid distractor path/group');
   const material={...item,group,materialRoot:distractorRoot};
   const bytes=await readFile(originalPath(material));
   if(hash(bytes)!==item.sha256||bytes.length!==item.bytes||
     (await PDFDocument.load(bytes,{updateMetadata:false})).getPageCount()!==item.page_count)
    throw new Error('Frozen distractor original changed');
   materials.push(material);
  }
 }
}
if(new Set(materials.map(item=>`${item.group}/${item.path}`)).size!==materials.length)throw new Error('Duplicate corpus identity');
const expectationSha256=hash(JSON.stringify(expected));
await mkdir(join(root,'reports'),{recursive:true});
const frozenFile=join(root,'reports','frozen-expectation.sha256');
try{
 const prior=(await readFile(frozenFile,'utf8')).trim();
 if(prior!==expectationSha256)throw new Error('Frozen heldout expectations changed');
}catch(error){if(error.code!=='ENOENT')throw error;await writeFile(frozenFile,expectationSha256+'\n',{flag:'wx'});}
if(process.argv.includes('--validate-only')){
 console.log(JSON.stringify({expectationSha256,questions:expected.length,documents:materials.length,pages:materials.reduce((sum,row)=>sum+row.page_count,0)}));
 process.exit(0);
}
if(!process.env.KERNEL_DATABASE_URL?.includes('/pdf_acceptance_')||!process.env.LIBRARY_DIR?.startsWith('/pdf-data/'))throw new Error('Dedicated public PDF environment required');
process.env.DOCLING_FORMULA_ENRICHMENT='false';
// Freeze the actual source loaded by this process, not a historical commit label.
// This reads application code only; questions and expected answers are excluded.
const codeRoot=fileURLToPath(new URL('../',import.meta.url));
async function algorithmFingerprint(){
 const paths=['lib/library.ts',...(await readdir(join(codeRoot,'lib/kernel'))).filter(name=>name.endsWith('.ts')).sort().map(name=>`lib/kernel/${name}`)];
 const files=await Promise.all(paths.map(async path=>({path,sha256:hash(await readFile(join(codeRoot,path)))})));
 return {revision:process.env.PDF_CODE_BASELINE||process.env.PDF_ALGORITHM_BASELINE||null,sha256:hash(JSON.stringify(files)),files};
}
const algorithmFreeze=await algorithmFingerprint();
const {kernel}=await import('../lib/kernel/service.ts');
const {kernelPool,migrateKernel}=await import('../lib/kernel/db.ts');
const library=await import('../lib/library.ts');
const {convertDocumentWithDocling}=await import('../lib/kernel/docling.ts');
const {queueIngestionJob,claimIngestionJob,renewIngestionJob,finishIngestionJob}=await import('../lib/kernel/jobs.ts');
async function convertDurably(document,owner){
 const payload={owner,id:document.id,sourceHash:document.hash,formulaEnriched:false,formulaBackend:'ai',scanBackend:'docling'};
 const key=`heldout:${owner}:${document.id}:text:derived-v1:batch${process.env.DOCLING_BATCH_PAGES||1}`;
 const jobId=await queueIngestionJob('docling_document','public_pdf_heldout',document.course_id,payload,key,true);
 const job=await claimIngestionJob(jobId);
 if(!job||job.id!==jobId)throw new Error('Heldout parse job unavailable; preserve existing progress');
 let leaseLost=false;
 const renew=setInterval(()=>{void renewIngestionJob(job.id,job.lease_token).then(ok=>{if(!ok)leaseLost=true;}).catch(()=>{leaseLost=true;});},30000);
 try{
  await convertDocumentWithDocling(owner,document.id,{id:job.id,leaseToken:job.lease_token,sourceHash:document.hash,
   formulaEnriched:false,formulaBackend:'ai',scanBackend:'docling'});
  if(leaseLost)throw new Error('Heldout parse lease renewal failed');
  await finishIngestionJob(job.id,job.lease_token);
 }catch(error){await finishIngestionJob(job.id,job.lease_token,error.message);throw error;}
 finally{clearInterval(renew);}
}
if(process.argv.includes('--native-preflight')){
 const {nativePdfTextIsComplete}=await import('../lib/kernel/docling.ts');
 const {localPdfTextPages}=await import('../lib/local-ocr.ts');
 const records=[];
 for(const item of materials){
  const pages=await localPdfTextPages(await readFile(originalPath(item)));
  records.push({group:item.group,path:item.path,expectedPages:item.page_count,extractedPages:pages?.length||0,
   nativeCompleteWithoutBlankAllowance:nativePdfTextIsComplete(pages,item.page_count)});
 }
 await writeFile(join(root,'reports','native-preflight.json'),JSON.stringify({expectationSha256,records},null,2));
 console.log(JSON.stringify({action:'native-preflight',documents:records.length,
  requiresBlankVerificationOrComplexParser:records.filter(row=>!row.nativeCompleteWithoutBlankAllowance)}));
 await kernelPool().end();process.exit(0);
}
const owner='public-pdf-heldout-20261011';
const identities=new Map(),corpus=[];
const ingestOnly=process.argv.find(value=>value.startsWith('--only='))?.slice(7);
if(ingestOnly&&(!process.argv.includes('--ingest')||!materials.some(item=>`${item.group}/${basename(item.path)}`===ingestOnly)))
 throw new Error('--only requires --ingest and an exact group/original filename');
let nativeEligibility;
if(process.argv.includes('--native-only')){
 if(!process.argv.includes('--ingest'))throw new Error('--native-only requires --ingest');
 const preflight=JSON.parse(await readFile(join(root,'reports','native-preflight.json'),'utf8'));
 if(preflight.expectationSha256!==expectationSha256)throw new Error('Native preflight does not match frozen corpus');
 nativeEligibility=new Map(preflight.records.map(row=>[`${row.group}/${row.path}`,row.nativeCompleteWithoutBlankAllowance]));
}
try{
 await migrateKernel();
 const documents=await library.listDocuments(owner);
 for(const item of materials){
  const course=`heldout-${item.group}`,key=JSON.stringify([course,item.source_url]);
  let document=documents.find(row=>row.origin_key===key&&row.hash===item.sha256);
  let error=null,deferredReason=null;
  if(process.argv.includes('--ingest')){
   await kernel.upsertCourse({id:course,name:`Independent public ${item.group}`,course_code:`HOLDOUT-${item.group.toUpperCase()}`});
   if(!document){
    const id=await library.saveDocument(owner,course,'upload',item.source_url,item.title+'.pdf','application/pdf',await readFile(originalPath(item)));
    document=await library.getDocument(owner,id);
   }
   try{
    if(!(await kernel.parsedDocument(owner,document.id)).length){
     if(ingestOnly&&`${item.group}/${basename(item.path)}`!==ingestOnly)deferredReason='Outside selected ingestion file; retained in complete-corpus gate';
     else if(nativeEligibility&&nativeEligibility.get(`${item.group}/${item.path}`)!==true)deferredReason='Complex parser deferred; resource failure under investigation';
     else await convertDurably(document,owner);
    }
   }catch(failure){error=failure.message;}
  }
  const pages=document?await kernel.parsedDocument(owner,document.id):[];
  const status=document?(await library.getDocument(owner,document.id)).status:'missing';
  identities.set(`${item.group}/${item.path}`,document?.id);
  const record={group:item.group,path:item.path,sourceUrl:item.source_url,sha256:item.sha256,expectedPages:item.page_count,
   parsedPages:pages.length,status,characters:pages.reduce((sum,page)=>sum+page.body.length,0),
   extractionMethod:pages[0]?.extraction_method||null,parserVersion:pages[0]?.parser_version||null,
   complete:status==='ready'&&pages.length===item.page_count&&pages.every((page,index)=>page.page_number===index+1),error,deferredReason};
  corpus.push(record);
  if(process.argv.includes('--ingest'))console.log(JSON.stringify({action:'heldout-ingest',group:item.group,file:basename(item.path),
   parsedPages:record.parsedPages,complete:record.complete,method:record.extractionMethod,error}));
  await writeFile(join(root,'reports','coverage.json'),JSON.stringify({expectationSha256,corpus},null,2));
  if(error)throw new Error(`Failed parse retained in coverage report: ${item.group}/${item.path}: ${error}`);
 }
 if(process.argv.includes('--ingest')&&!process.argv.includes('--search'))process.exitCode=corpus.every(row=>row.complete)?0:1;
 else{
  const groupFilter=process.argv.find(value=>value.startsWith('--group='))?.slice(8);
  if(groupFilter&&!groups.includes(groupFilter))throw new Error('Invalid group filter');
  const aiRerank=process.argv.includes('--ai-rerank'),hybrid=process.argv.includes('--hybrid'),outcomes=[],startedAt=new Date().toISOString();
  const selected=expected.filter(row=>!groupFilter||row.group===groupFilter);
  const pathById=new Map([...identities].map(([path,id])=>[id,path]));
  const materialById=new Map(materials.map(item=>[identities.get(`${item.group}/${item.path}`),item]));
  async function provenanceErrors(hits){
   const ids=[...new Set(hits.map(hit=>hit.document_id).filter(id=>typeof id==='string'))];
   if(!ids.length)return hits.length;
   // Fresh current-head validation after each search catches stale cached
   // evidence as well as wrong page ranges, versions, sources and owner scope.
   const rows=(await kernelPool().query(`SELECT d.id,d.source_hash,v.source_version_id,p.page_number,p.evidence_id
    FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
    JOIN document_text_pages p ON p.version_id=v.id
    JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id
    WHERE d.owner_id=$1 AND d.hidden=false AND d.id=ANY($2::text[])`,[owner,ids])).rows;
   const current=new Map(rows.map(row=>[`${row.id}:${row.page_number}`,row]));
   return hits.filter(hit=>{
    const material=materialById.get(hit.document_id),page=current.get(`${hit.document_id}:${hit.page_number}`);
    return !material||!Number.isInteger(hit.page_number)||hit.page_number<1||hit.page_number>material.page_count||
     !page||page.source_hash!==material.sha256||!hit.evidence_id||page.evidence_id!==hit.evidence_id||
     !hit.source_version_id||page.source_version_id!==hit.source_version_id;
   }).length;
  }
  for(const group of groups.filter(group=>!groupFilter||group===groupFilter)){
   const questions=selected.filter(row=>row.group===group);let next=0;
   async function work(){
    while(next<questions.length){
     const question=questions[next++];
     for(const engine of ['kernel','library']){
      const started=performance.now();let hits=[],error=null;
      try{
       hits=engine==='kernel'?await kernel.searchDocumentText(owner,question.query,{limit:5,aiRerank,hybrid}):
        await library.searchLibrary(owner,question.query,'',aiRerank||hybrid,{limit:5,kernelSemantic:aiRerank,aiRerank,hybrid});
      }catch(failure){error=failure.message;}
      let invalidProvenance=0;
      try{invalidProvenance=await provenanceErrors(hits);}
      catch(failure){error=error||`Provenance verification failed: ${failure.message}`;invalidProvenance=hits.length||1;}
      const matches=hit=>question.expected.some(target=>identities.get(`${group}/${target.path}`)===hit.document_id&&target.pages.includes(hit.page_number));
      outcomes.push({id:question.id,group,engine,query:question.query,expected:question.expected,top5Page:hits.some(matches),
       top1Page:Boolean(hits[0]&&matches(hits[0])),error,durationMs:Math.round(performance.now()-started),
       provenanceErrors:invalidProvenance,
       fallback:hits.some(row=>row.retrieval_mode==='keyword-fallback'),componentDegraded:hits.some(row=>row.degraded_reason),
       hits:hits.map(row=>({path:pathById.get(row.document_id)||null,page:row.page_number,evidenceId:row.evidence_id,
        sourceVersionId:row.source_version_id,mode:row.retrieval_mode,degradedReason:row.degraded_reason,excerpt:row.body.slice(0,500)}))});
     }
    }
   }
   await Promise.all(Array.from({length:aiRerank||hybrid?2:1},work));
   await writeFile(join(root,'reports','progress.json'),JSON.stringify({expectationSha256,outcomes},null,2));
   console.log(JSON.stringify({action:'heldout-group-tested',group,count:questions.length}));
  }
  const summaries=[];
  for(const group of groups.filter(group=>!groupFilter||group===groupFilter))for(const engine of ['kernel','library']){
   const rows=outcomes.filter(row=>row.group===group&&row.engine===engine);
   summaries.push({group,engine,count:rows.length,top5Page:rows.filter(row=>row.top5Page).length/rows.length,
    errors:rows.filter(row=>row.error).length,fallbacks:rows.filter(row=>row.fallback).length,
    componentDegraded:rows.filter(row=>row.componentDegraded).length,provenanceErrors:rows.reduce((sum,row)=>sum+row.provenanceErrors,0)});
  }
  const coverageComplete=corpus.every(row=>row.complete);
  const algorithmUnchanged=(await algorithmFingerprint()).sha256===algorithmFreeze.sha256;
  const passed=coverageComplete&&algorithmUnchanged&&summaries.every(row=>row.count===50&&row.top5Page>=.95&&row.errors===0&&row.fallbacks===0&&row.componentDegraded===0&&row.provenanceErrors===0);
  const report={startedAt,completedAt:new Date().toISOString(),expectationSha256,algorithmBaseline:algorithmFreeze.revision||`source-sha256:${algorithmFreeze.sha256}`,algorithmFreeze,algorithmUnchanged,parserTransport:'docling-derived-v1',
   mode:hybrid?(aiRerank?'hybrid-ai-rerank':'hybrid'):(aiRerank?'ai-rerank':'keyword'),scope:'All three complete heldout corpora plus configured frozen distractors; no course/document filter',
   limitations:['PDF locator recall is not AI answer correctness, Truth Layer accuracy or formula transcription fidelity.',
    'English native-PDF learning corpora; public FAQ HTML is provenance only, not part of this PDF query score.'],
   questionGroups:groups,selectedGroups:groups.filter(group=>!groupFilter||group===groupFilter),completeThreeGroupGate:!groupFilter&&passed,
   corpus,coverageComplete,passed,summaries,failures:outcomes.filter(row=>!row.top5Page||row.error||row.fallback||row.componentDegraded||row.provenanceErrors),outcomes};
  await writeFile(join(root,'reports',`${hybrid?'hybrid-':''}${aiRerank?'ai':'keyword'}${groupFilter?'-'+groupFilter:''}.json`),JSON.stringify(report,null,2));
  console.log(JSON.stringify({action:'heldout-gate',passed,coverageComplete,expectationSha256,summaries}));
  if(!passed)process.exitCode=1;
 }
}finally{await kernelPool().end();}
