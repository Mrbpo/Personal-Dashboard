export type SketchDraftSnapshot = { bookId:string; status:string; current:string; saved:string };

// A request can return a snapshot taken before an edit or a draft write. Keep
// the local value and its latest acknowledged save for that same book.
export function reconcileSketchDraft<T extends {book:{id:string;draft_text:string}}>(
  previous:T|null,
  next:T,
  current:string,
  revisionAtLoad:number,
  currentRevision:number,
):{snapshot:T;draft:string}{
  if(previous?.book.id===next.book.id&&(current!==previous.book.draft_text||revisionAtLoad!==currentRevision)){
    return {snapshot:{...next,book:{...next.book,draft_text:previous.book.draft_text}},draft:current};
  }
  return {snapshot:next,draft:next.book.draft_text};
}

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
