type SketchPollSnapshot={book:{id:string;status:string};pages:unknown[]};

export const isSketchEditable=(status?:string)=>status==='active'||status==='archived';
export const shouldRetrySketchPageSave=(status:string,dirty:boolean,drawing:boolean)=>isSketchEditable(status)&&dirty&&!drawing;

export function planSketchPoll<T extends SketchPollSnapshot>(current:T,next:T,hasLocalWork:boolean):
  {kind:'none'}|{kind:'inspectCurrent'}|{kind:'apply';snapshot:T}|{kind:'switch';snapshot:T}{
  if(next.book.id!==current.book.id){
    return hasLocalWork?{kind:'inspectCurrent'}:{kind:'switch',snapshot:next};
  }
  if(next.book.status!==current.book.status){
    return {kind:'apply',snapshot:hasLocalWork?{...next,pages:current.pages}:next};
  }
  return {kind:'none'};
}
