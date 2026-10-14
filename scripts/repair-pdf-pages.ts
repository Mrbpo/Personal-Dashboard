import {readFile,writeFile} from 'node:fs/promises';
import {kernelPool} from '../lib/kernel/db.ts';
import {pageRepairEstimate,pageRepairPlanHash,recognizePageRepair,applyPageRepair,verifyAppliedPageRepair,type PageRepairPlan,type PageRepairResult} from '../lib/pdf-page-repair.ts';

const args=process.argv.slice(2);
const value=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const planFile=value('--plan'),resultFile=value('--result');
const recognize=args.includes('--recognize'),apply=args.includes('--apply');
if(!planFile||!resultFile||(recognize&&apply))throw new Error('Use --plan FILE --result FILE with --recognize or --apply (neither means zero-call estimate)');
const plan=JSON.parse(await readFile(planFile,'utf8')) as PageRepairPlan;
const planHash=pageRepairPlanHash(plan);
try{
 if(!apply){
  const estimate=await pageRepairEstimate(plan);
  console.log(JSON.stringify({action:'page-repair-estimate',planHash,...estimate}));
  if(recognize){
   if(estimate.availableUsd<estimate.maximumReservationUsd)throw new Error('Conservative page-repair reservation exceeds the existing available budget');
   if(estimate.maximumReservationUsd>.236+Number.EPSILON)throw new Error('Page repair exceeds the authorized $0.236 maximum reservation');
   if(estimate.remainingDailyRequests<estimate.maximumRequests)throw new Error('Page repair exceeds the existing remaining daily request quota');
   const report:{planHash:string;model:string;results:PageRepairResult[];error?:string}={planHash,model:estimate.model,results:[]};
   // Confirm staging is writable before consuming even one recognition request.
   await writeFile(resultFile,JSON.stringify(report,null,2)+'\n');
   // Saving each success stages work; none of it becomes searchable here.
   try{
    for(const target of plan.documents){
     report.results.push(await recognizePageRepair(plan.owner,target));
     await writeFile(resultFile,JSON.stringify(report,null,2)+'\n');
     console.log(JSON.stringify({action:'page-repair-staged',documentId:target.documentId,originalPages:target.pageNumbers}));
    }
   }catch(error){report.error=error instanceof Error?error.message:String(error);await writeFile(resultFile,JSON.stringify(report,null,2)+'\n');throw error;}
   console.log(JSON.stringify({action:'page-repair-recognition-complete',settledEstimate:await pageRepairEstimate(plan)}));
  }
 }else{
  const report=JSON.parse(await readFile(resultFile,'utf8')) as {planHash:string;results:PageRepairResult[];applied?:Awaited<ReturnType<typeof applyPageRepair>>[]};
  if(report.planHash!==planHash||report.results?.length!==plan.documents.length||new Set(report.results.map(row=>row.documentId)).size!==plan.documents.length||
   report.results.some(row=>!plan.documents.some(target=>target.documentId===row.documentId&&target.sourceHash===row.sourceHash&&target.expectedVersion===row.expectedVersion)))
   throw new Error('Complete exact staged repair plan is required');
  const applied=report.applied||[];
  if(new Set(applied.map(row=>row.documentId)).size!==applied.length||applied.some(row=>!plan.documents.some(target=>target.documentId===row.documentId)))
   throw new Error('Invalid completed repair manifest');
  for(const target of plan.documents){
   const result=report.results.find(row=>row.documentId===target.documentId);
   if(!result)throw new Error('Staged original document is missing');
   const completed=applied.find(row=>row.documentId===target.documentId);
   if(completed){await verifyAppliedPageRepair(plan.owner,target,result,completed);console.log(JSON.stringify({action:'page-repair-resumed-complete',documentId:target.documentId,currentVersion:completed.currentVersion}));continue;}
   applied.push(await applyPageRepair(plan.owner,target,result));
   await writeFile(resultFile,JSON.stringify({...report,applied},null,2)+'\n');
   console.log(JSON.stringify({action:'page-repair-published',...applied.at(-1)}));
  }
 }
}finally{await kernelPool().end();}
