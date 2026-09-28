import { createHash } from 'node:crypto';
import { getHistoricalPlannerSources } from '../canvas.ts';
import { hashSource } from '../canvas-source-hash.ts';
import type { CanvasSource } from '../domain.ts';
import { kernelPool, kernelTransaction } from './db.ts';
import { kernel } from './service.ts';
import { canvasTaskReference } from './task-identity.ts';

type Candidate = { taskId: string; sourceItemId: string; sourceId: string; courseId: string; dueDate: string };
type Window = { index: number; courseId: string; start: string; end: string; sourceIds: string[] };
export type PlannerBackfillPlan = {
  asOf: string; from: string; through: string; candidateCount: number; candidates: Candidate[];
  windows: Window[]; excluded: Array<{taskId:string;reason:string}>; planHash: string;
};

const dayMs = 86400000;
function date(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Expected YYYY-MM-DD date');
  const epoch=Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString().slice(0,10)!==value)
    throw new Error('Invalid calendar date');
  return epoch;
}
const dateAt=(epoch:number)=>new Date(epoch).toISOString().slice(0,10);
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function planCanvasPlannerBackfill(options: {asOf?:string;from?:string;through?:string} = {}): Promise<PlannerBackfillPlan> {
  const asOf=options.asOf??new Date().toISOString().slice(0,10);
  const today=date(asOf);
  const from=options.from??dateAt(today-365*dayMs);
  const through=options.through??dateAt(today-121*dayMs);
  const first=date(from),last=date(through);
  if (first>last || first<today-365*dayMs || last>today-121*dayMs)
    throw new Error('Historical range must be within days 121–365 before --as-of');
  const report=await kernel.canvasDuplicateReport();
  const unresolved=report.unresolved.filter(row=>row.reason==='missing reliable typed reference');
  const ids=unresolved.map(row=>row.plannerTaskId);
  const rows=ids.length?(await kernelPool().query<{
    id:string;source_item_id:string;source_id:string;course_id:string;due_date:Date|string|null;
    source:string;scope:string;source_course_id:string;external_id:string;
  }>(`SELECT t.id,t.source_item_id,t.source_id,t.course_id,t.due_date,
       si.source,si.scope,si.course_id source_course_id,si.external_id
       FROM tasks t JOIN source_items si ON si.id=t.source_item_id WHERE t.id=ANY($1::text[])`,[ids])).rows:[];
  const byId=new Map(rows.map(row=>[row.id,row]));
  const candidates:Candidate[]=[];
  const excluded:Array<{taskId:string;reason:string}>=[];
  for(const item of unresolved){
    const row=byId.get(item.plannerTaskId);
    if(row && row.id!==`${row.source_item_id}:0`){
      excluded.push({taskId:item.plannerTaskId,reason:'additional planner action requires adjudication'});continue;
    }
    if(!row || row.source!=='canvas' || row.scope!==row.course_id ||
      row.source_course_id!==row.course_id || row.external_id!==`planner:${row.source_id}` ||
      !/^[1-9]\d*$/.test(row.course_id) || !/^[1-9]\d*$/.test(row.source_id)) {
      excluded.push({taskId:item.plannerTaskId,reason:'unverifiable stored source identity'});continue;
    }
    const dueDate=row.due_date instanceof Date?row.due_date.toISOString().slice(0,10):row.due_date;
    if(!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      excluded.push({taskId:item.plannerTaskId,reason:'no reliable due date'});continue;
    }
    if(dueDate<from || dueDate>through) {
      excluded.push({taskId:item.plannerTaskId,reason:'outside selected historical range'});continue;
    }
    candidates.push({taskId:row.id,sourceItemId:row.source_item_id,sourceId:row.source_id,
      courseId:row.course_id,dueDate});
  }
  candidates.sort((a,b)=>a.courseId.localeCompare(b.courseId)||a.dueDate.localeCompare(b.dueDate)||a.taskId.localeCompare(b.taskId));
  if(candidates.length>200)throw new Error('More than 200 planner tasks; narrow --from/--through');
  const grouped=new Map<string,{courseId:string;start:string;end:string;sourceIds:Set<string>}>();
  for(const candidate of candidates){
    const epoch=date(candidate.dueDate);
    const start=dateAt(epoch-7*dayMs),end=dateAt(epoch+7*dayMs);
    const key=`${candidate.courseId}|${start}`;
    const group=grouped.get(key)??{courseId:candidate.courseId,start,end,sourceIds:new Set<string>()};
    group.sourceIds.add(candidate.sourceItemId);grouped.set(key,group);
  }
  const windows=[...grouped.values()].sort((a,b)=>a.courseId.localeCompare(b.courseId)||a.start.localeCompare(b.start))
    .map((group,index)=>({index,courseId:group.courseId,start:group.start,end:group.end,
      sourceIds:[...group.sourceIds].sort()}));
  if(windows.length>120)throw new Error('More than 120 planner windows; narrow --from/--through');
  excluded.sort((a,b)=>a.taskId.localeCompare(b.taskId));
  const manifest={asOf,from,through,candidateCount:candidates.length,candidates,windows,excluded};
  return {...manifest,planHash:digest(manifest)};
}

