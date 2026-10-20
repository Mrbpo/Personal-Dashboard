import {readFile} from 'node:fs/promises';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool} from '../lib/kernel/db.ts';

const [command,owner,target,reason,...extra]=process.argv.slice(2);
try{
 if(command==='list'&&owner&&target&&!reason&&!extra.length){
  console.log(JSON.stringify(await kernel.documentClassifications(owner,target),null,2));
 }else if(command==='prepare-topics'&&owner&&target&&!extra.length){
  console.log(JSON.stringify(await kernel.prepareDocumentTopics(owner,target,reason?JSON.parse(reason):undefined),null,2));
 }else if((command==='record'||command==='import-topics')&&owner&&target&&reason?.trim()&&!extra.length){
  const actor=process.env.SUDO_USER||process.env.USER||process.env.USERNAME;
  if(!actor||actor==='root')throw Error('Run under a named administrator account');
  const bytes=await readFile(target);if(bytes.length>(command==='record'?65536:131072))throw Error('Classification input exceeds its bound');
  const value=JSON.parse(bytes.toString('utf8'));
  if(command==='record')console.log(JSON.stringify(await kernel.recordDocumentClassification(owner,value,actor,reason),null,2));
  else{
   if(!value||Object.keys(value).sort().join(',')!=='packet,rawResponse')throw Error('Import requires packet and rawResponse only');
   console.log(JSON.stringify(await kernel.importDocumentTopics(owner,value.packet,value.rawResponse,actor,reason),null,2));
  }
 }else{
  console.error('Usage: kernel-classify.ts list <owner> <document-id> | record <owner> <input.json> "reason" | prepare-topics <owner> <document-id> [page-array-json] | import-topics <owner> <packet-and-response.json> "reason"');
  process.exitCode=2;
 }
}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}
