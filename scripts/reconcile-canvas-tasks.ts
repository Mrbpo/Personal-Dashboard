import { kernel } from '../lib/kernel/service.ts';
import { kernelPool, migrateKernel } from '../lib/kernel/db.ts';

const args=process.argv.slice(2);
const value=(flag:string)=>{const index=args.indexOf(flag);return index<0?null:args[index+1]??null;};
await migrateKernel();
try {
  const before=await kernel.canvasDuplicateReport();
  if(args.includes('--rollback')){
    const planner=value('--planner');
    if(!planner)throw new Error('--rollback requires --planner TASK_ID');
    console.log(JSON.stringify({before:before.activeCount,rollback:await kernel.unmergeCanvasTasks(planner),
      after:await kernel.canvasDuplicateReport()},null,2));
  }else if(args.includes('--apply-verified')){
    const expected=Number(value('--expected-active'));
    if(!Number.isInteger(expected)||before.activeCount!==expected||value('--expected-plan')!==before.planHash)
      throw new Error('Active count changed since review; rerun without --apply-verified');
    const applied=[];
    const blocked=[];
    for(const pair of before.verified){
      try{applied.push(await kernel.mergeCanvasTasks(pair.plannerTaskId,pair.directTaskId,
        `verified Canvas reference ${pair.reference}`));}
      catch(error){blocked.push({...pair,error:String(error)});}
    }
    console.log(JSON.stringify({before:before.activeCount,applied,blocked,after:await kernel.canvasDuplicateReport()},null,2));
    if(blocked.length)process.exitCode=1;
  }else if(args.includes('--apply-manual')){
    const planner=value('--planner'),direct=value('--direct'),reason=value('--reason');
    const expected=Number(value('--expected-active'));
    if(!planner||!direct||!reason||!Number.isInteger(expected)||before.activeCount!==expected)
      throw new Error('Manual adjudication needs --planner, --direct, --reason and reviewed --expected-active');
    console.log(JSON.stringify({before:before.activeCount,
      applied:await kernel.mergeCanvasTasks(planner,direct,reason,true),
      after:await kernel.canvasDuplicateReport()},null,2));
  }else console.log(JSON.stringify(before,null,2));
}finally{await kernelPool().end();}
