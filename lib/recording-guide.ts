import {readFile,realpath,stat} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RecordingObject} from './recording-catalog.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const asset=z.object({sha256:hash,bytes:z.number().int().positive()}).strict();
const schema=z.object({schemaVersion:z.literal(1),videoSha256:hash,clipStartMs:z.number().int().nonnegative(),
 clipEndMs:z.number().int().positive(),reviewed:z.literal(true),
 files:z.object({html:asset,pdf:asset,outlinePdf:asset,outlineText:asset}).strict()}).strict();
export type GuideManifest=z.infer<typeof schema>;
export const guideFiles={html:{name:'guide.html',mime:'text/html; charset=utf-8',limit:10*1024*1024},
 pdf:{name:'guide.pdf',mime:'application/pdf',limit:30*1024*1024},
 outlinePdf:{name:'outline.pdf',mime:'application/pdf',limit:10*1024*1024},
 outlineText:{name:'outline.txt',mime:'text/plain; charset=utf-8',limit:2*1024*1024}} as const;
export type GuideFormat=keyof typeof guideFiles;
async function inside(root:string,...parts:string[]){
 const path=await realpath(resolve(root,...parts)),rel=relative(root,path);
 if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw Error('讲义路径无效');
 return path;
}
export async function readGuideManifest(object:RecordingObject):Promise<GuideManifest|null>{
 const directory=process.env.RECORDINGS_GUIDE_DIR;if(!directory)return null;
 if(!/^[a-f0-9]{64}$/.test(object.sha256))throw Error('讲义原片标识无效');
 try{
  const root=await realpath(directory),path=await inside(root,object.sha256,'manifest.json');
  if((await stat(path)).size>16384)throw Error('讲义配置过大');
  const manifest=schema.parse(JSON.parse(await readFile(path,'utf8')));
  if(manifest.videoSha256!==object.sha256||manifest.clipEndMs<=manifest.clipStartMs||
    object.durationSeconds!==null&&manifest.clipEndMs>Math.ceil(object.durationSeconds*1000)+1000)throw Error('讲义与当前原片不匹配');
  return manifest;
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('讲义来源核验失败');}
}
export async function readGuideAsset(object:RecordingObject,manifest:GuideManifest,format:GuideFormat){
 const config=guideFiles[format];
 if(!config||manifest.videoSha256!==object.sha256)throw Error('讲义与当前原片不匹配');
 const directory=process.env.RECORDINGS_GUIDE_DIR;if(!directory)throw Error('讲义尚未配置');
 const root=await realpath(directory),path=await inside(root,object.sha256,config.name),size=(await stat(path)).size;
 if(size!==manifest.files[format].bytes||size>config.limit)throw Error('讲义文件大小核验失败');
 const bytes=await readFile(path);
 if(bytes.length!==size||createHash('sha256').update(bytes).digest('hex')!==manifest.files[format].sha256)throw Error('讲义文件核验失败');
 return bytes;
}
