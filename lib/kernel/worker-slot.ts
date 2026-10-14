/** A tracked in-process slot: no separate worker, service or unhandled promise. */
export class SingleJobSlot {
  private active?:Promise<void>;
  get busy(){return this.active!==undefined;}
  start(run:()=>Promise<void>,onUnexpectedError:()=>void):boolean {
    if(this.active)return false;
    const task=Promise.resolve().then(run).catch(onUnexpectedError).finally(()=>{
      if(this.active===task)this.active=undefined;
    });
    this.active=task;return true;
  }
  async drain(milliseconds:number):Promise<boolean>{
    if(!this.active)return true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([this.active.then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
}

/** At most one Outbox item and one main job per turn. Docling remains tracked
 * independently, while a new primary honors another executor's durable lease. */
export async function dispatchWorkerTurn<Job extends {kind:string}>(slot:SingleJobSlot,operations:{
  canClaim:()=>boolean;runOneOutbox:()=>Promise<void>;hasActiveDocling:()=>Promise<boolean>;
  claim:(excludeKinds:string[])=>Promise<Job|null>;run:(job:Job)=>Promise<void>;onUnexpectedError:()=>void;
}):Promise<boolean>{
  if(!operations.canClaim())return true;
  await operations.runOneOutbox();
  if(!operations.canClaim())return true;
  const busy=slot.busy||await operations.hasActiveDocling();
  if(!operations.canClaim())return true;
  const job=await operations.claim(busy?['docling_document']:[]);
  // A claim racing primary loss stays leased for natural recovery, never runs.
  if(!operations.canClaim())return true;
  if(!job)return false;
  if(job.kind==='docling_document')slot.start(()=>operations.run(job),operations.onUnexpectedError);
  else await operations.run(job);
  return true;
}
