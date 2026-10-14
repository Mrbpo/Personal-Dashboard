import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {auditCachedDoclingReplay,applyCachedDoclingReplay,type CachedDoclingAudit} from '../lib/kernel/docling-cache-replay.ts';
import {kernelPool,expectedKernelMigrationVersion} from '../lib/kernel/db.ts';

const args=process.argv.slice(2),value=(name:string)=>{const index=args.indexOf(name);return index<0?'':args[index+1]||'';};
const owner=value('--owner'),documentId=value('--document'),expected=value('--expected-version'),reportPath=value('--report');
const reviewPath=value('--review-report'),apply=args.includes('--apply'),limit=Number(value('--limit')||20),offset=Number(value('--offset')||0);
if(!owner||!reportPath||!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0||
 (apply&&(!documentId||!expected||!reviewPath||resolve(reviewPath)===resolve(reportPath))))throw new Error(
 'Usage: pdf:replay-cache -- --owner <owner> [--document <id>] [--limit 20] [--offset 0] --report <private-path>; apply additionally requires --document --expected-version --review-report and a separate output report');
if(!process.env.KERNEL_DATABASE_URL)throw new Error('KERNEL_DATABASE_URL required; this CLI does not migrate');
// No inline indexing/model work. The administrator may separately queue the
// existing versioned vector jobs after reviewing publication and scope freeze.
process.env.KERNEL_DOCUMENT_HYBRID='false';
const pool=kernelPool(),records:Array<CachedDoclingAudit|{documentId:string;decision:'error';reason:string;action?:unknown}>=[];
try{
 if(apply&&Number((await pool.query('SELECT max(version) version FROM kernel_migrations')).rows[0].version)!==expectedKernelMigrationVersion())
  throw new Error('Apply requires the current migrated kernel; this CLI does not migrate');
 const count=Number((await pool.query('SELECT count(*) n FROM document_texts WHERE owner_id=$1 AND NOT hidden AND ($2::text IS NULL OR id=$2)',
  [owner,documentId||null])).rows[0].n);
 const ids=(await pool.query<{id:string}>(`SELECT id FROM document_texts WHERE owner_id=$1 AND NOT hidden AND current_version_id IS NOT NULL
  AND ($2::text IS NULL OR id=$2) ORDER BY id LIMIT $3 OFFSET $4`,[owner,documentId||null,limit,offset])).rows;
 if(documentId&&ids.length!==1)throw new Error('Requested current document unavailable in this owner scope');
 for(const {id} of ids){
  try{
   const audited=await auditCachedDoclingReplay(owner,id);
   if(apply){
    const reviewed=JSON.parse(await readFile(resolve(reviewPath),'utf8')) as {mode:string;owner:string;records:CachedDoclingAudit[]};
    const approved=reviewed.records?.find(row=>row.documentId===id);
    if(reviewed.mode!=='audit'||reviewed.owner!==owner||!approved)throw new Error('Reviewed audit does not match this owner/document');
    records.push({...audited,...await applyCachedDoclingReplay(approved,expected)});
   }else records.push(audited);
  }catch(error){records.push({documentId:id,decision:'error',reason:error instanceof Error?error.message:'Cached replay failed'});}
 }
 const counts=Object.fromEntries(['eligible','unchanged','error'].map(decision=>[decision,records.filter(row=>row.decision===decision).length]));
 const actions=Object.fromEntries(['published','unchanged'].map(action=>[action,records.filter(row=>'action' in row&&row.action===action).length]));
 await mkdir(dirname(resolve(reportPath)),{recursive:true,mode:0o700});
 await writeFile(resolve(reportPath),JSON.stringify({mode:apply?'apply':'audit',checkedAt:new Date().toISOString(),owner,
  scope:{documentId:documentId||null,limit,offset,total:count,nextOffset:offset+ids.length},counts,actions,records},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({mode:apply?'apply':'audit',count:records.length,total:count,counts,actions}));
 if(counts.error)process.exitCode=1;
}finally{await pool.end();}
