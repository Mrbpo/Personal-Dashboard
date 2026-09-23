import type {ReactNode} from 'react';
import type {AnnotationScene} from '@/lib/pdf-annotation-scenes';

type Element=Record<string,unknown>;

const number=(value:unknown,fallback=0)=>typeof value==='number'&&Number.isFinite(value)?value:fallback;
const color=(value:unknown,fallback='#1e1e1e')=>typeof value==='string'&&(/^(#[0-9a-fA-F]{3,8}|transparent)$/.test(value))?value:fallback;

function draw(element:Element,index:number):ReactNode{
  const type=element.type,x=number(element.x),y=number(element.y),w=number(element.width),h=number(element.height);
  const stroke=color(element.strokeColor),fill=color(element.backgroundColor,'transparent'),strokeWidth=number(element.strokeWidth,2),opacity=number(element.opacity,100)/100;
  const angle=number(element.angle)*180/Math.PI;
  const transform=angle?`rotate(${angle} ${x+w/2} ${y+h/2})`:undefined;
  const common={stroke,strokeWidth,opacity,transform,strokeLinecap:'round' as const,strokeLinejoin:'round' as const};
  if(type==='rectangle')return <rect key={String(element.id||index)} x={x} y={y} width={w} height={h} fill={fill} {...common}/>;
  if(type==='ellipse')return <ellipse key={String(element.id||index)} cx={x+w/2} cy={y+h/2} rx={Math.abs(w/2)} ry={Math.abs(h/2)} fill={fill} {...common}/>;
  if(type==='diamond')return <polygon key={String(element.id||index)} points={`${x+w/2},${y} ${x+w},${y+h/2} ${x+w/2},${y+h} ${x},${y+h/2}`} fill={fill} {...common}/>;
  if(type==='line'||type==='arrow'||type==='freedraw'){
    const raw=Array.isArray(element.points)?element.points:[];
    const points=raw.filter((point):point is [number,number]=>Array.isArray(point)&&point.length>=2&&Number.isFinite(point[0])&&Number.isFinite(point[1])).map(point=>`${x+point[0]},${y+point[1]}`).join(' ');
    if(!points)return null;
    return <polyline key={String(element.id||index)} points={points} fill="none" markerEnd={type==='arrow'?'url(#pdf-scene-arrow)':undefined} {...common}/>;
  }
  if(type==='text'&&typeof element.text==='string')return <text key={String(element.id||index)} x={x} y={y} fill={stroke} stroke="none" fontSize={number(element.fontSize,20)} opacity={opacity} transform={transform} dominantBaseline="hanging">{element.text.split('\n').map((line,i)=><tspan key={i} x={x} dy={i?'1.2em':0}>{line}</tspan>)}</text>;
  return null;
}

export function PdfExcalidrawSceneOverlay({scene,rotation,width,height}:{scene:AnnotationScene|null;rotation:number;width:number;height:number}){
  if(!scene||scene.pageWidth<=0||scene.pageHeight<=0||!scene.elements.length||width<=0||height<=0)return null;
  const w=scene.pageWidth,h=scene.pageHeight;
  const transform=rotation===90?`translate(${h} 0) rotate(90)`:rotation===180?`translate(${w} ${h}) rotate(180)`:rotation===270?`translate(0 ${w}) rotate(270)`:undefined;
  return <svg aria-label="PDF 扩展绘图" className="pointer-events-none absolute inset-0 z-10" width={width} height={height} viewBox={`0 0 ${rotation%180?h:w} ${rotation%180?w:h}`} preserveAspectRatio="none">
    <defs><marker id="pdf-scene-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10" fill="none" stroke="context-stroke" strokeWidth="2"/></marker></defs>
    <g transform={transform}>{scene.elements.map(draw)}</g>
  </svg>;
}
