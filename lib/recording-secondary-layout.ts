export type SecondaryLayout={x:number;y:number;width:number};
export type SecondaryArea={width:number;height:number};
export const defaultSecondaryLayout:SecondaryLayout={x:1,y:1,width:0.25};
const clamp=(value:number,min:number,max:number)=>Math.min(max,Math.max(min,value));
export function secondaryLayout(value:unknown):SecondaryLayout{
 if(!value||typeof value!=='object')return {...defaultSecondaryLayout};
 const row=value as Record<string,unknown>;
 if(!['x','y','width'].every(key=>typeof row[key]==='number'&&Number.isFinite(row[key])))return {...defaultSecondaryLayout};
 return {x:clamp(row.x as number,0,1),y:clamp(row.y as number,0,1),width:clamp(row.width as number,0.12,0.65)};
}
export function secondaryRect(value:SecondaryLayout,area:SecondaryArea){
 const layout=secondaryLayout(value),padding=Math.min(8,Math.max(0,Math.min(area.width,area.height)/4));
 const availableWidth=Math.max(0,area.width-2*padding),availableHeight=Math.max(0,area.height-2*padding);
 const maximum=Math.max(0,Math.min(availableWidth,availableHeight*16/9,Math.max(0,area.width)*0.65));
 const width=clamp(layout.width*Math.max(0,area.width),Math.min(96,maximum),maximum),height=width*9/16;
 return {x:padding+layout.x*Math.max(0,availableWidth-width),y:padding+layout.y*Math.max(0,availableHeight-height),width,height};
}
export function secondaryLayoutFromPixels(x:number,y:number,width:number,area:SecondaryArea):SecondaryLayout{
 const rect=secondaryRect({x:0,y:0,width:area.width>0?width/area.width:0.25},area);
 return secondaryLayout({x:(x-rect.x)/Math.max(1,area.width-2*rect.x-rect.width),
  y:(y-rect.y)/Math.max(1,area.height-2*rect.y-rect.height),width:area.width>0?rect.width/area.width:0.25});
}

/** DOM-only interaction helper; no video remount and no window outside the player. */
export function attachSecondaryLayout(root:HTMLElement,main:HTMLVideoElement,overlay:HTMLElement,bar:HTMLElement,handle:HTMLButtonElement,
 read:()=>SecondaryLayout,change:(layout:SecondaryLayout,persist:boolean)=>void){
 const area=()=>{
  // Measure stable control heights, not the translated/gradient bottom plate.
  const controls=(root.querySelector('.art-controls') as HTMLElement|null)?.offsetHeight??40;
  const progress=(root.querySelector('.art-progress') as HTMLElement|null)?.offsetHeight??8;
  const reserved=Math.max(64,controls+progress+16);
  return {width:root.clientWidth,height:Math.max(0,Math.min(root.clientHeight,main.getBoundingClientRect().height)-reserved)};
 };
 const draw=()=>{
  const box=secondaryRect(read(),area());
  Object.assign(overlay.style,{left:`${box.x}px`,top:`${box.y}px`,width:`${box.width}px`,height:`${box.height}px`,right:'auto',bottom:'auto',maxHeight:'none'});
 };
 let interaction:{kind:'move'|'resize';pointerId:number;startX:number;startY:number;rect:ReturnType<typeof secondaryRect>;target:HTMLElement}|null=null;
 const stop=(event:Event)=>event.stopPropagation();
 const start=(kind:'move'|'resize')=>(event:PointerEvent)=>{
  event.stopPropagation();
  if(event.button!==0||interaction||kind==='move'&&(event.target as HTMLElement).closest('button'))return;
  event.preventDefault();
  const target=event.currentTarget as HTMLElement;
  interaction={kind,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,rect:secondaryRect(read(),area()),target};
  target.setPointerCapture(event.pointerId);
 };
 const move=(event:PointerEvent)=>{
  if(!interaction||interaction.pointerId!==event.pointerId)return;
  event.preventDefault();event.stopPropagation();
  const {rect,kind,startX,startY}=interaction,dx=event.clientX-startX,dy=event.clientY-startY;
  const next=kind==='move'?secondaryLayoutFromPixels(rect.x+dx,rect.y+dy,rect.width,area()):
   secondaryLayoutFromPixels(rect.x,rect.y,rect.width+(Math.abs(dx)>=Math.abs(dy*16/9)?dx:dy*16/9),area());
  change(next,false);draw();
 };
 const end=(event:PointerEvent)=>{
  if(!interaction||interaction.pointerId!==event.pointerId)return;
  event.stopPropagation();
  const {target,pointerId}=interaction;interaction=null;
  if(target.hasPointerCapture(pointerId))target.releasePointerCapture(pointerId);
  change(read(),true);
 };
 const key=(resize:boolean)=>(event:KeyboardEvent)=>{
  if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)||(event.target as HTMLElement).closest('button')&&event.currentTarget===bar)return;
  event.preventDefault();event.stopPropagation();
  const rect=secondaryRect(read(),area()),step=event.shiftKey?24:8;
  const dx=event.key==='ArrowLeft'?-step:event.key==='ArrowRight'?step:0,dy=event.key==='ArrowUp'?-step:event.key==='ArrowDown'?step:0;
  change(resize?secondaryLayoutFromPixels(rect.x,rect.y,rect.width+(dx||dy*16/9),area()):secondaryLayoutFromPixels(rect.x+dx,rect.y+dy,rect.width,area()),true);draw();
 };
 const drag=start('move'),resize=start('resize'),moveKey=key(false),resizeKey=key(true);
 bar.tabIndex=0;bar.title='拖动标题栏移动副画面，也可用方向键微调';
 handle.title='拖动调整大小，也可用方向键微调';
 bar.addEventListener('pointerdown',drag);handle.addEventListener('pointerdown',resize);
 for(const target of [bar,handle]){
  target.addEventListener('pointermove',move);target.addEventListener('pointerup',end);target.addEventListener('pointercancel',end);target.addEventListener('lostpointercapture',end);
 }
 for(const name of ['click','dblclick','pointerdown','pointerup'])overlay.addEventListener(name,stop);
 bar.addEventListener('keydown',moveKey);handle.addEventListener('keydown',resizeKey);
 const observer=new ResizeObserver(draw);observer.observe(root);observer.observe(main);
 const mutations=new MutationObserver(draw);mutations.observe(root,{attributes:true,attributeFilter:['class','data-caption-size']});
 window.addEventListener('resize',draw);document.addEventListener('fullscreenchange',draw);
 draw();
 return {reset(){change({...defaultSecondaryLayout},true);draw();},dispose(){
  if(interaction){interaction=null;change(read(),true);}
  observer.disconnect();mutations.disconnect();window.removeEventListener('resize',draw);document.removeEventListener('fullscreenchange',draw);
  bar.removeEventListener('pointerdown',drag);handle.removeEventListener('pointerdown',resize);
  for(const target of [bar,handle]){
   target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',end);target.removeEventListener('pointercancel',end);target.removeEventListener('lostpointercapture',end);
  }
  for(const name of ['click','dblclick','pointerdown','pointerup'])overlay.removeEventListener(name,stop);
  bar.removeEventListener('keydown',moveKey);handle.removeEventListener('keydown',resizeKey);
 }};
}
