import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {kernel} from '../lib/kernel/service.ts';
import {parseSubtitles} from '../lib/kernel/recording-transcript.ts';
import {kernelPool} from '../lib/kernel/db.ts';

const args=process.argv.slice(2);
const option=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const rootOption=option('--archive'),owner=option('--owner');
if(!rootOption||!owner)throw new Error('Usage: course-video-import.ts --archive PATH --owner OWNER [--course-map JSON_FILE]');
const root=realpathSync(resolve(rootOption));
const courseMap:Record<string,string>=option('--course-map')?JSON.parse(readFileSync(option('--course-map')!,'utf8')):{};
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
let imported=0;
try{
  for(const record of Object.values(manifest.entries) as Array<Record<string,unknown>>){
    for(const file of (record.files||[]) as Array<{kind:string;path:string;sha256:string;captionId:string;language:string;format:'srt'|'vtt'|'ttml'}>){
      if(file.kind!=='caption')continue;
      const path=realpathSync(resolve(root,file.path)),rel=relative(root,path);
      if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new Error('Archive path escapes its root');
      const bytes=readFileSync(path);
      if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Caption checksum mismatch');
      const courseId=courseMap[String(record.courseId)];
      // No adapter invents or rewrites a canonical course; unmapped captions are
      // unscoped and carry their original Canvas course ID in source metadata.
      await kernel.ingestRecordingTranscript({ownerId:owner,courseId,canvasCourseId:String(record.courseId),partnerId:String(record.partnerId),
        entryId:String(record.entryId),captionId:file.captionId,language:file.language,title:String(record.title),
        sourceUrl:String(record.sourceUrl),subtitleHash:file.sha256,
        acquiredAt:new Date(Number(record.archivedAt||record.seenAt)*1000).toISOString(),
        publishedAt:record.publishedAt?new Date(Number(record.publishedAt)*1000).toISOString():undefined,
        method:'platform-caption',cues:parseSubtitles(bytes.toString('utf8'),file.format)});
      imported++;
    }
  }
  console.log(JSON.stringify({importedCaptionTracks:imported}));
}finally{await kernelPool().end();}
