import type {AnnotationPoint,AnnotationShape,AnnotationStroke} from './pdf-annotations.ts';

export type SketchStroke=AnnotationStroke;
export type SketchPoint=AnnotationPoint;
export type SketchTool='view'|'pen'|'eraser'|AnnotationShape;
export const SKETCH_WIDTH=1000;
export const SKETCH_HEIGHT=700;
export const ERASER_RADIUS=14;

export function drawSketchStroke(ctx:CanvasRenderingContext2D,stroke:SketchStroke,highlight=false){
  const points=stroke.points.map(point=>({x:point.x*SKETCH_WIDTH,y:point.y*SKETCH_HEIGHT}));
  if(!points.length)return;
  ctx.beginPath();ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle=highlight?'#ed7558':stroke.color;ctx.lineWidth=stroke.width*SKETCH_WIDTH+(highlight?5:0);
  const [a,b]=points;
  if(stroke.shape==='circle')ctx.arc(a.x,a.y,Math.hypot(b.x-a.x,b.y-a.y),0,Math.PI*2);
  else if(stroke.shape==='rectangle')ctx.rect(a.x,a.y,b.x-a.x,b.y-a.y);
  else{ctx.moveTo(a.x,a.y);if(stroke.shape==='line')ctx.lineTo(b.x,b.y);else if(points.length===1)ctx.lineTo(a.x+.01,a.y+.01);else for(const p of points.slice(1))ctx.lineTo(p.x,p.y);}
  ctx.stroke();
}

function segmentDistance(p:SketchPoint,a:SketchPoint,b:SketchPoint){
  const dx=b.x-a.x,dy=b.y-a.y,t=dx*dx+dy*dy?Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy))):0;
  return Math.hypot((p.x-a.x-t*dx)*SKETCH_WIDTH,(p.y-a.y-t*dy)*SKETCH_HEIGHT);
}
export function hitSketchStroke(stroke:SketchStroke,point:SketchPoint,radius=ERASER_RADIUS){
  const [a,b]=stroke.points;if(!a)return false;
  const threshold=radius+stroke.width*SKETCH_WIDTH/2;
  if(stroke.shape==='circle')return Math.abs(Math.hypot((point.x-a.x)*SKETCH_WIDTH,(point.y-a.y)*SKETCH_HEIGHT)-Math.hypot((b.x-a.x)*SKETCH_WIDTH,(b.y-a.y)*SKETCH_HEIGHT))<=threshold;
  if(stroke.shape==='rectangle'){
    const topRight={x:b.x,y:a.y},bottomLeft={x:a.x,y:b.y};
    return [[a,topRight],[topRight,b],[b,bottomLeft],[bottomLeft,a]].some(([from,to])=>segmentDistance(point,from,to)<=threshold);
  }
  if(stroke.shape==='line')return segmentDistance(point,a,b)<=threshold;
  if(stroke.points.length===1)return segmentDistance(point,a,a)<=threshold;
  return stroke.points.slice(1).some((to,i)=>segmentDistance(point,stroke.points[i],to)<=threshold);
}
export function hitSketchTrail(strokes:SketchStroke[],from:SketchPoint,to:SketchPoint,radius=ERASER_RADIUS){
  const distance=Math.hypot((to.x-from.x)*SKETCH_WIDTH,(to.y-from.y)*SKETCH_HEIGHT);
  const hits=new Set<string>();
  for(let step=0,steps=Math.max(1,Math.ceil(distance/radius));step<=steps;step++){
    const t=step/steps,point={x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t};
    for(const stroke of strokes)if(hitSketchStroke(stroke,point,radius))hits.add(stroke.id);
  }
  return hits;
}
