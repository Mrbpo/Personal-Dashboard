import {database as db} from '../lib/database.ts';
import {claimJob,enqueue,finishJob,nightKey,acquireLease,releaseLease} from '../lib/jobs.ts';
import {indexDocument,embedMissing,saveDocument,collectUnusedBlobs} from '../lib/library.ts';
import {syncPiazza} from '../lib/piazza-sync.ts';
import {syncGmail} from '../lib/gmail.ts';
import {archiveCanvas,archiveCanvasCourse} from '../lib/canvas-archive.ts';
import {getIntegrationConnection} from '../lib/repository.ts';
import {serviceValue} from '../lib/service-vault.ts';
import {indexMemories} from '../lib/tutor-memory.ts';
const owner='local-owner';let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const primaryToken=crypto.randomUUID();
async function tick(){const now=Date.now();await db.prepare("INSERT INTO worker_state VALUES ('primary',?,0) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat").bind(now).run();const state=await db.prepare("SELECT paused FROM worker_state WHERE id='primary'").first<{paused:number}>();if(state?.paused)return;
 if(process.env.SYNC_PRIMARY==='true'){
 if(serviceValue('CANVAS_TOKEN'))await enqueue('canvas',{owner},`canvas:${Math.floor(now/900000)}`);
 if((await getIntegrationConnection('gmail'))?.status==='connected')await enqueue('gmail',{owner},`gmail:${Math.floor(now/900000)}`);
 if((await getIntegrationConnection('piazza'))?.status==='connected')await enqueue('piazza',{owner},`piazza:${Math.floor(now/1800000)}`);
 const night=nightKey();if(night)await enqueue('night',{owner},`night:${night}`);
 }
 const job=await claimJob();if(!job)return;const renew=setInterval(()=>{void db.batch([db.prepare('UPDATE background_jobs SET lease_until=? WHERE id=? AND lease_token=?').bind(Date.now()+180000,job.id,job.lease_token),db.prepare("UPDATE worker_state SET heartbeat=? WHERE id='primary'").bind(Date.now())]);},30000);
 try{const p=JSON.parse(job.payload);switch(job.kind){case 'memory-index':await indexMemories(p.owner);break;case 'index':await indexDocument(p.owner,p.id);await embedMissing(p.owner);break;case 'embed':await embedMissing(p.owner);break;case 'canvas':await archiveCanvas(p.owner);break;case 'canvas-course':await archiveCanvasCourse(p.owner,p.course);break;case 'gmail':{const r=await syncGmail();if(r.more||r.rescan)await enqueue('gmail',p);break;}case 'piazza':await syncPiazza();{const posts=(await db.prepare('SELECT * FROM piazza_posts WHERE is_active=1').all<any>()).results;for(const post of posts){const id=await saveDocument(p.owner,post.course_id,'piazza',post.id,post.title+'.txt','text/plain',Buffer.from(post.body));await enqueue('index',{owner:p.owner,id},`index:${id}`);}}break;case 'night':{await enqueue('memory-index',{owner:p.owner});await collectUnusedBlobs();const docs=(await db.prepare("SELECT id,owner_id FROM library_documents WHERE deleted=0 AND status!='ready' LIMIT 100").all<any>()).results;for(const d of docs)await enqueue('index',{owner:d.owner_id,id:d.id});for(let i=0;i<20&&!stopping;i++){if(!(await embedMissing(p.owner)))break;}break;}default:throw new Error('未知任务');}await finishJob(job.id,job.lease_token);}
 catch(e){const message=e instanceof Error&&/^[\u3400-\u9fff]/.test(e.message)?e.message.slice(0,200):'后台任务失败，请检查授权或稍后重试';if(job.attempts<3)await db.prepare("UPDATE background_jobs SET status='queued',error=?,available_at=?,lease_until=NULL WHERE id=? AND lease_token=?").bind(message,Date.now()+60000*2**job.attempts,job.id,job.lease_token).run();else await finishJob(job.id,job.lease_token,message);}
 finally{clearInterval(renew);}}
// A shared database permits only one executor, including during rolling restarts.
const primaryRenew=setInterval(()=>{void acquireLease('worker-primary',primaryToken).then(ok=>{if(!ok)stopping=true;}).catch(()=>{stopping=true;});},30000);
try{while(!stopping){try{if(await acquireLease('worker-primary',primaryToken))await tick();}catch{console.warn('[worker] tick failed; retrying without exposing provider data');}await new Promise(r=>setTimeout(r,2000));}}
finally{clearInterval(primaryRenew);await releaseLease('worker-primary',primaryToken);}
