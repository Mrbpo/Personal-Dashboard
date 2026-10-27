import { database as db } from './database.ts';
import {listIngestionJobs,listOutboxJobs,queueIngestionJob} from './kernel/jobs.ts';
export async function acquireLease(id:string,token:string,now=Date.now(),ttl=180000) {
 return Boolean(await db.prepare(`INSERT INTO service_leases VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires_at=excluded.expires_at WHERE service_leases.expires_at<? OR service_leases.token=? RETURNING id`).bind(id,token,now+ttl,now,token).first());
}
export async function releaseLease(id:string,token:string){await db.prepare('DELETE FROM service_leases WHERE id=? AND token=?').bind(id,token).run();}
export async function enqueue(kind:string,payload:Record<string,unknown>={},id:string=crypto.randomUUID(),reviveTerminal=false) {
 if(['canvas','canvas-course','gmail','piazza'].includes(kind)){
  const source=kind==='canvas-course'?'canvas':kind;
  const scope=kind==='canvas-course'?String(payload.course||''):String(payload.owner||'local-owner');
  return queueIngestionJob(kind,source,scope,payload,id,reviveTerminal);
 }
 const now=Date.now(),json=JSON.stringify(payload);
 if(reviveTerminal)await db.prepare(`INSERT INTO background_jobs (id,kind,payload,available_at,updated_at) VALUES (?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,payload=excluded.payload,status='queued',attempts=0,available_at=excluded.available_at,lease_until=NULL,lease_token=NULL,error=NULL,updated_at=excluded.updated_at
   WHERE background_jobs.status IN ('complete','failed')`).bind(id,kind,json,now,now).run();
 else await db.prepare('INSERT OR IGNORE INTO background_jobs (id,kind,payload,available_at,updated_at) VALUES (?,?,?,?,?)').bind(id,kind,json,now,now).run();
 return id;
}
export async function claimJob(now=Date.now()) {
  const token=crypto.randomUUID();
  return db.prepare(`UPDATE background_jobs SET status='running',lease_until=?,lease_token=?,attempts=attempts+1,updated_at=? WHERE id=(SELECT id FROM background_jobs WHERE (status='queued' AND available_at<=?) OR (status='running' AND lease_until<?) ORDER BY CASE kind WHEN 'canvas' THEN 0 WHEN 'canvas-course' THEN 1 WHEN 'gmail' THEN 1 WHEN 'piazza' THEN 1 ELSE 2 END,available_at LIMIT 1) RETURNING *`).bind(now+180000,token,now,now,now).first<{id:string;kind:string;payload:string;attempts:number;lease_token:string}>();
}
export async function finishJob(id:string,token:string,error?:string) {await db.prepare(`UPDATE background_jobs SET status=?,error=?,available_at=?,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?`).bind(error?'failed':'complete',error||null,Date.now(),Date.now(),id,token).run();}
export async function listJobs(){
 const legacy=(await db.prepare('SELECT id,kind,status,attempts,error,updated_at FROM background_jobs ORDER BY updated_at DESC LIMIT 60').all()).results;
 const [kernel,outbox]=await Promise.all([listIngestionJobs(),listOutboxJobs()]);
 return [...legacy,...kernel,...outbox].sort((a,b)=>Number(b.updated_at)-Number(a.updated_at)).slice(0,60);
}
export function nightKey(now=new Date()){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Toronto',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(now);const val=(t:string)=>parts.find(p=>p.type===t)?.value;return Number(val('hour'))>=3?`${val('year')}-${val('month')}-${val('day')}`:null;}
