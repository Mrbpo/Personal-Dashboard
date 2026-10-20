import {readFile} from 'node:fs/promises';
import {kernel} from '../lib/kernel/service.ts';
import {kernelPool} from '../lib/kernel/db.ts';

const [command,owner,target,reason,...extra]=process.argv.slice(2);
try{
 if(command==='list'&&owner&&target&&!reason&&!extra.length){
  console.log(JSON.stringify(await kernel.documentClassifications(owner,target),null,2));
 }else if(command==='record'&&owner&&target&&reason?.trim()&&!extra.length){
  const actor=process.env.SUDO_USER||process.env.USER||process.env.USERNAME;
  if(!actor||actor==='root')throw Error('Run under a named administrator account');
  const bytes=await readFile(target);if(bytes.length>65536)throw Error('Classification input exceeds 64 KiB');
  console.log(JSON.stringify(await kernel.recordDocumentClassification(owner,JSON.parse(bytes.toString('utf8')),actor,reason),null,2));
 }else{
  console.error('Usage: node --experimental-strip-types scripts/kernel-classify.ts list <owner> <document-id> | record <owner> <input.json> "reason"');
  process.exitCode=2;
 }
}finally{if(process.env.KERNEL_DATABASE_URL)await kernelPool().end();}
