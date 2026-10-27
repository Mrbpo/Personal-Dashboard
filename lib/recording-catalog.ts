import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';

const entryId=z.string().regex(/^[01]_[A-Za-z0-9]+$/);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const fileSchema=z.object({kind:z.literal('video'),path:z.string(),sha256:digest,bytes:z.number().int().positive(),
 remote:z.object({state:z.literal('verified'),method:z.literal('full_get_sha256'),bucket:z.string(),endpointHost:z.string(),
  key:z.string(),etag:z.string().min(1),sha256:digest,bytes:z.number().int().positive()})});
const entrySchema=z.object({courseId:z.string().regex(/^[1-9][0-9]*$/),entryId,parentEntryId:entryId.nullish(),
 title:z.string().max(2000),state:z.literal('archived'),track:z.string().nullish(),
 durationSeconds:z.number().nonnegative().nullish(),publishedAt:z.number().nonnegative().nullish(),files:z.array(z.unknown())});
const manifestSchema=z.object({entries:z.record(z.unknown())});
export type RecordingView={id:string;label:string;mime:string;bytes:number};
export type Recording={id:string;courseId:string;title:string;durationSeconds:number|null;publishedAt:number|null;views:RecordingView[]};
export type RecordingCatalog={courses:{id:string;name:string}[];recordings:Recording[];unavailableEntries:number};
export type RecordingObject={id:string;key:string;etag:string;bytes:number;mime:string;durationSeconds:number|null};
export type RecordingTarget={bucket:string;endpointHost:string};
const identity=(value:string)=>createHash('sha256').update(value).digest('hex');

/** An asset index over existing verified archive metadata; never a course truth store. */
export function buildRecordingCatalog(manifest:unknown,target:RecordingTarget,courseNames:Map<string,string>=new Map()){
 const entries=manifestSchema.parse(manifest).entries;
 const groups=new Map<string,{entry:z.infer<typeof entrySchema>;view:RecordingView;parent:boolean}[]>();
 const objects=new Map<string,RecordingObject>();let unavailableEntries=0;
 for(const raw of Object.values(entries)){
  const parsed=entrySchema.safeParse(raw);if(!parsed.success){unavailableEntries++;continue;}
  const entry=parsed.data;let found=false;
  for(const rawFile of entry.files){
   const parsedFile=fileSchema.safeParse(rawFile);if(!parsedFile.success)continue;
   const file=parsedFile.data,remote=file.remote;
   const path=file.path.match(new RegExp(`^${entry.courseId}/${entry.entryId}/(version-(?:[0-9]+|unknown))/original\\.(mp4|m4v|webm)$`));
   if(!path||remote.bucket!==target.bucket||remote.endpointHost!==target.endpointHost||remote.sha256!==file.sha256||remote.bytes!==file.bytes||
    remote.key!==`course-recordings/${entry.courseId}/${entry.entryId}/${path[1]}/${file.sha256}.${path[2]}`)continue;
   const id=identity(`${entry.courseId}:${entry.entryId}:${remote.key}`),mime=path[2]==='webm'?'video/webm':'video/mp4';
   const parent=!entry.parentEntryId||entry.parentEntryId===entry.entryId;
   const group=identity(`${entry.courseId}:${parent?entry.entryId:entry.parentEntryId}`);
   const list=groups.get(group)??[];
   // Only explicit track metadata names a screen/camera. Parent position is not visual evidence.
   const label=entry.track==='screen'?'屏幕':entry.track==='camera'?'摄像头':parent?'主视角':'其他视角';
   list.push({entry,parent,view:{id,label,mime,bytes:file.bytes}});groups.set(group,list);
   objects.set(id,{id,key:remote.key,etag:remote.etag,bytes:file.bytes,mime,durationSeconds:entry.durationSeconds??null});found=true;
   break;
  }
  if(!found)unavailableEntries++;
 }
 const recordings:Recording[]=[];
 for(const [id,list] of groups){
  list.sort((a,b)=>Number(b.parent)-Number(a.parent)||a.entry.entryId.localeCompare(b.entry.entryId));
  const entry=list[0].entry;
  recordings.push({id,courseId:entry.courseId,title:entry.title||entry.entryId,durationSeconds:entry.durationSeconds??null,
   publishedAt:entry.publishedAt??null,views:list.map((item,index)=>({...item.view,
    label:list.filter(other=>other.view.label===item.view.label).length>1?`${item.view.label} ${index+1}`:item.view.label}))});
 }
 recordings.sort((a,b)=>(b.publishedAt??0)-(a.publishedAt??0)||a.id.localeCompare(b.id));
 const courses=[...new Set(recordings.map(r=>r.courseId))].sort().map(id=>({id,name:courseNames.get(id)||`课程 ${id}`}));
 return {catalog:{courses,recordings,unavailableEntries} satisfies RecordingCatalog,objects};
}

export async function readRecordingManifest(){
 const path=process.env.RECORDINGS_MANIFEST_PATH;
 if(!path)throw new Error('录像播放器尚未配置归档目录');
 // The collector atomically replaces this file. Read afresh rather than pinning an old inode/version.
 try{return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')) as unknown;}
 catch{throw new Error('暂时无法读取录像归档清单');}
}

export function assertRecordingOwner(owner:string){
 if(owner!==(process.env.RECORDINGS_OWNER_ID||'local-owner'))throw new Error('FORBIDDEN');
}
