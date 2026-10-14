// Query-only calibration. Gold is read after retrieval solely for scoring.
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {assertCalibrationScope,readFrozenInput,sha256} from './text-calibration-input.mjs';

const args=process.argv.slice(2),option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const input=option('--input'),baselineFile=option('--baseline'),output=option('--output');
if(!input||!baselineFile||!output)throw new Error('Usage: benchmark-text-related.mjs --input FROZEN --baseline ORIGINAL_REPORT --output NEW_REPORT');
assertCalibrationScope(process.env.KERNEL_DATABASE_URL,process.env.KERNEL_SCHEMA);
const frozen=readFrozenInput(input),baselineBytes=readFileSync(baselineFile),baseline=JSON.parse(baselineBytes);
if(baseline.manifestSha256!==frozen.manifestSha256||baseline.schema!==process.env.KERNEL_SCHEMA||
  baseline.retrieval.filter(row=>row.dataset==='content').length!==50||baseline.persisted.documents!==9769)
  throw new Error('Reuse the complete original frozen corpus/schema/baseline, never a subset');
if(existsSync(output))throw new Error('Keep previous reports; choose a new output file');
mkdirSync(resolve(output,'..'),{recursive:true});
process.env.DATABASE_URL=':memory:';process.env.SERVICE_VAULT_DIR='/tmp/study-tests-text-related';
process.env.KERNEL_DOCUMENT_HYBRID='false';process.env.KERNEL_DOCUMENT_RERANK='false';
process.env.OPENAI_API_KEY='';process.env.AI_MONTHLY_BUDGET='0';process.env.CHATGPT_AUTO='false';
let networkAttempts=0;globalThis.fetch=async()=>{networkAttempts++;throw new Error('No network/model calls in query-only calibration');};
const paths=['lib/kernel/service.ts','lib/kernel/db.ts','lib/kernel/document-search.ts','lib/kernel/document-references.ts',
  'lib/kernel/document-vector.ts','lib/kernel/document-semantic.ts','lib/kernel/document-rerank.ts',
  'scripts/benchmark-text-related.mjs','scripts/text-calibration-input.mjs'];
const fingerprints=()=>Object.fromEntries(paths.map(path=>[path,sha256(readFileSync(resolve(path),'utf8').replace(/\r\n/gu,'\n'))]));
const codeSha256=fingerprints(),started=performance.now();
const report={purpose:'one query-only related-document calibration, not three-state/full answer acceptance',
  database:'pdf_acceptance_20261006',schema:baseline.schema,owner:baseline.owner,baseCommit:frozen.manifest.baseCommit,
  manifestSha256:frozen.manifestSha256,baselineReportSha256:sha256(baselineBytes),codeSha256,
  startedAt:new Date().toISOString(),options:{relatedDocuments:true,limit:14,semantic:false,hybrid:false,aiRerank:false},
  rows:[],answers:{status:'pending',evaluated:0},ingestionCalls:0,paidAiCalls:0,fullGoalPassed:false};
