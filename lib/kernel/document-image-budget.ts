import type {DocumentContextSource} from './document-context.ts';

export const DOCUMENT_IMAGE_LIMITS:Readonly<{images:number;bytes:number;imageInputTokens:number}>=Object.freeze({images:64,bytes:32*1024*1024,imageInputTokens:65536});
type Image={attachmentId:string;source:DocumentContextSource;sha256:string;byteLength:number;width:number;height:number;
 kind?:'pdf-page'|'pdf-region';physicalPage?:number;anchorEvidenceId?:string;captionEvidenceId?:string;manifestSha256?:string;originalReference?:string};
type Selection={anchorRank:number;attachmentId:string;source:DocumentContextSource;sha256:string;byteLength:number;width:number;height:number;
 anchorEvidenceId:string;kind:'pdf-page'|'pdf-region'|'author-image';physicalPage?:number;manifestSha256?:string;originalReference?:string;imageInputTokenUpper:number};
export type DocumentImageSelection={policy:'ranked-global-images-v1';limits:typeof DOCUMENT_IMAGE_LIMITS;
 included:Selection[];omitted:Array<Selection&{reason:'image-count-limit'|'image-byte-limit'|'image-input-limit'}>;
 accounting:{images:number;bytes:number;imageInputTokens:number}};

/** Only verified real assets enter this budget. A rejected asset is still
 * verified by its reader; an IO/source error is never a budget omission. */
export function createDocumentImageBudget(limits:typeof DOCUMENT_IMAGE_LIMITS=DOCUMENT_IMAGE_LIMITS){
 limits={...limits};
 if(Object.keys(limits).length!==3||Object.entries(DOCUMENT_IMAGE_LIMITS).some(([key,max])=>{
  const value=limits[key as keyof typeof limits];return !Number.isSafeInteger(value)||value<1||value>max;
 }))throw new Error('Invalid ranked image budget');
 const included:Selection[]=[],omitted:DocumentImageSelection['omitted']=[],seen=new Map<string,{included:boolean;identity:string}>();
 const accounting={images:0,bytes:0,imageInputTokens:0};
 return {
  include(image:Image,anchorRank:number){
   if(!Number.isSafeInteger(anchorRank)||anchorRank<1||!image.attachmentId||!image.source.documentId||
    !image.source.currentVersionId||!image.source.sourceVersionId||!image.source.sourceHash||
    ![image.width,image.height,image.byteLength].every(value=>Number.isSafeInteger(value)&&value>0))
    throw new Error('Invalid verified image selection');
   const item:Selection={anchorRank,attachmentId:image.attachmentId,source:{...image.source},sha256:image.sha256,
    byteLength:image.byteLength,width:image.width,height:image.height,
    anchorEvidenceId:image.anchorEvidenceId??image.captionEvidenceId??'',kind:image.kind??'author-image',
    ...(image.physicalPage!==undefined?{physicalPage:image.physicalPage}:{}),
    ...(image.manifestSha256?{manifestSha256:image.manifestSha256}:{}),...(image.originalReference?{originalReference:image.originalReference}:{}),
    imageInputTokenUpper:2*Math.ceil(image.width/32)*Math.ceil(image.height/32)+1};
   if(!item.anchorEvidenceId)throw new Error('Image selection has no source anchor');
   const identity=JSON.stringify({...image,bytes:undefined,source:{...image.source,courseId:image.source.courseId??''}},(_key,value)=>
    value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value),
    previous=seen.get(image.attachmentId);
   if(previous){if(previous.identity!==identity)throw new Error('Conflicting duplicate image identity');return previous.included;}
   const reason=accounting.images+1>limits.images?'image-count-limit':accounting.bytes+item.byteLength>limits.bytes?
    'image-byte-limit':accounting.imageInputTokens+item.imageInputTokenUpper>limits.imageInputTokens?'image-input-limit':null;
   seen.set(image.attachmentId,{included:!reason,identity});
   if(reason){omitted.push({...item,reason});return false;}
   included.push(item);accounting.images++;accounting.bytes+=item.byteLength;accounting.imageInputTokens+=item.imageInputTokenUpper;return true;
  },
  snapshot():DocumentImageSelection{return {policy:'ranked-global-images-v1',limits:{...limits},
   included:structuredClone(included),omitted:structuredClone(omitted),accounting:{...accounting}};}
 };
}
export type DocumentImageBudget=ReturnType<typeof createDocumentImageBudget>;
