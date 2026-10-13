import {kernel} from '../lib/kernel/service.ts';
import {kernelPool} from '../lib/kernel/db.ts';
import {claimIngestionJob,renewIngestionJob,finishIngestionJob} from '../lib/kernel/jobs.ts';

// The optional one-shot runner uses exact queued IDs and the normal durable
// leases. It cannot steal a source sync job or bypass retry/budget limits.
const [command,owner,...filters]=process.argv.slice(2);
const courseId=filters.find(value=>value.startsWith('--course='))?.slice(9);
const documentId=filters.find(value=>value.startsWith('--document='))?.slice(11);
const concurrency=Number(filters.find(value=>value.startsWith('--concurrency='))?.slice(14)??1);
let stopping=false;
process.on('SIGINT',()=>{stopping=true;});process.on('SIGTERM',()=>{stopping=true;});
try{
  if(!owner||!['queue','status','run'].includes(command)||![1,2].includes(concurrency)||
    filters.some(value=>!/^--(?:course|document)=.+/.test(value)&&!/^--concurrency=[12]$/.test(value))){
    console.error('Usage: node --experimental-strip-types scripts/index-document-vectors.ts queue|status|run <owner> [--course=<id>] [--document=<id>] [--concurrency=1|2]');
    process.exitCode=2;
  }else{
    const scope={courseId,documentId};
    if(command==='queue')console.log(JSON.stringify({jobIds:await kernel.queueDocumentVectorJobs(owner,scope)}));
    else if(command==='status')console.log(JSON.stringify(await kernel.documentVectorCoverage(owner,scope)));
    else{
      const ids=await kernel.queueDocumentVectorJobs(owner,scope);
      let next=0,completed=0,deferred=0,failures=0;
      await Promise.all(Array.from({length:concurrency},async()=>{
        while(!stopping&&next<ids.length){
          const id=ids[next++],job=await claimIngestionJob(id);
          if(!job){deferred++;continue;}
          const renewal=setInterval(()=>{void renewIngestionJob(id,job.lease_token).catch(()=>{
            console.error(JSON.stringify({jobId:id,error:'lease-renewal-failed'}));
          });},30000);
          try{
            await kernel.runDocumentVectorJob(job);
            await finishIngestionJob(id,job.lease_token);completed++;
          }catch(error){
            const reason=error instanceof Error?error.message:'PDF vector indexing failed';
            await finishIngestionJob(id,job.lease_token,reason);
            failures++;
            // One failure ends this invocation; the normal queue owns retries.
            stopping=true;
            console.error(JSON.stringify({jobId:id,error:/budget|预算|上限/iu.test(reason)?'budget-limit':'indexing-failed'}));
          }finally{clearInterval(renewal);}
        }
      }));
      console.log(JSON.stringify({queued:ids.length,completed,deferred,failures,
        coverage:await kernel.documentVectorCoverage(owner,scope)}));
      if(failures||stopping)process.exitCode=1;
    }
  }
}finally{await kernelPool().end();}