const save=()=>writeFileSync(output,JSON.stringify(report,null,2));
const {kernel}=await import('../lib/kernel/service.ts');
const {kernelPool}=await import('../lib/kernel/db.ts');
const pool=kernelPool();
try{
  // All calls are sequential and use this one preconfigured pool connection.
  const client=await pool.connect();
  try{await client.query('SET default_transaction_read_only=on');await client.query("SET statement_timeout='15s'");}
  finally{client.release();}
  const state=(await pool.query("SELECT current_database() database,current_schema() schema,current_setting('default_transaction_read_only') readonly")).rows[0];
  if(state.database!==report.database||state.schema!==report.schema||state.readonly!=='on')throw new Error('Actual isolated/read-only database identity mismatch');
  const documents=readFileSync(resolve(frozen.root,'content.documents.jsonl'),'utf8').trimEnd().split('\n').map(line=>JSON.parse(line));
  const expected=new Map(documents.map(doc=>[doc.id,doc]));
  const heads=(await pool.query(`SELECT id,source_hash,course_id,current_version_id FROM document_texts
    WHERE owner_id=$1 AND NOT hidden ORDER BY id`,[report.owner])).rows;
  if(heads.length!==9769||heads.some(head=>head.source_hash!==expected.get(head.id)?.hash||head.course_id!==expected.get(head.id)?.courseId||!head.current_version_id))
    throw new Error('Actual PG corpus differs from the frozen complete 9769 documents');
  report.stateFingerprintBefore=sha256(JSON.stringify(heads));report.actualDatabaseState=state;save();
  const previous=new Map(baseline.retrieval.map(row=>[row.id,row]));
  for(const row of frozen.cases.filter(row=>row.dataset==='content')){
    const before=performance.now();
    const hits=await kernel.searchDocumentText(report.owner,row.query,{...row.scope,...report.options});
    const queryMs=performance.now()-before;
    if(hits.length>14)throw new Error('Do not increase the original final source limit');
    const current=(await pool.query(`SELECT d.id document_id,d.source_hash,v.source_version_id,p.page_number,p.evidence_id
      FROM document_texts d JOIN document_text_versions v ON v.id=d.current_version_id
      JOIN document_text_pages p ON p.version_id=v.id
      JOIN evidence e ON e.id=p.evidence_id AND e.source_version_id=v.source_version_id
      WHERE d.owner_id=$1 AND NOT d.hidden AND d.course_id=$2 AND d.id=ANY($3::text[])`,
      [report.owner,row.scope.courseId,hits.map(hit=>hit.document_id)])).rows;
    const identity=hit=>JSON.stringify([hit.document_id,Number(hit.page_number),hit.source_version_id,hit.evidence_id,hit.source_hash]);
    const valid=new Set(current.map(identity)),validEvidence=hits.every(hit=>hit.course_id===row.scope.courseId&&valid.has(identity(hit)));
    if(!validEvidence)throw new Error('A returned hit failed current owner/course/source/evidence validation');
    const old=previous.get(row.id),oldIds=new Set(old.hits.map(hit=>hit.documentId)),newIds=new Set(hits.map(hit=>hit.document_id));
    const oldGold=row.expectedDocumentIds.filter(id=>oldIds.has(id)),newGold=row.expectedDocumentIds.filter(id=>newIds.has(id));
    const passed=newGold.length===row.expectedDocumentIds.length;
    report.rows.push({id:row.id,query:row.query,expectedOriginalSources:row.expectedOriginalSources,expectedDocumentIds:row.expectedDocumentIds,
      previousPassed:old.passed,passed,improved:!old.passed&&passed,regressed:old.passed&&!passed,
      previousGoldDocuments:oldGold,currentGoldDocuments:newGold,goldCoverageDelta:newGold.length-oldGold.length,
      queryMs:Number(queryMs.toFixed(3)),validEvidence,hits:hits.map(hit=>({documentId:hit.document_id,courseId:hit.course_id,
        name:hit.name,pageNumber:hit.page_number,sourceHash:hit.source_hash,sourceVersionId:hit.source_version_id,evidenceId:hit.evidence_id,locator:hit.locator}))});
    save();
  }
  const after=(await pool.query(`SELECT id,source_hash,course_id,current_version_id FROM document_texts
    WHERE owner_id=$1 AND NOT hidden ORDER BY id`,[report.owner])).rows;
  report.stateFingerprintAfter=sha256(JSON.stringify(after));
  report.corpusUnchanged=report.stateFingerprintBefore===report.stateFingerprintAfter;
  report.codeUnchanged=JSON.stringify(codeSha256)===JSON.stringify(fingerprints());
  if(!report.corpusUnchanged||!report.codeUnchanged)throw new Error('Do not compare a moving corpus or code state');
  const times=report.rows.map(row=>row.queryMs).sort((a,b)=>a-b);
  report.completedAt=new Date().toISOString();report.elapsedMs=Math.round(performance.now()-started);
  report.summary={queries:50,previousPassed:baseline.summary.retrievalByCorpus.content.passed,passed:report.rows.filter(row=>row.passed).length,
    improved:report.rows.filter(row=>row.improved).length,regressed:report.rows.filter(row=>row.regressed).length,
    evidenceValidated:report.rows.filter(row=>row.validEvidence).length,medianQueryMs:times[24],p95QueryMs:times[47],
    networkAttempts,paidAiCalls:0,answersPending:true,fullGoalPassed:false};save();
  console.log(JSON.stringify({state:'query_only_calibration_completed',...report.summary}));
}catch(error){report.failure={name:error.name,message:error.message};save();throw error;
}finally{await pool.end();}
