import {readFile,open,link,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
const statusSchema=z.object({state:z.enum(['idle','running','needs_auth','failed','completed']),
 reasonCode:z.string().regex(/^[A-Z_]{0,80}$/).nullish(),updatedAt:z.string().datetime({offset:true}).nullish(),lastSuccessAt:z.string().datetime({offset:true}).nullish(),
 authorizationActive:z.boolean().optional(),requestId:z.string().uuid().optional(),counts:z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/),z.number().int().nonnegative().max(1e9)).optional()});
export const recordingControlAction=z.enum(['sync','reauthorize']);
const idle={state:'idle' as const,reasonCode:null,updatedAt:null,lastSuccessAt:null,authorizationActive:false};
export async function recordingControlStatus(){
 const directory=process.env.COURSE_VIDEO_CONTROL_DIR;
 if(!directory)return {configured:false,...idle,pending:false};
 let status:z.infer<typeof statusSchema>=idle,pending=false;
 try{status=statusSchema.parse(JSON.parse(await readFile(join(directory,'status.json'),'utf8')));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('录像后台状态暂时无法读取');}
 try{await readFile(join(directory,'requests','request.json'),'utf8');pending=true;}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('录像后台请求状态暂时无法读取');}
 return {configured:true,...idle,...status,pending};
}
export async function requestRecordingControl(action:unknown){
 const parsed=recordingControlAction.parse(action),directory=process.env.COURSE_VIDEO_CONTROL_DIR;
 if(!directory)throw new Error('录像后台同步尚未启用');
 const status=await recordingControlStatus();
 if(status.pending||status.state==='running')return null;
 const requestId=randomUUID(),request={id:requestId,action:parsed,requestedAt:new Date().toISOString()};
 const temporary=join(directory,'requests',`.${requestId}.tmp`),destination=join(directory,'requests','request.json');
 // Publish a complete, exclusive request. Host path units must never see a half-written JSON.
 const handle=await open(temporary,'wx',0o600);
 try{
  await handle.writeFile(JSON.stringify(request));await handle.sync();await handle.close();
  try{await link(temporary,destination);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return null;throw error;}
 }finally{await handle.close().catch(()=>undefined);await unlink(temporary).catch(()=>undefined);}
 return {requestId,pending:true};
}
