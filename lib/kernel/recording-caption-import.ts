import {createHash} from 'node:crypto';
import {parseSubtitles,validateCues,type RecordingTranscript} from './recording-transcript.ts';
import {validateASRProvenance,validateASRAbsoluteCues,type ASRProvenance} from './recording-asr-provenance.ts';
export type {ASRProvenance} from './recording-asr-provenance.ts';
export type CaptionFile={kind:string;path:string;sha256:string;captionId:string;language:string;format:'srt'|'vtt'|'ttml';
  method?:'platform-caption'|'local-asr';provenancePath?:string};

/** Normalize adapter output before KernelService; never silently relabel ASR. */
export function recordingCaptionInput(record:Record<string,unknown>,file:CaptionFile,bytes:Buffer,ownerId:string,
  courseId?:string,provenance?:unknown):RecordingTranscript {
  if(createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new Error('Caption checksum mismatch');
  if(file.method!==undefined&&!['platform-caption','local-asr'].includes(file.method))throw new Error('Invalid caption method');
  const method=file.method||'platform-caption';
  let cues=parseSubtitles(bytes.toString('utf8'),file.format),asr:ASRProvenance|undefined;
  if(provenance!==undefined&&method!=='local-asr')throw new Error('ASR provenance requires explicit local-asr method');
  if(method==='local-asr'){
    const data=validateASRProvenance(provenance,{language:file.language,subtitleHash:file.sha256});
    const videos=(record.files||[]) as Array<{kind:string;sha256:string}>;
    if(!videos.some(video=>video.kind==='video'&&video.sha256===data.sourceVideoSha256))throw new Error('ASR original video identity mismatch');
    if(!Number.isFinite(Number(record.durationSeconds))||data.clipEndMs>Number(record.durationSeconds)*1000)
      throw new Error('ASR clip exceeds original video');
    for(const cue of cues){
      if(data.timestampBasis==='clip-relative'&&cue.endMs>data.clipEndMs-data.clipStartMs||
        data.timestampBasis==='source-absolute'&&(cue.startMs<data.clipStartMs||cue.endMs>data.clipEndMs))
        throw new Error('ASR cue is outside declared source window');
    }
    if(data.timestampBasis==='clip-relative')cues=validateCues(cues.map(cue=>({...cue,
      startMs:cue.startMs+data.clipStartMs,endMs:cue.endMs+data.clipStartMs})));
    validateASRAbsoluteCues(data,cues);
    asr=data;
  }
  const acquiredAt=Number(record.archivedAt||record.seenAt);
  if(!Number.isFinite(acquiredAt)||acquiredAt<=0)throw new Error('Invalid caption acquisition time');
  return {ownerId,courseId,canvasCourseId:String(record.courseId),partnerId:String(record.partnerId),
    entryId:String(record.entryId),captionId:file.captionId,language:file.language,title:String(record.title),
    sourceUrl:String(record.sourceUrl),subtitleHash:file.sha256,acquiredAt:new Date(acquiredAt*1000).toISOString(),
    publishedAt:record.publishedAt?new Date(Number(record.publishedAt)*1000).toISOString():undefined,
    method,...(asr?{model:asr.model,asr}:{}),cues};
}
