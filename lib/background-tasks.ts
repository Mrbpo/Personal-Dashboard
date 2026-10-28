import {readFile,open,link,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {database as db} from './database.ts';
import {acquireLease,releaseLease,enqueue} from './jobs.ts';
import {kernelPool} from './kernel/db.ts';
import {queueIngestionJob} from './kernel/jobs.ts';
import {serviceValue} from './service-vault.ts';
import {getIntegrationConnection} from './repository.ts';
import {recordingControlStatus,requestRecordingControl} from './recording-control.ts';
import {readRecordingManifest,buildRecordingCatalog} from './recording-catalog.ts';
import {recordingTargetConfig} from './recording-storage.ts';
import {budgetStatus} from './ai-budget.ts';
import {SUBTITLE_TRANSLATION_DAILY_LIMIT} from './recording-subtitles.ts';

export const backgroundTaskId=z.enum(['canvas','gmail','piazza','night','fact_validity_hourly','fact_validity_daily','recordings','subtitles','credentials','backup','status']);
type TaskId=z.infer<typeof backgroundTaskId>;
const appKinds=['canvas','gmail','piazza','night','fact_validity_hourly','fact_validity_daily'];
const belongsTo=(row:JobRow,id:string)=>row.kind===id||id==='canvas'&&row.kind==='canvas-course';
const labels:Record<TaskId,[string,string]>={canvas:['Canvas 全量同步','每 15 分钟'],gmail:['邮件增量同步','每 15 分钟'],piazza:['Piazza 同步','每 30 分钟'],night:['夜间整理调度','每天 03:00（多伦多）'],
 fact_validity_hourly:['课程事实时效更新','每小时'],fact_validity_daily:['学期与来源状态检查','每天（UTC）'],recordings:['课程录像检查与归档','每天 04:00（多伦多）'],subtitles:['全部待办字幕','有待办时连续处理'],credentials:['录像播放凭据刷新','每小时'],backup:['完整异地备份','每天 04:00 UTC'],status:['后台进度刷新','每分钟']};
const date=z.string().datetime({offset:true}).nullable().optional();
const count=z.number().int().min(0).max(1e9);
const hostTaskSchema=z.object({configured:z.boolean(),running:z.boolean(),result:z.string().nullable().optional(),enabled:z.boolean(),startedAt:date,finishedAt:date,nextRunAt:date,lastRunAt:date});
const subtitleRowSchema=z.object({videoSha256:z.string().regex(/^[a-f0-9]{64}$/),courseId:z.string(),state:z.string().max(40),reasonCode:z.string().regex(/^[A-Z_]{1,80}$/).nullable().optional(),
 startedAt:date,updatedAt:date,retryAt:date,stage:z.string().max(40).nullable().optional(),durationMs:count,englishCoveredMs:count,completedChunks:count,totalChunks:count,translatedCues:count,totalCues:count,published:z.boolean(),partial:z.boolean(),complete:z.boolean(),resumable:z.boolean()});
const snapshotSchema=z.object({schemaVersion:z.literal(1),updatedAt:z.string().datetime({offset:true}),services:z.record(z.string(),hostTaskSchema),
 parallel:z.object({configured:z.number().int().min(1).max(2),admitted:z.number().int().min(1).max(2).nullable(),active:count}),
 subtitles:z.object({items:z.array(subtitleRowSchema).max(10000),total:count,unreadable:count,states:z.record(z.string(),count),complete:count,englishComplete:count,published:count,resumable:count})});
export type HostSnapshot=z.infer<typeof snapshotSchema>;
export type TaskSummary={id:TaskId;label:string;schedule:string;configured:boolean;automatic:boolean;state:string;queued:number;running:number;failed:number;lastSuccessAt:string|null;updatedAt:string|null;nextRunAt:string|null;reason:string|null;canRun:boolean};
type JobRow={id:string;kind:string;status:string;updated_at:number;error:string|null;available_at?:number;failed_total?:number};

export function taskReason(code:string|null|undefined):string|null{
 if(!code)return null;
 if(['SUBTITLES_COMPLETED','SYNC_COMPLETED','SYNC_RUNNING','REAUTHORIZING'].includes(code))return null;
 if(code==='SUBTITLE_INPUT_RECOVERED')return '已确认未发起翻译请求，将复用英文转写续跑';
 const reasons:Record<string,string>={SUBTITLE_INPUT_UNREADABLE:'英文文件无法读取，尚未进入翻译',TRANSLATION_STOPPED_REVIEW_LEDGER:'字幕发布或翻译停止，需检查已保存进度与账本',NO_SPEECH_DETECTED:'未检测到可转写语音',AUDIO_DURATION_MISMATCH:'音频时长与原片不符',SUBTITLE_RESOURCE_RESERVE:'等待内存或磁盘空间',SUBTITLE_RESOURCE_BOUND:'本次运行到时，进度已保存',SUBTITLE_BUDGET_DEFERRED:'等待运行额度恢复',SUBTITLE_JOB_FAILED:'字幕处理失败',SYNC_FAILED:'录像同步失败',AUTHORIZATION_REQUIRED:'需要重新授权',CANVAS_ACCESS_REQUIRED:'需要恢复 Canvas 授权',SUBTITLE_SOURCE_UNAVAILABLE:'原片当前不可用'};
 return reasons[code]??(code.startsWith('AI_BUDGET_DEFERRED')?'等待 AI 额度恢复':'执行失败，请检查连接与任务记录');
}

export async function readBackgroundSnapshot(directory=process.env.COURSE_VIDEO_CONTROL_DIR):Promise<HostSnapshot|null>{
 if(!directory)return null;
 try{return snapshotSchema.parse(JSON.parse(await readFile(join(directory,'background-status.json'),'utf8')));}
 catch{return null;}
}

async function appJobs(owner:string):Promise<JobRow[]>{
 const legacy=(await db.prepare("WITH history AS (SELECT id,kind,status,updated_at,error,available_at,ROW_NUMBER() OVER (ORDER BY updated_at DESC) rn,SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) OVER () failed_total FROM background_jobs WHERE kind='night') SELECT * FROM history WHERE rn=1 OR status IN ('queued','running') ORDER BY updated_at DESC").all<JobRow>()).results;
 if(!process.env.KERNEL_DATABASE_URL)return legacy;
 const rows=(await kernelPool().query(`WITH history AS (SELECT id,kind,state status,last_error error,
  floor(extract(epoch from updated_at)*1000)::float8 updated_at,
  floor(extract(epoch from available_at)*1000)::float8 available_at,
  row_number() OVER (PARTITION BY kind ORDER BY updated_at DESC) rn,
  count(*) FILTER (WHERE state='failed') OVER (PARTITION BY kind)::int failed_total
  FROM ingestion_jobs WHERE kind=ANY($1::text[]) AND (scope=$2 OR payload->>'owner'=$2 OR (source='course-facts' AND scope='all')))
  SELECT * FROM history WHERE rn=1 OR status IN ('queued','running') ORDER BY updated_at DESC`,[appKinds.filter(k=>k!=='night').concat('canvas-course'),owner])).rows;
 return [...legacy,...rows];
}

export async function backgroundStatus(owner:string){
 const dayStart=Math.floor(Date.now()/86400000)*86400000;
 const [snapshot,jobsResult,connections,worker,recordings]=await Promise.all([readBackgroundSnapshot(),appJobs(owner).then(rows=>({rows,error:false})).catch(()=>({rows:[] as JobRow[],error:true})),
  Promise.all(['gmail','piazza'].map(source=>getIntegrationConnection(source).catch(()=>null))),
  db.prepare("SELECT heartbeat,paused FROM worker_state WHERE id='primary'").first<{heartbeat:number;paused:number}>(),recordingControlStatus().catch(()=>null)]);
 let successes:Record<string,string>={};
 if(process.env.KERNEL_DATABASE_URL)try{
  const result=await kernelPool().query('SELECT source,max(last_completed_at) at FROM source_status WHERE scope=$1 GROUP BY source',[owner]);
  successes=Object.fromEntries(result.rows.filter(r=>r.at).map(r=>[r.source,new Date(r.at).toISOString()]));
 }catch{/* The affected rows below remain unavailable; never present missing data as success. */}
 const configured:Record<string,boolean>={canvas:!!serviceValue('CANVAS_TOKEN'),gmail:connections[0]?.status==='connected',piazza:!!connections[1],night:true,
  fact_validity_hourly:process.env.STUDY_ANSWER_BACKEND==='kernel'&&process.env.KERNEL_COURSE_FACTS_ENABLED==='true',fact_validity_daily:process.env.STUDY_ANSWER_BACKEND==='kernel'&&process.env.KERNEL_COURSE_FACTS_ENABLED==='true'};
 const tasks:TaskSummary[]=appKinds.map(value=>{
  const id=value as TaskId,rows=jobsResult.rows.filter(r=>belongsTo(r,id)),latest=rows[0],running=rows.filter(r=>r.status==='running').length,queued=rows.filter(r=>r.status==='queued').length;
  const deferred=rows.find(r=>r.status==='queued'&&Number(r.available_at)>Date.now());
  return {id,label:labels[id][0],schedule:labels[id][1],configured:configured[id],automatic:configured[id]&&!worker?.paused&&(id.startsWith('fact_validity_')||process.env.SYNC_PRIMARY==='true'),state:jobsResult.error?'unavailable':running?'running':queued?(deferred?'deferred':'queued'):latest?.status??'idle',
   running,queued,failed:[...new Map(rows.map(r=>[r.kind,r.failed_total??0])).values()].reduce((a,b)=>a+b,0),lastSuccessAt:successes[id]??null,updatedAt:latest?new Date(Number(latest.updated_at)).toISOString():null,nextRunAt:null,
   reason:jobsResult.error?'内核任务状态暂时无法读取':worker?.paused?'网站后台已暂停':!configured[id]?'尚未连接或启用':taskReason(latest?.error),canRun:configured[id]&&!jobsResult.error&&!worker?.paused};
 });
 for(const id of ['recordings','subtitles','credentials','backup','status'] as const){
  const host=snapshot?.services[id],busy=!!host?.running||(id==='recordings'&&(recordings?.state==='running'||!!recordings?.pending));
  const lastRequest=!!host?.result&&host.result!=='success';
  tasks.push({id,label:labels[id][0],schedule:labels[id][1],configured:!!host?.configured,automatic:!!host?.enabled,
   state:!host?'unavailable':busy?'running':lastRequest?'failed':id==='recordings'?recordings?.state??'idle':host.finishedAt?'complete':'idle',
   queued:id==='subtitles'?(snapshot?.subtitles.states.pending??0):0,running:busy?1:0,failed:id==='subtitles'?(snapshot?.subtitles.states.failed??0):lastRequest?1:0,
   lastSuccessAt:host?.result==='success'?host.finishedAt??null:null,updatedAt:host?.finishedAt??host?.startedAt??null,nextRunAt:host?.nextRunAt??null,
   reason:!host?'宿主任务进度尚未就绪':id==='recordings'?taskReason(recordings?.reasonCode):id==='subtitles'&&snapshot?.subtitles.resumable?`${snapshot.subtitles.resumable} 路可复用转写安全续跑；有收费账本的失败项仍保留待核查`:lastRequest?'上次执行失败':null,canRun:!!host?.configured&&(id==='status'||id==='subtitles'||!busy)});
 }
 let subtitles=null;
 if(snapshot){
  const names=new Map<string,{id:string;title:string}>();
  try{
   const {objects,catalog}=buildRecordingCatalog(await readRecordingManifest(),recordingTargetConfig());
   for(const recording of catalog.recordings)for(const view of recording.views){
    const object=objects.get(view.id);if(object)names.set(object.sha256,{id:view.id,title:`${recording.title} · ${view.label}`});
   }
  }catch{/* Preserve saved progress when the current catalog is temporarily unavailable. */}
  subtitles={...snapshot.subtitles,items:snapshot.subtitles.items.map(({videoSha256,...row})=>{
   const object=names.get(videoSha256);return {...row,id:object?.id??null,title:object?.title??'未匹配到当前录像',reason:taskReason(row.reasonCode)};
  })};
 }
 const [budget,calls]=await Promise.all([budgetStatus(),db.prepare("SELECT count(*) n FROM ai_ledger WHERE kind='recording-subtitle-translation' AND created_at>=? AND created_at<?").bind(dayStart,dayStart+86400000).first<{n:number}>()]);
 return {tasks,subtitles,budget:{...budget,subtitleCalls:Number(calls?.n??0),subtitleDailyLimit:SUBTITLE_TRANSLATION_DAILY_LIMIT},parallel:snapshot?.parallel??null,hostUpdatedAt:snapshot?.updatedAt??null,hostStale:!snapshot||Date.now()-Date.parse(snapshot.updatedAt)>180000,
  worker:{heartbeat:worker?.heartbeat??null,paused:!!worker?.paused,online:!!worker&&Date.now()-worker.heartbeat<90000},automaticSync:process.env.SYNC_PRIMARY==='true'};
}

async function hostRequest(task:string){
 const directory=process.env.COURSE_VIDEO_CONTROL_DIR;if(!directory)throw new Error('宿主任务尚未安装');
 const request={id:randomUUID(),task,requestedAt:new Date().toISOString()};
 const temporary=join(directory,'requests',`.maintenance-${request.id}.tmp`),destination=join(directory,'requests','maintenance-request.json');
 const handle=await open(temporary,'wx',0o600);
 try{await handle.writeFile(JSON.stringify(request));await handle.sync();await handle.close();try{await link(temporary,destination);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return {accepted:false,existing:true};throw error;}}
 finally{await handle.close().catch(()=>undefined);await unlink(temporary).catch(()=>undefined);}
 return {accepted:true,existing:false};
}

export async function triggerBackgroundTask(owner:string,input:unknown){
 const id=backgroundTaskId.parse(input),status=await backgroundStatus(owner),task=status.tasks.find(row=>row.id===id)!;
 if(!task.configured)throw new Error('该任务尚未连接或安装');
 if(task.running&&id!=='subtitles'||task.queued&&appKinds.includes(id))return {accepted:true,existing:true};
 if(!task.canRun)throw new Error(task.reason??'任务当前无法启动');
 if(id==='recordings')return {accepted:!!await requestRecordingControl('sync'),existing:false};
 if(!appKinds.includes(id))return hostRequest(id);
 const token=randomUUID();
 if(!await acquireLease('settings-manual:'+id,token,Date.now(),10000))return {accepted:false,existing:true};
 try{
  // Check again under the existing durable request lease; repeated clicks do not add jobs.
  const active=(await appJobs(owner)).find(row=>belongsTo(row,id)&&['queued','running'].includes(row.status));
  if(active)return {accepted:true,existing:true};
  const key='manual:'+id+':'+randomUUID();
  if(id.startsWith('fact_validity_'))await queueIngestionJob(id,'course-facts','all',{kind:id.endsWith('hourly')?'hourly':'daily'},key);
  else await enqueue(id,{owner},key);
  return {accepted:true,existing:false};
 }finally{await releaseLease('settings-manual:'+id,token);}
}
