import {readFile,realpath} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {z} from 'zod';
export const SUBTITLE_TRANSLATION_DAILY_LIMIT=40;
import type {RecordingObject} from './recording-catalog.ts';
import {validateASRProvenance,validateASRAbsoluteCues} from './kernel/recording-asr-provenance.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/);
const cueSchema=z.object({startMs:z.number().int().nonnegative(),endMs:z.number().int().positive(),
 en:z.string().min(1).max(10000),zh:z.string().min(1).max(10000).nullable()});
export const subtitleBundleSchema=z.object({schemaVersion:z.literal(1),videoSha256:hash,
 source:z.object({subtitleSha256:hash,method:z.enum(['local-asr','platform-caption']),model:z.string().nullable(),
  clipStartMs:z.number().int().nonnegative(),clipEndMs:z.number().int().positive(),timestampBasis:z.literal('source-absolute'),asr:z.unknown().optional()}),
 translation:z.object({model:z.string(),promptVersion:z.literal('subtitle-zh-v1')}).nullable(),
 cues:z.array(cueSchema).min(1).max(100000)});
export type SubtitleBundle=z.infer<typeof subtitleBundleSchema>;
export type SubtitleMode='en'|'zh'|'bilingual';

export function validateSubtitleBundle(value:unknown,videoSha256:string,durationSeconds:number|null){
 const bundle=subtitleBundleSchema.parse(value);
 if(bundle.videoSha256!==videoSha256||bundle.source.clipEndMs<=bundle.source.clipStartMs||
  (durationSeconds!==null&&bundle.source.clipEndMs>Math.ceil(durationSeconds*1000)+1000))throw new Error('字幕与当前原片不匹配');
 let previous=-1;
 for(const cue of bundle.cues){
  if(cue.startMs<previous||cue.endMs<=cue.startMs||cue.startMs<bundle.source.clipStartMs||cue.endMs>bundle.source.clipEndMs||
   !cue.en.trim()||(cue.zh!==null&&!cue.zh.trim()))throw new Error('字幕时间轴无效');
  previous=cue.startMs;
 }
 if(bundle.cues.some(c=>c.zh!==null)&&!bundle.translation)throw new Error('中文字幕缺少翻译来源');
 if(bundle.source.method==='local-asr'){
  const asr=validateASRProvenance(bundle.source.asr,{language:'en',subtitleHash:bundle.source.subtitleSha256,model:bundle.source.model??undefined});
  if(asr.sourceVideoSha256!==videoSha256||asr.clipStartMs!==bundle.source.clipStartMs||asr.clipEndMs!==bundle.source.clipEndMs)throw new Error('字幕ASR来源不匹配');
  validateASRAbsoluteCues(asr,bundle.cues);
 }
 return bundle;
}

export function subtitleMetadata(bundle:SubtitleBundle|null,durationSeconds:number|null){
 if(!bundle)return {available:false,modes:[],partial:false,clipStartMs:null,clipEndMs:null,sourceMethod:null,translated:false};
 const translated=bundle.cues.every(c=>c.zh!==null);
 return {available:true,modes:translated?['en','zh','bilingual']:['en'],
  partial:bundle.source.clipStartMs>0||durationSeconds===null||bundle.source.clipEndMs<durationSeconds*1000-1000,
  clipStartMs:bundle.source.clipStartMs,clipEndMs:bundle.source.clipEndMs,sourceMethod:bundle.source.method,translated};
}

function timestamp(ms:number){return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;}
function escapeVtt(text:string){return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\r\n?/g,'\n').replace(/\n{2,}/g,'\n');}
export function renderSubtitleVtt(bundle:SubtitleBundle,mode:SubtitleMode){
 if(mode!=='en'&&bundle.cues.some(c=>!c.zh))throw new Error('中文字幕尚未完整生成');
 return 'WEBVTT\n\n'+bundle.cues.map((cue,index)=>`${index+1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n`+
  (mode==='en'?escapeVtt(cue.en):mode==='zh'?escapeVtt(cue.zh!):`${escapeVtt(cue.en)}\n${escapeVtt(cue.zh!)}`)).join('\n\n')+'\n';
}

export async function readRecordingSubtitles(object:RecordingObject){
 const directory=process.env.RECORDINGS_SUBTITLE_DIR;
 if(!directory)return null;
 if(!/^[a-f0-9]{64}$/.test(object.sha256))throw new Error('字幕原片标识无效');
 try{
  const root=await realpath(directory),path=await realpath(resolve(root,object.sha256+'.json')),rel=relative(root,path);
  if(rel==='..'||rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))||isAbsolute(rel))throw new Error('字幕路径无效');
  return validateSubtitleBundle(JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,'')),object.sha256,object.durationSeconds);
 }catch(error){
  if((error as NodeJS.ErrnoException).code==='ENOENT')return null;
  throw new Error('字幕文件核验失败，请重新生成');
 }
}
