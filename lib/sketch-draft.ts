export type SketchDraftSnapshot = { bookId:string; status:string; current:string; saved:string };

// Serialize writes and compare the value typed now with the exact value that
// completed on the server. A later edit during a request is sent next.
export function createSketchDraftSaver(
  read:()=>SketchDraftSnapshot|null,
  write:(bookId:string,text:string)=>Promise<void>,
  markSaved:(bookId:string,text:string)=>void,
){
  let queue:Promise<void>=Promise.resolve();
  return function flush(){
    const bookId=read()?.bookId;
    if(!bookId)return Promise.resolve();
    queue=queue.catch(()=>undefined).then(async()=>{
      for(;;){
        const snapshot=read();
        if(!snapshot||snapshot.bookId!==bookId||snapshot.status==='archiving'||snapshot.current===snapshot.saved)return;
        const text=snapshot.current;
        await write(bookId,text);
        markSaved(bookId,text);
      }
    });
    return queue;
  };
}
