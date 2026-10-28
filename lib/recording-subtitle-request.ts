import {readFile,open,link,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

type JobState='idle'|'queued'|'running'|'deferred'|'failed'|'completed';
export type SubtitleGeneration={configured:boolean;state:JobState;requested:boolean;canRequest:boolean;retryAt:string|null;reasonCode:string|null};
const instant=(value:unknown)=>typeof value==='string'&&/(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const digest=(value:string)=>/^[a-f0-9]{64}$/.test(value);
async function json(path:string){
 try{return JSON.parse(await readFile(path,'utf8')) as unknown;}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw new Error('字幕后台状态暂时无法读取');}
}
function record(value:unknown):Record<string,unknown>{return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
export async function subtitleGenerationStatus(videoSha256:string,complete=false,now=Date.now()):Promise<SubtitleGeneration>{
 if(!digest(videoSha256))throw new Error('录像标识无效');
 const directory=process.env.COURSE_VIDEO_CONTROL_DIR;
 const base:SubtitleGeneration={configured:!!directory,state:complete?'completed':'idle',requested:false,canRequest:!!directory&&!complete,retryAt:null,reasonCode:null};
 if(!directory||complete)return base;
 const [queueValue,pendingValue,resultValue]=await Promise.all([json(join(directory,'subtitle-queue.json')),json(join(directory,'requests','subtitle-request.json')),
  json(join(directory,'subtitle-results',videoSha256+'.json'))]);
 const queue=record(queueValue),pending=record(pendingValue),result=record(resultValue);
 const jobs=Array.isArray(queue.jobs)?queue.jobs:[];
 const row=record(jobs.find(item=>record(item).videoSha256===videoSha256));
 const retryAt=instant(row.notBefore),lease=instant(row.leaseExpiresAt);
 const reasonCode=typeof row.reasonCode==='string'&&/^[A-Z_]{1,80}$/.test(row.reasonCode)?row.reasonCode:null;
 if(row.state==='failed')return {...base,state:'failed',canRequest:false,reasonCode};
 if(row.state==='running'&&lease&&Date.parse(lease)>now)return {...base,state:'running',canRequest:false,requested:!!instant(row.requestedAt)};
 if(retryAt&&Date.parse(retryAt)>now)return {...base,state:'deferred',canRequest:reasonCode==='SUBTITLE_RESOURCE_RESERVE',retryAt,reasonCode};
 // A root preflight source rejection never started ASR/AI. A later current catalog
 // may restore the original; allow an explicit request, which root revalidates.
 const sourceRejected=result.state==='failed'&&result.reasonCode==='SUBTITLE_SOURCE_UNAVAILABLE';
 const requested=pending.videoSha256===videoSha256||(row.state==='pending'&&!retryAt&&!!instant(row.requestedAt));
 return {...base,state:row.state||requested?'queued':'idle',requested,canRequest:!requested,reasonCode:reasonCode??(sourceRejected?'SUBTITLE_SOURCE_UNAVAILABLE':null)};
}

/** Web publishes only a complete, fixed request. The root bridge owns the queue and its lock. */
export async function requestSubtitleGeneration(videoSha256:string){
 if(!digest(videoSha256))throw new Error('录像标识无效');
 const directory=process.env.COURSE_VIDEO_CONTROL_DIR;
 if(!directory)throw new Error('字幕后台生成尚未启用');
 const request={id:randomUUID(),action:'subtitle',videoSha256,requestedAt:new Date().toISOString()};
 const destination=join(directory,'requests','subtitle-request.json');
 const temporary=join(directory,'requests',`.subtitle-${request.id}.tmp`);
 const handle=await open(temporary,'wx',0o600);
 try{
  await handle.writeFile(JSON.stringify(request));await handle.sync();await handle.close();
  try{await link(temporary,destination);}
  catch(error){
   if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
   const existing=record(await json(destination));
   return existing.videoSha256===videoSha256?{accepted:true,requestId:typeof existing.id==='string'?existing.id:null}:null;
  }
 }finally{await handle.close().catch(()=>undefined);await unlink(temporary).catch(()=>undefined);}
 return {accepted:true,requestId:request.id};
}
