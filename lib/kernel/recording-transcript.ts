import {createHash} from 'node:crypto';
import type {ASRProvenance} from './recording-caption-import.ts';

export type TranscriptCue={startMs:number;endMs:number;text:string};
export type RecordingTranscript={ownerId:string;courseId?:string;partnerId:string;entryId:string;
  captionId:string;language:string;title:string;sourceUrl:string;subtitleHash:string;canvasCourseId?:string;
  acquiredAt:string;publishedAt?:string;method:'platform-caption'|'local-asr';
  model?:string;asr?:ASRProvenance;cues:TranscriptCue[]};

function timestamp(value:string):number {
  const match=/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if(!match||Number(match[2])>59||Number(match[3])>59)throw new Error('Invalid subtitle timestamp');
  return ((Number(match[1]||0)*60+Number(match[2]))*60+Number(match[3]))*1000+Number(match[4]);
}

function text(value:string):string {
  return value.replace(/<[^>]*>/gu,'').replace(/&amp;/gu,'&').replace(/&lt;/gu,'<')
    .replace(/&gt;/gu,'>').replace(/&nbsp;/gu,' ').replace(/&#(\d+);/gu,(_,code)=>String.fromCodePoint(Number(code))).trim();
}

export function validateCues(cues:TranscriptCue[]):TranscriptCue[] {
  if(!Array.isArray(cues)||!cues.length||cues.length>100000)throw new Error('Empty or excessive subtitle cues');
  let previous=-1;
  for(const cue of cues){
    if(!Number.isSafeInteger(cue.startMs)||!Number.isSafeInteger(cue.endMs)||cue.startMs<0||
      cue.endMs<=cue.startMs||cue.startMs<previous||typeof cue.text!=='string'||!cue.text.trim())
      throw new Error('Invalid or unordered subtitle cue');
    previous=cue.startMs;
  }
  return cues;
}

/** SRT/VTT timestamps are source offsets, not an invented PDF page number. */
export function parseSubtitles(raw:string,format:'srt'|'vtt'|'ttml'):TranscriptCue[] {
  const cues:TranscriptCue[]=[];
  if(format==='ttml'){
    if(!/<(?:\w+:)?tt\b/u.test(raw))throw new Error('Invalid TTML');
    const ttmlTime=(value:string)=>{
      if(/^\d+(?:\.\d+)?s$/u.test(value))return Math.round(Number(value.slice(0,-1))*1000);
      if(/^\d+(?:\.\d+)?ms$/u.test(value))return Math.round(Number(value.slice(0,-2)));
      return timestamp(value);
    };
    for(const match of raw.matchAll(/<(?:\w+:)?p\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?p>/gu)){
      const begin=/\bbegin=["']([^"']+)["']/u.exec(match[1])?.[1];
      const end=/\bend=["']([^"']+)["']/u.exec(match[1])?.[1];
      const duration=/\bdur=["']([^"']+)["']/u.exec(match[1])?.[1];
      if(!begin||(!end&&!duration))throw new Error('TTML requires explicit cue timing');
      const startMs=ttmlTime(begin),body=text(match[2].replace(/<(?:\w+:)?br\s*\/?>/gu,'\n'));
      if(body)cues.push({startMs,endMs:end?ttmlTime(end):startMs+ttmlTime(duration!),text:body});
    }
  }else{
    const normalized=raw.replace(/^\uFEFF/u,'').replace(/\r\n?/gu,'\n');
    if(format==='vtt'&&!/^WEBVTT(?:\s|$)/u.test(normalized))throw new Error('Invalid WebVTT header');
    for(const block of normalized.split(/\n{2,}/gu)){
      const lines=block.split('\n');
      if(/^(?:NOTE|STYLE|REGION)(?:\s|$)/u.test(lines[0]))continue;
      const index=lines.findIndex(line=>line.includes('-->'));
      if(index<0)continue;
      const timing=/^\s*(\S+)\s+-->\s+(\S+)(?:\s.*)?$/u.exec(lines[index]);
      if(!timing)throw new Error('Invalid subtitle timing');
      const body=text(lines.slice(index+1).join('\n'));
      if(body)cues.push({startMs:timestamp(timing[1]),endMs:timestamp(timing[2]),text:body});
    }
  }
  return validateCues(cues);
}

function displayTime(ms:number):string {
  const seconds=Math.floor(ms/1000),hours=Math.floor(seconds/3600);
  return `${String(hours).padStart(2,'0')}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;
}

export function prepareRecordingTranscript(input:RecordingTranscript){
  if(!input.ownerId?.trim()||!/^\d+$/u.test(input.partnerId)||!/^[01]_[A-Za-z0-9]+$/u.test(input.entryId)||
    !/^[A-Za-z0-9_-]+$/u.test(input.captionId)||!input.language?.trim()||!input.title?.trim()||
    !/^[a-f0-9]{64}$/u.test(input.subtitleHash)||!Number.isFinite(Date.parse(input.acquiredAt))||
    !['platform-caption','local-asr'].includes(input.method))throw new Error('Invalid recording identity');
  const url=new URL(input.sourceUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||/\/ks\//iu.test(url.pathname))
    throw new Error('Recording source URL must not contain credentials');
  validateCues(input.cues);
  const originKey=`${input.partnerId}:${input.entryId}:${input.captionId}:${input.language}`;
  const id=createHash('sha256').update(JSON.stringify([input.ownerId,originKey,input.subtitleHash])).digest('hex');
  return {
    document:{id,ownerId:input.ownerId,courseId:input.courseId||'',createdAt:input.acquiredAt,
      name:`${input.title} · ${input.language}`,hash:input.subtitleHash,mime:'text/vtt',origin:'kaltura',originKey,
      rawUri:`archive://sha256/${input.subtitleHash}`},
    pages:input.cues.map((cue,index)=>({pageNumber:index+1,locator:`Kaltura ${input.entryId} ${displayTime(cue.startMs)}–${displayTime(cue.endMs)}`,
      text:cue.text,contentKind:'time_segment' as const,startMs:cue.startMs,endMs:cue.endMs})),
    options:{parserVersion:'recording-subtitle-v1',extractionMethod:input.method,evidenceConfidence:input.method==='platform-caption'?0.8:0.6,
      recording:{partnerId:input.partnerId,entryId:input.entryId,captionId:input.captionId,language:input.language,
        sourceUrl:input.sourceUrl,canvasCourseId:input.canvasCourseId||null,method:input.method,model:input.model||null,publishedAt:input.publishedAt||null,
        ...(input.asr?{asr:input.asr}:{})}},
  };
}
