import {database as db} from '../lib/database.ts';
import {claimJob,enqueue,finishJob,nightKey,acquireLease,releaseLease} from '../lib/jobs.ts';
import {indexDocument,embedMissing,saveDocument,collectUnusedBlobs} from '../lib/library.ts';
import {PDF_PARSER_VERSION} from '../lib/document-parser.ts';
import {syncPiazza} from '../lib/piazza-sync.ts';
import {generatePiazzaWeekSummary} from '../lib/piazza-ai.ts';
import {syncGmail} from '../lib/gmail.ts';
import {analyzeMailIntelligence,queueNightMailMaintenance} from '../lib/mail-intelligence.ts';
import {archiveCanvas,archiveCanvasCourse} from '../lib/canvas-archive.ts';
import {getIntegrationConnection} from '../lib/repository.ts';
import {getPiazzaAutoLoginStatus} from '../lib/piazza-auto-login.ts';
import {serviceValue} from '../lib/service-vault.ts';
import {indexMemories} from '../lib/tutor-memory.ts';
import {enqueueCodexMaintenance} from '../lib/codex-maintenance.ts';
const owner='local-owner';let stopping=false,cleanedLegacyQueue=false,queuedDocumentBackfill=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
type PiazzaArchiveRow={id:string;course_id:string;title:string;body:string};
type PendingDocumentRow={id:string;owner_id:string};
const primaryToken=crypto.randomUUID();
async function tick(){const now=Date.now();await db.prepare("INSERT INTO worker_state VALUES ('primary',?,0) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat").bind(now).run();const state=await db.prepare("SELECT paused FROM worker_state WHERE id='primary'").first<{paused:number}>();if(state?.paused)return;
 if(!cleanedLegacyQueue){await db.prepare("DELETE FROM background_jobs WHERE kind='index' AND status='queued' AND id NOT LIKE 'index:%'").run();cleanedLegacyQueue=true;}
 if(!queuedDocumentBackfill){const docs=(await db.prepare("SELECT d.id,d.owner_id FROM library_documents d WHERE d.deleted=0 AND ((d.status!='ready' AND d.mime IN ('application/pdf','application/octet-stream')) OR (d.mime='application/pdf' AND NOT EXISTS (SELECT 1 FROM library_parse_pages p WHERE p.document_id=d.id AND p.parser=?))) LIMIT 500").bind(PDF_PARSER_VERSION).all<PendingDocumentRow>()).results;for(const d of docs)await enqueue('index',{owner:d.owner_id,id:d.id},`index:${d.id}`,true);queuedDocumentBackfill=true;}
 if(process.env.SYNC_PRIMARY==='true'){
 if(serviceValue('CANVAS_TOKEN'))await enqueue('canvas',{owner},`canvas:${Math.floor(now/900000)}`);
 if((await getIntegrationConnection('gmail'))?.status==='connected')await enqueue('gmail',{owner},`gmail:${Math.floor(now/900000)}`);
 const piazza=await getIntegrationConnection('piazza');if(piazza&&(['connected','error'].includes(piazza.status)||piazza.status==='needs_reconnect'&&(await getPiazzaAutoLoginStatus()).enabled))await enqueue('piazza',{owner},`piazza:${Math.floor(now/1800000)}`);
 const night=nightKey();if(night)await enqueue('night',{owner},`night:${night}`);
 }
 const job=await claimJob();if(!job)return;const renew=setInterval(()=>{void db.batch([db.prepare('UPDATE background_jobs SET lease_until=? WHERE id=? AND lease_token=?').bind(Date.now()+180000,job.id,job.lease_token),db.prepare("UPDATE worker_state SET heartbeat=? WHERE id='primary'").bind(Date.now())]);},30000);
 try{const p=JSON.parse(job.payload);switch(job.kind){case 'memory-index':await indexMemories(p.owner);break;case 'index':await indexDocument(p.owner,p.id);await embedMissing(p.owner);break;case 'embed':await embedMissing(p.owner);break;case 'canvas':await archiveCanvas(p.owner);break;case 'canvas-course':await archiveCanvasCourse(p.owner,p.course);break;case 'gmail':{const r=await syncGmail();if(r.more||r.rescan)await enqueue('gmail',p);break;}case 'mail-intelligence':await analyzeMailIntelligence(p.owner,p.id,Boolean(p.force));break;case 'mail-night-maintenance':{const r=await queueNightMailMaintenance(p.owner,p.night);if(r.more)await enqueue('mail-night-maintenance',p);break;}case 'piazza-ai-week':await generatePiazzaWeekSummary(p.weekStart);break;case 'piazza':await syncPiazza();{const posts=(await db.prepare('SELECT id,course_id,title,body FROM piazza_posts WHERE is_active=1').all<PiazzaArchiveRow>()).results;for(const post of posts){const id=await saveDocument(p.owner,post.course_id,'piazza',post.id,post.title+'.txt','text/plain',Buffer.from(post.body));await enqueue('index',{owner:p.owner,id},`index:${id}`);}}break;case 'night':{await enqueue('memory-index',{owner:p.owner});const gmail=await getIntegrationConnection('gmail');if(gmail?.status==='connected'){const night=nightKey()||new Date().toISOString().slice(0,10),mail=await queueNightMailMaintenance(p.owner,night);if(mail.more)await enqueue('mail-night-maintenance',{owner:p.owner,night});}await collectUnusedBlobs();const docs=(await db.prepare("SELECT d.id,d.owner_id FROM library_documents d WHERE d.deleted=0 AND ((d.status!='ready' AND (d.status='pending' OR d.mime LIKE 'text/%' OR d.mime LIKE 'image/%' OR d.mime IN ('application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/octet-stream'))) OR (d.mime='application/pdf' AND NOT EXISTS (SELECT 1 FROM library_parse_pages p WHERE p.document_id=d.id AND p.parser=?))) LIMIT 100").bind(PDF_PARSER_VERSION).all<PendingDocumentRow>()).results;for(const d of docs)await enqueue('index',{owner:d.owner_id,id:d.id},`index:${d.id}`,true);for(let i=0;i<20&&!stopping;i++){if(!(await embedMissing(p.owner)))break;}break;}default:throw new Error('未知任务');}await finishJob(job.id,job.lease_token);}
 catch(e){const message=e instanceof Error&&/^[\u3400-\u9fff]/.test(e.message)?e.message.slice(0,200):'后台任务失败，请检查授权或稍后重试';if(job.attempts<3)await db.prepare("UPDATE background_jobs SET status='queued',error=?,available_at=?,lease_until=NULL WHERE id=? AND lease_token=?").bind(message,Date.now()+60000*2**job.attempts,job.id,job.lease_token).run();else{if(job.kind==='gmail')await db.prepare("UPDATE mail_sync SET import_status='error' WHERE import_status='running'").run();await finishJob(job.id,job.lease_token,message);await enqueueCodexMaintenance(owner,{sourceType:'background-job',sourceId:job.id,title:`修复失败的后台任务：${job.kind}`,detail:message,metadata:{kind:job.kind,attempts:job.attempts}}).catch(()=>undefined);}}
 finally{clearInterval(renew);}}
// A shared database permits only one executor, including during rolling restarts.
// A replacement worker waits for an old lease to expire instead of exiting in a
// restart loop. Once primary, it renews the same token until shutdown.
let primary=false;
const primaryRenew=setInterval(()=>{if(!primary)return;void acquireLease('worker-primary',primaryToken).then(ok=>{if(!ok)primary=false;}).catch(()=>{primary=false;});},30000);
try{while(!stopping){try{if(!primary)primary=await acquireLease('worker-primary',primaryToken);if(primary)await tick();}catch{console.warn('[worker] tick failed; retrying without exposing provider data');}await new Promise(r=>setTimeout(r,2000));}}
finally{clearInterval(primaryRenew);if(primary)await releaseLease('worker-primary',primaryToken);}
