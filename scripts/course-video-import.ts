import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute} from 'node:path';
import {kernel} from '../lib/kernel/service.ts';
import {recordingCaptionInput,type CaptionFile} from '../lib/kernel/recording-caption-import.ts';
import {kernelPool} from '../lib/kernel/db.ts';

const args=process.argv.slice(2);
const option=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const rootOption=option('--archive'),owner=option('--owner');
if(!rootOption||!owner)throw new Error('Usage: course-video-import.ts --archive PATH --owner OWNER [--course-map JSON_FILE]');
const root=realpathSync(resolve(rootOption));
const courseMap:Record<string,string>=option('--course-map')?JSON.parse(readFileSync(option('--course-map')!,'utf8')):{};
const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8'));
let imported=0;
const safeFile=(name:string)=>{
  const path=realpathSync(resolve(root,name)),rel=relative(root,path);
  if(rel==='..'||rel.startsWith('..\\')||rel.startsWith('../')||isAbsolute(rel))throw new Error('Archive path escapes its root');
  return path;
};
try{
  for(const record of Object.values(manifest.entries) as Array<Record<string,unknown>>){
    for(const file of (record.files||[]) as CaptionFile[]){
      if(file.kind!=='caption')continue;
      const path=safeFile(file.path);
      const bytes=readFileSync(path);
      const provenancePath=file.provenancePath||file.path+'.provenance.json';
      if(file.provenancePath&&!existsSync(resolve(root,provenancePath)))throw new Error('Missing caption provenance file');
      const provenance=existsSync(resolve(root,provenancePath))?JSON.parse(readFileSync(safeFile(provenancePath),'utf8')):undefined;
      const courseId=courseMap[String(record.courseId)];
      // No adapter invents or rewrites a canonical course; unmapped captions are
      // unscoped and carry their original Canvas course ID in source metadata.
      await kernel.ingestRecordingTranscript(recordingCaptionInput(record,file,bytes,owner,courseId,provenance));
      imported++;
    }
  }
  console.log(JSON.stringify({importedCaptionTracks:imported}));
}finally{await kernelPool().end();}
