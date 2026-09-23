import {database as db} from './database.ts';
import {getDocument} from './library.ts';

export type AnnotationPoint={x:number;y:number};
export type AnnotationStroke={id:string;color:string;width:number;points:AnnotationPoint[]};

const MAX_STROKES=1000;
const MAX_POINTS=30000;
export const MAX_ANNOTATION_BYTES=512*1024;

function assertPage(page:number){
  if(!Number.isSafeInteger(page)||page<1||page>10000)throw new Error('页码无效');
}

async function assertPdf(owner:string,documentId:string){
  const document=await getDocument(owner,documentId);
  if(document.mime!=='application/pdf')throw new Error('仅 PDF 可以批注');
}

export function validateStrokes(value:unknown):AnnotationStroke[]{
  if(!Array.isArray(value)||value.length>MAX_STROKES)throw new Error('批注数量超出限制');
  let pointCount=0;
  for(const stroke of value){
    if(!stroke||typeof stroke!=='object'||typeof stroke.id!=='string'||stroke.id.length>100||!stroke.id||typeof stroke.color!=='string'||!/^#[0-9a-fA-F]{6}$/.test(stroke.color)||typeof stroke.width!=='number'||!Number.isFinite(stroke.width)||stroke.width<0.001||stroke.width>0.03||!Array.isArray(stroke.points)||!stroke.points.length||stroke.points.length>3000)throw new Error('批注格式无效');
    pointCount+=stroke.points.length;
    if(pointCount>MAX_POINTS||stroke.points.some((point:unknown)=>!point||typeof point!=='object'||typeof (point as AnnotationPoint).x!=='number'||typeof (point as AnnotationPoint).y!=='number'||!Number.isFinite((point as AnnotationPoint).x)||!Number.isFinite((point as AnnotationPoint).y)||(point as AnnotationPoint).x<0||(point as AnnotationPoint).x>1||(point as AnnotationPoint).y<0||(point as AnnotationPoint).y>1))throw new Error('批注坐标无效');
  }
  const json=JSON.stringify(value);
  if(Buffer.byteLength(json)>MAX_ANNOTATION_BYTES)throw new Error('批注数据超出限制');
  return value as AnnotationStroke[];
}

export async function getPageAnnotations(owner:string,documentId:string,page:number){
  assertPage(page);
  await assertPdf(owner,documentId);
  const row=await db.prepare('SELECT revision,strokes_json FROM library_annotations WHERE owner_id=? AND document_id=? AND page=?').bind(owner,documentId,page).first<{revision:number;strokes_json:string}>();
  return {revision:row?.revision||0,strokes:row?JSON.parse(row.strokes_json) as AnnotationStroke[]:[]};
}

export async function putPageAnnotations(owner:string,documentId:string,page:number,revision:number,strokes:unknown){
  assertPage(page);
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('批注版本无效');
  await assertPdf(owner,documentId);
  const valid=validateStrokes(strokes),json=JSON.stringify(valid),now=new Date().toISOString();
  const result=revision===0
    ?await db.prepare('INSERT OR IGNORE INTO library_annotations (owner_id,document_id,page,revision,strokes_json,updated_at) VALUES (?,?,?,1,?,?)').bind(owner,documentId,page,json,now).run()
    :await db.prepare('UPDATE library_annotations SET revision=revision+1,strokes_json=?,updated_at=? WHERE owner_id=? AND document_id=? AND page=? AND revision=?').bind(json,now,owner,documentId,page,revision).run();
  if(!result.rowsAffected)return null;
  return {revision:revision+1};
}
