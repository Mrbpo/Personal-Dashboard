// Local, bounded PDF.js observation worker. Never renders, infers a graph, or loads remote resources.
import {parentPort,workerData} from 'node:worker_threads';
import {createHash} from 'node:crypto';
globalThis.fetch=async()=>{throw Error('Remote resources disabled');};
const sha=v=>createHash('sha256').update(v).digest('hex');
let loading,producerVersion=null;
try{
 const {getDocument,OPS,AnnotationMode,version}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 producerVersion=version;
 if(version!=='6.3.289')throw Error('producer-version-mismatch');
 loading=getDocument({data:workerData.pdf,isEvalSupported:false,useSystemFonts:false,disableFontFace:true,
  disableAutoFetch:true,useWorkerFetch:false,stopAtErrors:true,verbosity:0});
 const document=await loading.promise,page=await document.getPage(workerData.physicalPage),viewport=page.getViewport({scale:1});
 const text=await page.getTextContent({disableNormalization:true}),list=await page.getOperatorList({annotationMode:AnnotationMode.ENABLE});
 if(text.items.length>workerData.limits.textItems||list.fnArray.length>workerData.limits.operations)throw Error('item-or-operation-limit');
 const names=new Map(Object.entries(OPS).map(([name,id])=>[id,name]));let values=0,rasterPayloadsOmitted=0;
 const copy=(value,depth=0,key='')=>{
  if(++values>200000||depth>16)throw Error('argument-limit');
  if(value===null||typeof value==='boolean')return value;
  if(typeof value==='number'){if(!Number.isFinite(value))throw Error('nonfinite-argument');return value;}
  if(typeof value==='string'){if(value.length>65536)throw Error('string-limit');return value;}
  if(value===undefined)return {unavailable:'undefined-operand'};
  if(value instanceof ArrayBuffer){
   if(key!=='data')throw Error('unsupported-operand');
   rasterPayloadsOmitted++;return {rasterBytesOmitted:true,type:'ArrayBuffer',byteLength:value.byteLength,sha256:sha(new Uint8Array(value))};
  }
  if(ArrayBuffer.isView(value)){
   if(key==='data'){
    rasterPayloadsOmitted++;return {rasterBytesOmitted:true,type:value.constructor.name,byteLength:value.byteLength,
     sha256:sha(new Uint8Array(value.buffer,value.byteOffset,value.byteLength))};
   }
   return Array.from(value,x=>copy(x,depth+1));
  }
  if(Array.isArray(value))return value.map(x=>copy(x,depth+1));
  if(typeof value==='object'){
   const entries=Object.entries(value);
   if(!entries.length&&![null,Object.prototype].includes(Object.getPrototypeOf(value)))throw Error('unsupported-operand');
   return Object.fromEntries(entries.map(([k,v])=>[k,copy(v,depth+1,k)]));
  }
  throw Error('unsupported-operand');
 };
 const operations=list.fnArray.map((id,index)=>{
  const name=names.get(id);if(!name)throw Error('unknown-operator');
  return {index,name,args:copy(list.argsArray[index])};
 });
 const body={producer:{name:'pdfjs-dist',version},physicalPage:workerData.physicalPage,
  frame:{view:page.view,rotation:page.rotate,userUnit:page.userUnit,
   viewport:{width:viewport.width,height:viewport.height,transform:viewport.transform}},
  text:{items:copy(text.items),styles:copy(text.styles),normalization:'disabled'},operations,
  counts:{textItems:text.items.length,operations:operations.length,
   constructPathOperations:operations.filter(o=>o.name==='constructPath').length,
   clipOperations:operations.filter(o=>o.name==='clip'||o.name==='eoClip').length,
   rasterPaintOperations:operations.filter(o=>/^paint.*Image/.test(o.name)).length,rasterPayloadsOmitted}};
 const serialized=JSON.stringify(body);
 if(Buffer.byteLength(serialized)>workerData.limits.bytes)throw Error('observation-byte-limit');
 parentPort.postMessage({status:'available',body});
}catch(error){
 const known=['producer-version-mismatch','item-or-operation-limit','argument-limit','nonfinite-argument','string-limit','unsupported-operand','unknown-operator','observation-byte-limit'];
 parentPort.postMessage({status:'unavailable',reason:known.includes(error.message)?error.message:'pdfjs-extraction-failed',producer:{name:'pdfjs-dist',version:producerVersion}});
}finally{await loading?.destroy().catch(()=>{});}
