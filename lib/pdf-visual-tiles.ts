export const VISUAL_CROP_VIEWS=[
 {label:'左上',left:0,bottom:.45,width:.55,height:.55},
 {label:'右上',left:.45,bottom:.45,width:.55,height:.55},
 {label:'左下',left:0,bottom:0,width:.55,height:.55},
 {label:'右下',left:.45,bottom:0,width:.55,height:.55},
] as const;

type Box={x:number;y:number;width:number;height:number};
type VisualRegion={left:number;bottom:number;width:number;height:number};

export function visualTileRotation(angle:number):0|90|180|270{
 if(!Number.isInteger(angle)||angle%90!==0)
  throw new Error('四图 PNG 视觉转写仅支持 0/90/180/270 度旋转；原件和已有转写保留');
 return ((angle%360+360)%360) as 0|90|180|270;
}

// Regions are fractions of the displayed CropBox, with a bottom-left origin.
// PDF /Rotate is clockwise; invert it into unrotated user space, retaining
// the source page's /Rotate and content streams on the derived view.
export function visualTileCropBox(box:Box,angle:number,region:VisualRegion):Box{
 const rotation=visualTileRotation(angle);
 if(!Object.values(box).every(Number.isFinite)||box.width<=0||box.height<=0)
  throw new Error('四图 PNG 视觉转写 CropBox 无效；原件和已有转写保留');
 const {left:u,bottom:v,width:w,height:h}=region;
 if(![u,v,w,h].every(Number.isFinite)||u<0||v<0||w<=0||h<=0||u+w>1||v+h>1)
  throw new Error('四图 PNG 视觉转写区域无效');
 let left:number,bottom:number,width:number,height:number;
 switch(rotation){
  case 0: left=u;bottom=v;width=w;height=h;break;
  case 90: left=1-(v+h);bottom=u;width=h;height=w;break;
  case 180: left=1-(u+w);bottom=1-(v+h);width=w;height=h;break;
  case 270: left=v;bottom=1-(u+w);width=h;height=w;break;
 }
 return {x:box.x+box.width*left,y:box.y+box.height*bottom,width:box.width*width,height:box.height*height};
}
