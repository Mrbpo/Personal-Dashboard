import { kernel } from '../lib/kernel/service.ts';
import { kernelPool, migrateKernel } from '../lib/kernel/db.ts';

const args=process.argv.slice(2);
const value=(flag:string)=>{const index=args.indexOf(flag);return index<0?null:args[index+1]??null;};
const actor=(value('--actor')||process.env.SUDO_USER||process.env.USER||process.env.USERNAME||'').trim();
await migrateKernel();
try {
  const before=await kernel.canvasDuplicateReport();
  if(args.includes('--rollback')){
    const planner=value('--planner'),reason=value('--reason');
    if(!planner||!reason||!actor)throw new Error('--rollback requires --planner, --reason and --actor');
    console.log(JSON.stringify({before:before.activeCount,rollback:await kernel.unmergeCanvasTasks(planner,reason,actor),
      after:await kernel.canvasDuplicateReport()},null,2));
  }else if(args.includes('--apply-verified')){
    const expected=Number(value('--expected-active'));
    if(!actor)throw new Error('Operator identity is required (--actor or USER/SUDO_USER)');
    if(value('--expected-active')===null||!Number.isInteger(expected)||
      before.activeCount!==expected||value('--expected-plan')!==before.planHash)
      throw new Error('Reconciliation plan changed since review; rerun without --apply-verified');
    const applied=[];
    const blocked=[];
    for(const pair of before.verified){
      try{applied.push(await kernel.mergeCanvasTasks(pair.plannerTaskId,pair.directTaskId,
        `verified Canvas reference ${pair.reference}`,actor));}
      catch(error){blocked.push({...pair,error:String(error)});}
    }
    console.log(JSON.stringify({before:before.activeCount,applied,blocked,after:await kernel.canvasDuplicateReport()},null,2));
    if(blocked.length)process.exitCode=1;
  }else if(args.includes('--apply-manual')){
    const planner=value('--planner'),direct=value('--direct'),reason=value('--reason');
    const expected=Number(value('--expected-active'));
    if(!planner||!direct||!reason||!actor||value('--expected-active')===null||
      !Number.isInteger(expected)||before.activeCount!==expected)
      throw new Error('Manual adjudication needs --planner, --direct, --reason, --actor and reviewed --expected-active');
    console.log(JSON.stringify({before:before.activeCount,
      applied:await kernel.mergeCanvasTasks(planner,direct,reason,actor,true),
      after:await kernel.canvasDuplicateReport()},null,2));
  }else console.log(JSON.stringify(before,null,2));
}finally{await kernelPool().end();}
