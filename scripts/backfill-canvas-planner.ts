import { applyCanvasPlannerBackfill, planCanvasPlannerBackfill } from '../lib/kernel/canvas-planner-backfill.ts';
import { kernelPool } from '../lib/kernel/db.ts';

const args=process.argv.slice(2);
const allowed=new Set(['--apply','--status','--as-of','--from','--through','--expected-count','--expected-plan','--actor']);
const value=(name:string)=>{const index=args.indexOf(name);return index<0?null:args[index+1]??null;};
for(const arg of args)if(arg.startsWith('--')&&!allowed.has(arg))throw new Error(`Unknown option: ${arg}`);
const options={asOf:value('--as-of')??undefined,from:value('--from')??undefined,
  through:value('--through')??undefined};
try{
  if(args.includes('--status')){
    const planHash=value('--expected-plan');
    if(!planHash)throw new Error('--status requires --expected-plan HASH');
    const plan=(await kernelPool().query(
      'SELECT plan_hash,candidate_count,manifest,actor,created_at FROM canvas_planner_backfill_plans WHERE plan_hash=$1',
      [planHash])).rows[0];
    const windows=(await kernelPool().query(
      `SELECT window_index,course_id,start_on,end_on,state,attempts,last_error,result,completed_at
       FROM canvas_planner_backfill_windows WHERE plan_hash=$1 ORDER BY window_index`,[planHash])).rows;
    console.log(JSON.stringify({plan:plan??null,windows},null,2));
  }else if(args.includes('--apply')){
    const expectedCount=Number(value('--expected-count'));
    const expectedPlan=value('--expected-plan')??'';
    const actor=(value('--actor')||process.env.SUDO_USER||process.env.USER||process.env.USERNAME||'').trim();
    if(value('--expected-count')===null)throw new Error('--expected-count is required');
    console.log(JSON.stringify(await applyCanvasPlannerBackfill({expectedCount,expectedPlan,actor,...options}),null,2));
  }else{
    if(value('--expected-count')!==null||value('--expected-plan')!==null||value('--actor')!==null)
      throw new Error('Review values are only valid with --apply or --status');
    console.log(JSON.stringify(await planCanvasPlannerBackfill(options),null,2));
  }
}finally{await kernelPool().end();}
