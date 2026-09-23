// Dry-run by default. Re-running --apply resumes from remaining stale rows.
// Output contains counts and budget estimates only, never mail content or IDs.
import {backfillMailEmbeddings} from '../lib/mail-embedding.ts';

function value(name:string,defaultValue:number){
 const position=process.argv.indexOf(name);
 if(position<0)return defaultValue;
 if(position+1>=process.argv.length)throw new Error('参数缺少数值');
 return Number(process.argv[position+1]);
}

try{
 const known=new Set(['--apply','--limit','--batch-size','--max-cost-usd']);
 if(process.argv.slice(2).some(arg=>arg.startsWith('--')&&!known.has(arg)))throw new Error('未知参数');
 const result=await backfillMailEmbeddings({
  apply:process.argv.includes('--apply'),
  limit:value('--limit',16),
  batchSize:value('--batch-size',8),
  maxReservedUsd:value('--max-cost-usd',0.01),
 });
 console.log(JSON.stringify(result));
}catch{
 // Service errors may contain provider details. Keep CLI output content-free.
 console.error('mail_embedding_backfill_failed');
 process.exitCode=1;
}