type WindowResult = {accepted:string[];skipped:Array<{sourceItemId:string;reason:string}>};
async function applyWindow(window:Window):Promise<WindowResult>{
  const fetched=await getHistoricalPlannerSources(window.courseId,window.start,window.end,
    new Set(window.sourceIds));
  const byId=new Map<string,CanvasSource[]>();
  for(const source of fetched)byId.set(source.id,[...(byId.get(source.id)??[]),source]);
  const result:WindowResult={accepted:[],skipped:[]};
  for(const sourceItemId of window.sourceIds){
    const matches=byId.get(sourceItemId)??[];
    const skip=(reason:string)=>result.skipped.push({sourceItemId,reason});
    if(matches.length!==1){skip(matches.length?'ambiguous planner item':'planner item absent');continue;}
    const source=matches[0];
    const ref=canvasTaskReference(source);
    if(!ref){skip('missing reliable typed reference');continue;}
    const direct=(await kernelPool().query<{id:string}>(
      `SELECT t.id FROM tasks t JOIN entities e ON e.id=t.entity_id
       WHERE t.course_id=$1 AND t.source_type=$2 AND t.source_id=$3 AND e.merged_into IS NULL`,
      [window.courseId,ref.type,ref.id])).rows;
    if(direct.length!==1){skip('typed direct object absent or ambiguous');continue;}
    try{
      await kernel.ingestCanvasSource(source,null,await hashSource(source),'canvas',true);
      result.accepted.push(sourceItemId);
    }catch(error){
      if(error instanceof Error && /^CANVAS_PLANNER_(SOURCE_IDENTITY_MISMATCH|SOURCE_REFERENCE_MISMATCH|TYPED_REFERENCE_MISMATCH|PRIOR_REFERENCE_UNVERIFIED|NO_ACTIVE_TASK)$/.test(error.message)){
        skip(error.message);continue;
      }
      throw error;
    }
  }
  return result;
}

/** Reusing the stored manifest allows a failed or interrupted run to resume after source data changes. */
export async function applyCanvasPlannerBackfill(input:{expectedCount:number;expectedPlan:string;actor:string;
  asOf?:string;from?:string;through?:string}) {
  if(!Number.isInteger(input.expectedCount)||input.expectedCount<0||
    !/^[a-f0-9]{64}$/.test(input.expectedPlan)||!input.actor.trim())
    throw new Error('Apply requires reviewed --expected-count, --expected-plan and --actor');
  const lock=await kernelPool().connect();
  try{
    const acquired=(await lock.query<{locked:boolean}>(
      "SELECT pg_try_advisory_lock(hashtext('canvas-planner-backfill')) locked")).rows[0].locked;
    if(!acquired)throw new Error('Another Canvas planner backfill is running');
    try{
      const stored=(await kernelPool().query<{manifest:PlannerBackfillPlan;candidate_count:number}>(
        'SELECT manifest,candidate_count FROM canvas_planner_backfill_plans WHERE plan_hash=$1',
        [input.expectedPlan])).rows[0];
      let plan:PlannerBackfillPlan;
      if(stored){
        if(stored.candidate_count!==input.expectedCount)throw new Error('Reviewed candidate count differs from stored plan');
        plan={...stored.manifest,planHash:input.expectedPlan};
      }else{
        plan=await planCanvasPlannerBackfill(input);
        if(plan.candidateCount!==input.expectedCount||plan.planHash!==input.expectedPlan)
          throw new Error('Planner backfill plan changed since review; rerun the read-only plan');
        await kernelTransaction(async client=>{
          await client.query('INSERT INTO canvas_planner_backfill_plans(plan_hash,candidate_count,manifest,actor) VALUES ($1,$2,$3,$4)',
            [plan.planHash,plan.candidateCount,JSON.stringify(plan),input.actor.trim()]);
          for(const window of plan.windows)await client.query(
            `INSERT INTO canvas_planner_backfill_windows(plan_hash,window_index,course_id,start_on,end_on,source_ids)
             VALUES ($1,$2,$3,$4,$5,$6)`, [plan.planHash,window.index,window.courseId,window.start,window.end,
              JSON.stringify(window.sourceIds)]);
        });
      }
      const completed:Array<{window:number;result:WindowResult}>=[];
      const review:Array<{window:number;result:WindowResult}>=[];
      for(const window of plan.windows){
        const checkpoint=(await kernelPool().query<{state:string;result:WindowResult|null}>(
          'SELECT state,result FROM canvas_planner_backfill_windows WHERE plan_hash=$1 AND window_index=$2',
          [plan.planHash,window.index])).rows[0];
        if(checkpoint?.state==='complete'){completed.push({window:window.index,result:checkpoint.result!});continue;}
        await kernelPool().query(
          `UPDATE canvas_planner_backfill_windows SET state='running',attempts=attempts+1,last_error=NULL
           WHERE plan_hash=$1 AND window_index=$2`,[plan.planHash,window.index]);
        try{
          const result=await applyWindow(window);
          const state=result.skipped.length?'review':'complete';
          await kernelPool().query(
            `UPDATE canvas_planner_backfill_windows SET state=$3,result=$4,last_error=NULL,
             completed_at=CASE WHEN $3='complete' THEN now() ELSE NULL END
             WHERE plan_hash=$1 AND window_index=$2`,[plan.planHash,window.index,state,JSON.stringify(result)]);
          (state==='complete'?completed:review).push({window:window.index,result});
        }catch(error){
          await kernelPool().query(
            `UPDATE canvas_planner_backfill_windows SET state='error',last_error=$3
             WHERE plan_hash=$1 AND window_index=$2`,[plan.planHash,window.index,String(error).slice(0,500)]);
          throw error;
        }
      }
      return {planHash:plan.planHash,candidateCount:plan.candidateCount,completed,review,
        reconciliation:await kernel.canvasDuplicateReport()};
    }finally{await lock.query("SELECT pg_advisory_unlock(hashtext('canvas-planner-backfill'))");}
  }finally{lock.release();}
}
