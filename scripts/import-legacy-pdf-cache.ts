import {createClient} from '@libsql/client';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {auditLegacyPdfCache,applyLegacyPdfCache,type LegacyPdfDocument,type LegacyPdfPage} from '../lib/kernel/legacy-pdf-cache.ts';
import {kernelPool,expectedKernelMigrationVersion} from '../lib/kernel/db.ts';

const args=process.argv.slice(2),value=(name:string)=>{const i=args.indexOf(name);return i<0?'':args[i+1]||'';};
const owner=value('--owner'),all=args.includes('--all-owners'),apply=args.includes('--apply');
const limit=Number(value('--limit')||20),offset=Number(value('--offset')||0),reportPath=value('--report');
if((!owner&&!all)||(owner&&all)||(apply&&all)||!reportPath)throw new Error(
 'Usage: npm run pdf:import-cache -- --owner <id> [--limit 20] [--offset 0] --report <private-file> [--apply]; --all-owners is audit-only');
if(!Number.isInteger(limit)||limit<1||limit>500||!Number.isInteger(offset)||offset<0)throw new Error('Invalid limit/offset');
// This administrator process never generates embeddings, parses documents or
// migrates schemas. Apply may queue only the existing durable text parser.
process.env.KERNEL_DOCUMENT_HYBRID='false';
const sqlite=createClient({url:process.env.DATABASE_URL||'file:./data/course-radar-v2.db',authToken:process.env.DATABASE_AUTH_TOKEN||undefined});
const records:Record<string,unknown>[]=[];
try{
 const where=`deleted=0 AND mime='application/pdf' ${owner?'AND owner_id=?':''}`;
 // Connection-local timeout and one brief read snapshot avoid per-file lock
 // races with the live SQLite writer. Release it before examining PDF bytes.
 await sqlite.execute('PRAGMA busy_timeout=5000');
 const snapshot=await sqlite.transaction('read');
 let total:number,documents:LegacyPdfDocument[],cached:Array<LegacyPdfPage&{document_id:string}>;
 try{
  total=Number((await snapshot.execute({sql:`SELECT count(*) n FROM library_documents WHERE ${where}`,args:owner?[owner]:[]})).rows[0].n);
  documents=(await snapshot.execute({sql:`SELECT id,owner_id,course_id,name,hash,mime,origin,origin_key,created_at,status,error
   FROM library_documents WHERE ${where} ORDER BY owner_id,id LIMIT ? OFFSET ?`,args:[...(owner?[owner]:[]),limit,offset]})).rows as unknown as LegacyPdfDocument[];
  cached=documents.length?(await snapshot.execute({sql:`SELECT document_id,parser,page,body FROM library_parse_pages
   WHERE document_id IN (${documents.map(()=>'?').join(',')}) ORDER BY document_id,parser,page`,args:documents.map(document=>document.id)})).rows as unknown as typeof cached:[];
 }finally{await snapshot.rollback();}
 let pgReady=false;
 if(process.env.KERNEL_DATABASE_URL){
  pgReady=(await kernelPool().query("SELECT to_regclass('document_texts') IS NOT NULL ready")).rows[0].ready;
  if(apply){
   const version=Number((await kernelPool().query('SELECT max(version) n FROM kernel_migrations')).rows[0].n);
   if(!pgReady||version!==expectedKernelMigrationVersion())throw new Error('Deploy and migrate the current kernel before --apply; this CLI does not migrate');
  }
 }else if(apply)throw new Error('KERNEL_DATABASE_URL required for --apply');
 for(const document of documents){
  try{
   if(!/^[a-f0-9]{64}$/u.test(document.hash))throw new Error('Invalid original blob hash');
   const bytes=await readFile(resolve(process.env.LIBRARY_DIR||'./data/library',document.hash));
   const rows=cached.filter(page=>page.document_id===document.id);
   const audited=await auditLegacyPdfCache(document,rows,bytes),{candidate,...summary}=audited;
   let head:unknown=null;
   if(pgReady)head=(await kernelPool().query('SELECT current_version_id,hidden FROM document_texts WHERE id=$1 AND owner_id=$2',[document.id,document.owner_id])).rows[0]||null;
   const record:Record<string,unknown>={...summary,legacyParser:candidate?.parser||null,currentPgHead:head};
   if(apply)Object.assign(record,await applyLegacyPdfCache(document,audited));
   records.push(record);
  }catch(error){records.push({documentId:document.id,ownerId:document.owner_id,decision:'error',reason:error instanceof Error?error.message:'Audit failed'});}
 }
 const counts=Object.fromEntries(['eligible','needs_parse','error'].map(state=>[state,records.filter(row=>row.decision===state).length]));
 const actionCounts={imported:records.filter(row=>row.action==='imported').length,
  protected:records.filter(row=>row.action==='protected-current-head').length,
  alreadyImported:records.filter(row=>row.action==='already-imported').length,
  queued:records.filter(row=>row.action==='queued-text-parse').length,
  blocked:records.filter(row=>row.action==='blocked-invalid-original'||(apply&&row.decision==='error')).length};
 await mkdir(dirname(resolve(reportPath)),{recursive:true,mode:0o700});
 await writeFile(resolve(reportPath),JSON.stringify({mode:apply?'apply':'audit',checkedAt:new Date().toISOString(),
  scope:{owner:owner||null,allOwners:all,limit,offset,total,nextOffset:offset+documents.length},pgReady,counts,actionCounts,records},null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({mode:apply?'apply':'audit',count:records.length,total,nextOffset:offset+documents.length,pgReady,counts,actionCounts}));
 if(counts.error)process.exitCode=1;
}finally{sqlite.close();if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}
