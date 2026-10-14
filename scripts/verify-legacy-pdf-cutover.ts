import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {kernelPool} from '../lib/kernel/db.ts';

// Deployment receipt only: PostgreSQL versions/evidence/jobs must still prove
// the completed import. Never reread PDFs or overwrite a current document head.
const args=process.argv.slice(2),value=(key:string)=>args[args.indexOf(key)+1];
const pg=kernelPool(),name='v0-pdf-cache:local-owner';
try{
 const saved=(await pg.query('SELECT counts FROM kernel_imports WHERE name=$1',[name])).rows[0]?.counts;
 const explicit=args.includes('--report')?value('--report'):undefined;
 const previous=args.includes('--previous')?value('--previous'):'';
 if(!explicit&&!saved&&!/^[a-f0-9]{40}$/u.test(previous||'')){process.exitCode=2;}
 else {
  const path=explicit||saved?.reportPath||`/app/data/private/pdf-cache-cutover-${previous}.json`;
  if(!/^\/app\/data\/private\/pdf-cache-cutover-[a-f0-9]{40}\.json$/u.test(path))throw new Error('Invalid PDF migration receipt path');
  let bytes:Buffer|undefined;
  try{bytes=await readFile(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!bytes){process.exitCode=2;}
  else {
   const hash=createHash('sha256').update(bytes).digest('hex'),r=JSON.parse(bytes.toString('utf8')),a=r.actionCounts;
   if((!explicit&&saved&&saved.reportSha256!==hash)||r.mode!=='apply'||r.scope?.owner!=='local-owner'||r.scope.offset!==0||
     !Number.isInteger(r.scope.total)||r.scope.total<0||r.scope.total>500||!Array.isArray(r.records)||r.records.length!==r.scope.total||
     r.counts?.error!==0||!a||a.blocked!==0||
     ['imported','protected','alreadyImported','queued'].some(key=>!Number.isInteger(a[key])||a[key]<0)||
     a.imported+a.protected+a.alreadyImported+a.queued!==r.scope.total)throw new Error('Incomplete PDF migration receipt');
   const ids=new Set<string>();
   for(const row of r.records){
    if(row.ownerId!=='local-owner'||typeof row.documentId!=='string'||ids.has(row.documentId)||
      !/^[a-f0-9]{64}$/u.test(row.sourceHash)||!Number.isInteger(row.originalPages)||row.originalPages<1||row.originalPages>500||
      !['imported','already-imported','protected-current-head','queued-text-parse'].includes(row.action))throw new Error('Invalid PDF migration record');
    ids.add(row.documentId);
   }
   const counts={imported:0,protected:0,alreadyImported:0,queued:0};
   for(const row of r.records){const key=row.action==='imported'?'imported':row.action==='already-imported'?'alreadyImported':row.action==='protected-current-head'?'protected':'queued';counts[key]++;}
   if(Object.keys(counts).some(key=>counts[key as keyof typeof counts]!==a[key]))throw new Error('PDF migration actions do not reconcile');
   // One metadata query: retain historical versions even if newer parsing or
   // hiding has changed the current head. Queued work is not claimed complete.
   const proof=(await pg.query<{valid:boolean}>(`WITH receipts AS (SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS r("documentId" text,"ownerId" text,"sourceHash" text,"originalPages" int,action text,"versionId" text,"jobId" text))
    SELECT bool_and(CASE WHEN r.action IN ('imported','already-imported') THEN EXISTS (
      SELECT 1 FROM document_text_versions v JOIN document_texts d ON d.id=v.document_id
      JOIN source_item_versions s ON s.id=v.source_version_id
      WHERE v.id=r."versionId" AND d.id=r."documentId" AND d.owner_id=r."ownerId"
        AND s.raw_sha256=r."sourceHash" AND v.page_count=r."originalPages"
        AND (SELECT count(*) FROM document_text_pages p JOIN evidence e ON e.id=p.evidence_id
          WHERE p.version_id=v.id AND e.source_version_id=v.source_version_id)=v.page_count)
     WHEN r.action='queued-text-parse' THEN EXISTS (SELECT 1 FROM ingestion_jobs j WHERE j.id=r."jobId"
       AND j.kind='docling_document' AND j.payload->>'owner'=r."ownerId" AND j.payload->>'id'=r."documentId"
       AND j.payload->>'sourceHash'=r."sourceHash")
     ELSE EXISTS (SELECT 1 FROM document_texts d WHERE d.id=r."documentId" AND d.owner_id=r."ownerId"
       AND (d.hidden OR d.current_version_id IS NOT NULL)) END) AS valid FROM receipts r`,[JSON.stringify(r.records)])).rows[0];
   if(r.scope.total>0&&!proof.valid)throw new Error('PostgreSQL no longer proves the PDF migration receipt');
   if(!args.includes('--check'))await pg.query('INSERT INTO kernel_imports(name,counts) VALUES ($1,$2) ON CONFLICT(name) DO NOTHING',
    [name,JSON.stringify({reportPath:path,reportSha256:hash,total:r.scope.total,actionCounts:a})]);
   console.log(JSON.stringify({action:'reuse-pdf-cache-cutover',reportPath:path,total:r.scope.total,actionCounts:a,
    note:'PostgreSQL history/evidence/jobs verified; queued parsing and vectors may remain incomplete'}));
  }
 }
}finally{await pg.end();}
