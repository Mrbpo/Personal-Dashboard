type Timer=ReturnType<typeof setTimeout>;
type Options={
  delayMs?:number;
  maxWaitMs?:number;
  now?:()=>number;
  setTimer?:(callback:()=>void,delay:number)=>Timer;
  clearTimer?:(timer:Timer)=>void;
};

// Coalesce completed strokes, but write within maxWaitMs across a run of
// strokes. Explicit flushes always wait for the underlying save chain.
export function createSketchPageSaveScheduler(save:()=>Promise<void>,options:Options={}){
  const {delayMs=900,maxWaitMs=5000,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}=options;
  let timer:Timer|null=null,firstQueuedAt:number|null=null;
  const clear=()=>{if(timer!==null){clearTimer(timer);timer=null;}};
  return {
    schedule(){
      if(firstQueuedAt===null)firstQueuedAt=now();
      clear();
      const wait=Math.max(0,Math.min(delayMs,maxWaitMs-(now()-firstQueuedAt)));
      timer=setTimer(()=>{timer=null;firstQueuedAt=null;void save().catch(()=>undefined);},wait);
    },
    pause(){clear();},
    flush(){clear();firstQueuedAt=null;return save();},
  };
}
