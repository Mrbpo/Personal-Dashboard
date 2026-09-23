export function isPenEraser(event:{pointerType:string;button:number;buttons:number}){
  return event.pointerType==='pen'&&(event.button===5||(event.buttons&32)!==0);
}

export function annotationShortcut(event:{key:string;ctrlKey:boolean;metaKey:boolean;shiftKey:boolean;altKey:boolean}):'undo'|'redo'|null{
  if(event.altKey||!(event.ctrlKey||event.metaKey))return null;
  const key=event.key.toLowerCase();
  if(key==='z')return event.shiftKey?'redo':'undo';
  if(key==='y'&&!event.shiftKey)return 'redo';
  return null;
}
