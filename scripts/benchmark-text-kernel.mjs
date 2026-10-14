// Offline calibration through current KernelService, not legacy SQLite seeding.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {assertCalibrationScope,readFrozenInput,sha256} from './text-calibration-input.mjs';

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
if(!option('--input')||!option('--output'))throw new Error('Usage: benchmark-text-kernel.mjs --input FROZEN --output NEW_REPORT_DIR [--corpora content]');
assertCalibrationScope(process.env.KERNEL_DATABASE_URL,process.env.KERNEL_SCHEMA);
const frozen=readFrozenInput(option('--input')),selected=(option('--corpora')||'content').split(',');
if(selected.some(name=>!Object.hasOwn(frozen.manifest.corpora,name)))throw new Error('Unknown frozen corpus');
for(const [path,hash] of Object.entries(frozen.manifest.codeSha256)){
  if(sha256(readFileSync(resolve(path),'utf8').replace(/\r\n/gu,'\n'))!==hash)throw new Error(`Frozen code differs: ${path}`);
}
const output=resolve(option('--output'));
if(existsSync(output))throw new Error('Use a new report directory; never overwrite a previous state');
mkdirSync(output,{recursive:true});
process.env.DATABASE_URL=':memory:';
process.env.SERVICE_VAULT_DIR=resolve(output,'empty-private');
process.env.LIBRARY_DIR='/pdf-data/text-calibration-no-originals';
process.env.KERNEL_DOCUMENT_HYBRID='false';process.env.KERNEL_DOCUMENT_RERANK='false';
process.env.CHATGPT_AUTO='false';process.env.OPENAI_API_KEY='';process.env.AI_MONTHLY_BUDGET='0';
let networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw new Error('Network/model calls are prohibited in offline calibration');};
const admin=new Pool({connectionString:process.env.KERNEL_DATABASE_URL,max:1});
const schema=process.env.KERNEL_SCHEMA,owner=`text-calibration:${schema}`;
const started=performance.now();
const report={purpose:'calibration baseline, not full three-state acceptance',schema,owner,
  startedAt:new Date().toISOString(),
  baseCommit:frozen.manifest.baseCommit,manifestSha256:frozen.manifestSha256,codeSha256:frozen.manifest.codeSha256,
  selectedCorpora:selected,truth:[],retrieval:[],answers:{status:'pending',evaluated:0},
  originalFailuresPreserved:true,paidAiCalls:0,fullGoalPassed:false};
