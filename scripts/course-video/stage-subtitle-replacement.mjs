/** Operator only. Write a new staged ledger. Apply while holding the track idle and checking the original digest. */
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {prepareSubtitleReplacement,subtitleDigest} from '../../lib/subtitle-ledger-recovery.ts';

const [work,video,source,ordinal,expectedLedger,expectedReceipt,operator,output]=process.argv.slice(2);
if(!output||![video,source,expectedLedger].every(v=>/^[a-f0-9]{64}$/.test(v))||
   !(expectedReceipt==='absent'||/^[a-f0-9]{64}$/.test(expectedReceipt))||!/^\d+$/.test(ordinal))
  throw new Error('Expected work dir, video SHA, source SHA, call number, ledger SHA, receipt SHA or absent, operator and new output path');
const root=join(work,'translation-output'),bytes=await readFile(join(root,video+'.translation-ledger.json'),'utf8');
const original=JSON.parse(bytes),bundle=JSON.parse(await readFile(join(root,video+'.json'),'utf8'));
if(original.sourceHash!==source||bundle.source.subtitleSha256!==source||bundle.videoSha256!==video||
  subtitleDigest(await readFile(join(work,'translation-input','source.vtt')))!==source)throw new Error('Subtitle source changed');
let receipt=null;
try{receipt=await readFile(join(root,video+'.response-'+ordinal+'.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
if((receipt===null?'absent':subtitleDigest(receipt))!==expectedReceipt)throw new Error('Receipt changed');
const firstMissing=bundle.cues.findIndex(c=>c.zh===null);
const updated=prepareSubtitleReplacement(video,bytes,Number(ordinal),expectedLedger,firstMissing,operator,receipt);
await writeFile(output,JSON.stringify(updated,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({ordinal:Number(ordinal),missing:bundle.cues.filter(c=>c.zh===null).length,
  priorReservation:updated.calls.at(-1).reservation,reason:updated.calls.at(-1).replacementReview.reason,modelRequests:0}));
