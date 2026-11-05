export type ASRProvenance={schemaVersion:1;method:'local-asr';model:string;modelRevision:string;modelSha256:string;
  sourceVideoSha256:string;sourceAudioSha256:string;subtitleSha256:string;clipStartMs:number;clipEndMs:number;
  timestampBasis:'clip-relative'|'source-absolute';computeType:'int8';language:string;
  timingProfile?:'word-pause-v1';wordEvidenceSha256?:string;
  timingConfig?:{maxCueSeconds:7;maxCueWords:14;pauseSeconds:0.65}};

/** Shared adapter/kernel validation; returns only stable provenance fields. */
export function validateASRProvenance(value:unknown,expected:{model?:string;language:string;subtitleHash:string}):ASRProvenance {
  const data=value as ASRProvenance|undefined;
  if(!data||data.schemaVersion!==1||data.method!=='local-asr'||typeof data.model!=='string'||!data.model.trim()||
    !/^[a-f0-9]{40}$/u.test(data.modelRevision)||data.computeType!=='int8'||data.language!==expected.language||
    ![data.modelSha256,data.sourceVideoSha256,data.sourceAudioSha256,data.subtitleSha256].every(hash=>typeof hash==='string'&&/^[a-f0-9]{64}$/u.test(hash))||
    data.subtitleSha256!==expected.subtitleHash||!Number.isSafeInteger(data.clipStartMs)||data.clipStartMs<0||
    !Number.isSafeInteger(data.clipEndMs)||data.clipEndMs<=data.clipStartMs||
    !['clip-relative','source-absolute'].includes(data.timestampBasis)||
    (expected.model!==undefined&&data.model!==expected.model))throw new Error('Invalid ASR provenance');
  const hasTiming=data.timingProfile!==undefined||data.wordEvidenceSha256!==undefined||data.timingConfig!==undefined;
  if(hasTiming&&(data.timingProfile!=='word-pause-v1'||typeof data.wordEvidenceSha256!=='string'||
    !/^[a-f0-9]{64}$/u.test(data.wordEvidenceSha256)||!data.timingConfig||
    data.timingConfig.maxCueSeconds!==7||data.timingConfig.maxCueWords!==14||data.timingConfig.pauseSeconds!==0.65))
    throw new Error('Invalid ASR timing provenance');
  return {schemaVersion:1,method:'local-asr',model:data.model,modelRevision:data.modelRevision,modelSha256:data.modelSha256,
    sourceVideoSha256:data.sourceVideoSha256,sourceAudioSha256:data.sourceAudioSha256,subtitleSha256:data.subtitleSha256,
    clipStartMs:data.clipStartMs,clipEndMs:data.clipEndMs,timestampBasis:data.timestampBasis,computeType:'int8',language:data.language,
    ...(hasTiming?{timingProfile:data.timingProfile,wordEvidenceSha256:data.wordEvidenceSha256,
      timingConfig:{maxCueSeconds:7,maxCueWords:14,pauseSeconds:0.65}}:{})};
}

/** Kernel inputs are already original-video offsets, regardless of the raw VTT basis. */
export function validateASRAbsoluteCues(data:ASRProvenance,cues:Array<{startMs:number;endMs:number}>):void {
  if(cues.some(cue=>cue.startMs<data.clipStartMs||cue.endMs>data.clipEndMs))
    throw new Error('ASR cue is outside declared source window');
}