const save=()=>writeFileSync(resolve(output,'report.json'),JSON.stringify(report,null,2));
try{
  const current=(await admin.query('SELECT current_database() name')).rows[0].name;
  if(current!=='pdf_acceptance_20261006')throw new Error('Isolated database identity mismatch');
  if((await admin.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=$1',[schema])).rowCount)
    throw new Error('Calibration needs a fresh schema; preserve previous progress');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const {kernel}=await import('../lib/kernel/service.ts');
  const {migrateKernel,kernelPool}=await import('../lib/kernel/db.ts');
  try{
    await migrateKernel();
    // Recreate the same original controlled Truth fixtures via canonical APIs.
    for(let number=1;number<=5;number++){
      const id=`kqa-course-${number}`,code=`KQA10${number}`;
      await kernel.upsertCourse({id,course_code:code,name:`Benchmark Course ${number}`,enabled:true},'canvas');
      for(let task=1;task<=5;task++){
        const index=(number-1)*5+task,date=`2026-10-${String(index).padStart(2,'0')}`;
        const item={id:`${id}:assignment:${task}`,courseId:id,sourceType:'assignment',sourceId:String(task),
          title:`${code} Assignment ${String(task).padStart(2,'0')}`,body:`Original assignment ${task} for ${code}.`,
          sourceUrl:`https://example.org/${code}/${task}`,updatedAt:'2026-09-28T00:00:00Z',
          dueAt:index%2?date:`${date}T14:30:00Z`,unlockAt:null,lockAt:null};
        await kernel.ingestCanvasSource(item,null,sha256(JSON.stringify(item)));
        if(task<=2)await kernel.setTaskStatus(item.id+':0','completed',false);
      }
    }
    for(let number=1;number<=10;number++){
      const date=`2026-11-${String(number).padStart(2,'0')}`;
      await kernel.ingestEvent('benchmark',{uid:`seminar-${number}`,title:`Research Seminar ${String(number).padStart(2,'0')}`,
        description:`Seminar number ${number}`,startAt:`${date}T13:00:00Z`,endAt:`${date}T14:00:00Z`,allDay:false});
    }
    const events=await kernel.listEvents('2026-11-01T00:00:00Z','2026-12-01T00:00:00Z');
    for(const row of frozen.truth){
      let actual,evidence,precisionCorrect=true;
      if(row.kind==='course'){
        actual=(await kernel.getCourse(row.courseId))?.name;
        evidence=(await kernel.canonicalEvidence([row.courseId],[],[])).filter(item=>item.attribute==='course_payload');
      }else if(row.kind==='event'){
        actual=events.find(item=>item.id===row.eventId)?.startAt;
        evidence=(await kernel.canonicalEvidence([],[],[row.eventId])).filter(item=>item.attribute==='event_payload');
      }else{
        const task=(await kernel.taskRows(row.courseId)).find(item=>item.id===row.taskId);
        actual=row.kind==='status'?task?.local_status:task?.due_date;
        evidence=(await kernel.canonicalEvidence([],[row.taskId],[])).filter(item=>item.attribute===(row.kind==='status'?'local_status':'due'));
        if(row.kind==='due'){
          const sequence=(Number(row.courseId.split('-').at(-1))-1)*5+Number(row.taskId.split(':').at(-2));
          precisionCorrect=task?.due_precision===(sequence%2?'date':'second')&&(sequence%2?task?.due_local_time===null:task?.due_timezone==='Etc/UTC');
        }
      }
      const expectedSource=row.kind==='course'?`canvas:course:${row.courseId}`:row.kind==='event'?row.eventId:
        row.kind==='status'?`manual:status:${row.taskId}`:row.taskId.slice(0,-2);
      const valueCorrect=String(actual||'').includes(row.expected),evidenceCorrect=evidence.some(item=>item.source_item_id===expectedSource&&item.original_excerpt&&item.acquired_at);
      report.truth.push({question:row.question,kind:row.kind,expected:row.expected,actual,expectedSource,valueCorrect,evidenceCorrect,
        precisionCorrect,passed:valueCorrect&&evidenceCorrect&&precisionCorrect,evidence});
    }
    report.ingestion={documents:0,textSegments:0,bytes:0};save();
    const sourceSegments=new Map();
    for(const dataset of selected){
      for(const courseId of frozen.manifest.corpora[dataset].courses)
        await kernel.upsertCourse({id:courseId,name:`Calibration ${courseId}`,course_code:courseId,enabled:true},'legacy_import');
      const rows=readFileSync(resolve(frozen.root,dataset+'.documents.jsonl'),'utf8').trimEnd().split('\n');
      for(const line of rows){
        const doc=JSON.parse(line),pages=doc.pages.map((page,index)=>({pageNumber:index+1,locator:page.locator,text:page.text}));
        await kernel.ingestParsedDocument({id:doc.id,ownerId:owner,courseId:doc.courseId,name:doc.name,hash:doc.hash,
          mime:'text/plain',origin:`calibration:${dataset}`,originKey:doc.originalId,
          rawUri:`calibration-cache://sha256/${doc.source.cacheSha256}#${encodeURIComponent(doc.originalId)}`},pages,
          {parserVersion:'frozen-cached-text-v1',extractionMethod:'cached-public-text',
            warnings:['Cached text calibration; not a binary PDF/parser accuracy test'],batchProvenance:doc.source,evidenceConfidence:0.9});
        sourceSegments.set(doc.id,doc.pages.map(page=>page.originalChunkId));
        report.ingestion.documents++;report.ingestion.textSegments+=pages.length;report.ingestion.bytes+=Buffer.byteLength(line);
        if(report.ingestion.documents%500===0){save();console.log(JSON.stringify({state:'ingesting',documents:report.ingestion.documents}));}
      }
    }
    for(const row of frozen.cases.filter(item=>selected.includes(item.dataset))){
      const limit=row.retrievalLimit||(row.dataset==='qasper'?80:18);
      const hits=await kernel.searchDocumentText(owner,row.query,{...row.scope,semantic:false,aiRerank:false,hybrid:false,limit});
      const found=new Set(hits.map(hit=>hit.document_id)),allSourcesFound=row.expectedDocumentIds.every(id=>found.has(id));
      const foundChunks=hits.map(hit=>sourceSegments.get(hit.document_id)?.[hit.page_number-1]);
      const expectedSegmentFound=row.expectedOriginalChunkIds?row.expectedOriginalChunkIds.some(id=>foundChunks.includes(id)):null;
      report.retrieval.push({...row,limit,allSourcesFound,expectedSegmentFound,
        passed:row.criterion==='any-gold-text-segment'?Boolean(expectedSegmentFound):allSourcesFound,
        evidencePresent:hits.every(hit=>Boolean(hit.evidence_id)&&Boolean(hit.source_version_id)),
        hits:hits.map(hit=>({documentId:hit.document_id,originalChunkId:sourceSegments.get(hit.document_id)?.[hit.page_number-1],
          courseId:hit.course_id,evidenceId:hit.evidence_id,sourceVersionId:hit.source_version_id,locator:hit.locator,score:hit.score}))});
    }
    const sample=report.retrieval[0];
    report.ownerIsolationPassed=(await kernel.searchDocumentText('wrong-owner',sample.query,{...sample.scope,semantic:false,aiRerank:false,hybrid:false})).length===0;
    report.persisted=(await kernelPool().query(`SELECT count(DISTINCT d.id)::integer documents,count(*)::integer text_segments,
      count(e.id)::integer evidence,count(s.id)::integer source_versions
      FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
      JOIN document_text_pages p ON p.version_id=v.id
      JOIN evidence e ON e.id=p.evidence_id JOIN source_item_versions s ON s.id=v.source_version_id
      WHERE d.owner_id=$1`,[owner])).rows[0];
    report.summary={truthStructuredPassed:report.truth.filter(row=>row.passed).length,truthStructuredTotal:50,
      retrievalByCorpus:Object.fromEntries(selected.map(name=>[name,{passed:report.retrieval.filter(row=>row.dataset===name&&row.passed).length,total:50}])),
      answerAccuracy:'pending; retrieval and structured Truth are not natural-language answer evaluation',networkAttempts,paidAiCalls:0};
    report.completedAt=new Date().toISOString();report.elapsedMs=Math.round(performance.now()-started);save();
    console.log(JSON.stringify({state:'calibration_baseline_finished',...report.summary,fullGoalPassed:false}));
  }finally{await kernelPool().end();}
}catch(error){report.failure={name:error.name,message:error.message};save();throw error;
}finally{await admin.end();}
