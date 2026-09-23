import {database as db} from './database.ts';
import {getDocument} from './library.ts';

export const MAX_SCENE_BYTES=1024*1024;
const MAX_ELEMENTS=2000;
const ELEMENT_TYPES=new Set(['rectangle','diamond','ellipse','arrow','line','freedraw','text']);

export type AnnotationScene={elements:Record<string,unknown>[];pageWidth:number;pageHeight:number};

function assertPage(page:number){
  if(!Number.isSafeInteger(page)||page<1||page>10000)throw new Error('页码无效');
}

async function assertPdf(owner:string,documentId:string){
  const document=await getDocument(owner,documentId);
  if(document.mime!=='application/pdf')throw new Error('仅 PDF 可以批注');
}

export function validateAnnotationScene(value:unknown):AnnotationScene{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('绘图场景格式无效');
  const scene=value as Record<string,unknown>;
  if(Object.keys(scene).some(key=>!['elements','pageWidth','pageHeight'].includes(key))||!Array.isArray(scene.elements)||scene.elements.length>MAX_ELEMENTS||typeof scene.pageWidth!=='number'||typeof scene.pageHeight!=='number'||!Number.isFinite(scene.pageWidth)||!Number.isFinite(scene.pageHeight)||scene.pageWidth<=0||scene.pageHeight<=0||scene.pageWidth>100000||scene.pageHeight>100000)throw new Error('绘图场景格式无效');
  const ids=new Set<string>();
  for(const item of scene.elements){
    if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('绘图元素格式无效');
    const element=item as Record<string,unknown>;
    if(typeof element.id!=='string'||!element.id||element.id.length>100||ids.has(element.id)||typeof element.type!=='string'||!ELEMENT_TYPES.has(element.type)||element.id==='pdf-background-image'||element.link!=null)throw new Error('绘图元素格式无效');
    ids.add(element.id);
    for(const key of ['x','y','width','height']){
      const coordinate=element[key];
      if(typeof coordinate!=='number'||!Number.isFinite(coordinate)||Math.abs(coordinate)>1_000_000)throw new Error('绘图坐标无效');
    }
  }
  const json=JSON.stringify(value);
  if(Buffer.byteLength(json)>MAX_SCENE_BYTES)throw new Error('绘图数据超出限制');
  return value as AnnotationScene;
}

export async function getPageAnnotationScene(owner:string,documentId:string,page:number){
  assertPage(page);
  await assertPdf(owner,documentId);
  const row=await db.prepare('SELECT revision,scene_json FROM library_annotation_scenes WHERE owner_id=? AND document_id=? AND page=?').bind(owner,documentId,page).first<{revision:number;scene_json:string}>();
  return {revision:row?.revision||0,scene:row?JSON.parse(row.scene_json) as AnnotationScene:{elements:[],pageWidth:0,pageHeight:0}};
}

export async function putPageAnnotationScene(owner:string,documentId:string,page:number,revision:number,scene:unknown){
  assertPage(page);
  if(!Number.isSafeInteger(revision)||revision<0)throw new Error('绘图版本无效');
  await assertPdf(owner,documentId);
  const json=JSON.stringify(validateAnnotationScene(scene)),now=new Date().toISOString();
  const result=revision===0
    ?await db.prepare('INSERT OR IGNORE INTO library_annotation_scenes (owner_id,document_id,page,revision,scene_json,updated_at) VALUES (?,?,?,1,?,?)').bind(owner,documentId,page,json,now).run()
    :await db.prepare('UPDATE library_annotation_scenes SET revision=revision+1,scene_json=?,updated_at=? WHERE owner_id=? AND document_id=? AND page=? AND revision=?').bind(json,now,owner,documentId,page,revision).run();
  if(!result.rowsAffected)return null;
  return {revision:revision+1};
}
