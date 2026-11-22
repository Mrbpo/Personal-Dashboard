import {readFile, realpath, stat} from 'node:fs/promises';
import {resolve, relative, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {RecordingObject} from './recording-catalog.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const asset = z.object({sha256: hash, bytes: z.number().int().positive()}).strict();
const coverage = {
  videoSha256: hash, clipStartMs: z.number().int().nonnegative(), clipEndMs: z.number().int().positive(),
};
const reviewed = z.object({
  schemaVersion: z.literal(1), ...coverage, reviewed: z.literal(true),
  files: z.object({html: asset, pdf: asset, outlinePdf: asset, outlineText: asset}).strict(),
}).strict();
const automatic = z.object({
  schemaVersion: z.literal(2), ...coverage, courseId: z.string().regex(/^[1-9][0-9]*$/),
  courseName: z.string().trim().min(1).max(2000), title: z.string().min(1).max(2000),
  publishedAt: z.number().int().nonnegative().max(253402300799).nullable(), frameCount: z.number().int().positive(),
  totalCues: z.number().int().positive(), translatedCues: z.number().int().nonnegative(),
  files: z.object({html: asset, pdf: asset}).strict(),
}).strict().refine(m => m.translatedCues <= m.totalCues);
export type GuideManifest = z.infer<typeof reviewed> | (z.infer<typeof automatic> & {version:string});
export const guideFiles = {
  html:{name:'guide.html',mime:'text/html; charset=utf-8',limit:32*1024*1024},
  pdf:{name:'guide.pdf',mime:'application/pdf',limit:64*1024*1024},
  outlinePdf:{name:'outline.pdf',mime:'application/pdf',limit:10*1024*1024},
  outlineText:{name:'outline.txt',mime:'text/plain; charset=utf-8',limit:2*1024*1024},
} as const;
export type GuideFormat = keyof typeof guideFiles;

async function inside(root:string, ...parts:string[]) {
  const path = await realpath(resolve(root, ...parts));
  const rel = relative(root,path);
  if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel)) throw Error('讲义路径无效');
  return path;
}
async function readSmallJson(root:string, name:string, expectedHash?:string):Promise<unknown> {
  const path = await inside(root,name);
  const info = await stat(path);
  if(!info.isFile() || info.size > 16384) throw Error('讲义配置无效');
  const bytes = await readFile(path);
  if(bytes.length>16384 || expectedHash&&createHash('sha256').update(bytes).digest('hex')!==expectedHash)
    throw Error('讲义配置核验失败');
  return JSON.parse(bytes.toString('utf8'));
}
function missing(error:unknown) { return (error as NodeJS.ErrnoException)?.code==='ENOENT'; }

export async function readGuideManifest(object:RecordingObject, edition?:string):Promise<GuideManifest|null> {
  const directory = process.env.RECORDINGS_GUIDE_DIR;
  if(!directory) return null;
  if(!hash.safeParse(object.sha256).success || (edition && edition!=='reviewed' && !hash.safeParse(edition).success))
    throw Error('讲义标识无效');
  try {
    const root = await inside(await realpath(directory),object.sha256);
    let version = edition;
    if(!version) {
      try { version = z.object({version:hash}).strict().parse(await readSmallJson(root,'current.json')).version; }
      catch(error) { if(!missing(error)) throw error; }
    }
    let manifest:GuideManifest;
    if(version && version!=='reviewed') {
      try {
        const versionRoot = await inside(root,version);
        const data = automatic.parse(await readSmallJson(versionRoot,'manifest.json',version));
        if(!object.key.startsWith(`course-recordings/${data.courseId}/`)) throw Error('讲义课程不匹配');
        manifest = {...data,version};
      } catch(error) {
        if(edition && missing(error)) return null;
        throw Error('已发布讲义版本无效');
      }
    } else {
      manifest = reviewed.parse(await readSmallJson(root,'manifest.json'));
    }
    if(manifest.videoSha256!==object.sha256 || manifest.clipEndMs<=manifest.clipStartMs ||
       object.durationSeconds!==null && manifest.clipEndMs>Math.ceil(object.durationSeconds*1000)+1000)
      throw Error('讲义与当前原片不匹配');
    return manifest;
  } catch(error) { if(missing(error)) return null; throw Error('讲义来源核验失败'); }
}

export async function readGuideAsset(object:RecordingObject, manifest:GuideManifest, format:GuideFormat) {
  const config = guideFiles[format];
  if(!config || manifest.videoSha256!==object.sha256 || !hash.safeParse(object.sha256).success)
    throw Error('讲义与当前原片不匹配');
  const proof = (manifest.files as Partial<Record<GuideFormat,z.infer<typeof asset>>>)[format];
  if(!proof) throw Error('此版本未提供该格式');
  const directory = process.env.RECORDINGS_GUIDE_DIR;
  if(!directory) throw Error('讲义尚未配置');
  const sourceRoot = await inside(await realpath(directory),object.sha256);
  const root = manifest.schemaVersion===2 ? await inside(sourceRoot,hash.parse(manifest.version)) : sourceRoot;
  const path = await inside(root,config.name);
  const info = await stat(path);
  if(!info.isFile() || info.size!==proof.bytes || info.size>config.limit) throw Error('讲义文件大小核验失败');
  const bytes = await readFile(path);
  if(bytes.length!==proof.bytes || createHash('sha256').update(bytes).digest('hex')!==proof.sha256)
    throw Error('讲义文件核验失败');
  return bytes;
}
