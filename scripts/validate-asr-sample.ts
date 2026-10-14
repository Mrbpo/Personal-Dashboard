import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {recordingCaptionInput} from '../lib/kernel/recording-caption-import.ts';
import {prepareRecordingTranscript} from '../lib/kernel/recording-transcript.ts';

const [directory]=process.argv.slice(2);
if(!directory)throw new Error('Usage: validate-asr-sample.ts SAMPLE_DIRECTORY');
const source=JSON.parse(readFileSync(resolve(directory,'sample-source.json'),'utf8'));
const bytes=readFileSync(resolve(directory,'sample-600-900.vtt'));
const provenance=JSON.parse(readFileSync(resolve(directory,'sample-600-900.vtt.provenance.json'),'utf8'));
const input=recordingCaptionInput({...source,seenAt:Date.parse(source.extractedAt)/1000,
  files:[{kind:'video',sha256:source.originalSha256}]},
  {kind:'caption',path:'sample-600-900.vtt',method:'local-asr',captionId:'asr_sample_600_900',
    language:'en',format:'vtt',sha256:provenance.subtitleSha256},bytes,'validation-only',undefined,provenance);
const prepared=prepareRecordingTranscript(input);
console.log(JSON.stringify({state:'asr_sample_format_and_source_validated',method:input.method,cues:input.cues.length,
  sourceEntryId:input.entryId,model:input.model,modelRevision:input.asr?.modelRevision,
  sourceVideoSha256:input.asr?.sourceVideoSha256,startMs:input.cues[0].startMs,endMs:input.cues.at(-1)?.endMs,
  firstLocator:prepared.pages[0].locator,lastLocator:prepared.pages.at(-1)?.locator,
  evidenceConfidence:prepared.options.evidenceConfidence,pgWriteRequested:false,asrAccuracyVerified:false}));
