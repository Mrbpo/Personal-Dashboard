import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PDFDocument,PDFName,PDFNumber} from 'pdf-lib';

export const PDF_NATIVE_HINT_POLICY='poppler-text-runs-v1';
export const PDF_NATIVE_HINT_MAX_BYTES=64*1024;
const XML_MAX_BYTES=256*1024;
const execute=(file:string,args:string[],options:{timeout:number;maxBuffer:number;encoding?:'utf8'})=>
 new Promise<{stdout:string;stderr:string}>((resolve,reject)=>execFile(file,args,{...options,encoding:'utf8'},(error,stdout,stderr)=>{
  if(error)reject(error);else resolve({stdout,stderr});
 }));
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export const nativeHintCanonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
 ?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
type Box={x:number;y:number;width:number;height:number};
type Frame={mediaBox:Box;cropBox:Box;rotationDegrees:number;userUnit:number};
type Binding={sourcePdfSha256:string;physicalPage:number;png:{sha256:string;width:number;height:number};frame:Frame|null};
type Font={id:string;reportedFullName:string;reportedSize:number;color:string|null;sourceFontFile:null};
type Run={text:string;box:{left:number;top:number;width:number;height:number};fontId:string;
 observedSpans:Array<{text:string;boldTagObserved:boolean;italicTagObserved:boolean}>};
export type PdfNativeHintSidecar={policy:typeof PDF_NATIVE_HINT_POLICY;binding:Binding;
 producer:{name:'pdftohtml';version:string|null;argumentsPolicy:'xml-noroundcoord-fontfullname-zoom1-i-nomerge-physical-page-v1'};
 granularity:'text-run';status:'available'|'unavailable';reason?:string;xmlSha256?:string;
 coordinateSystem?:{origin:'top-left';unit:'point-at-zoom-1';width:number;height:number;pngScaleX:number;pngScaleY:number};
 fonts?:Font[];runs?:Run[]};
export type PdfNativeHints={sidecar:PdfNativeHintSidecar;sidecarSha256:string};
function packet(sidecar:PdfNativeHintSidecar):PdfNativeHints{
 if(Buffer.byteLength(nativeHintCanonical(sidecar))>PDF_NATIVE_HINT_MAX_BYTES){
  // No truncated text or partial font/geometry set is presented as a complete sidecar.
  const {fonts:_,runs:__,coordinateSystem:___,...identity}=sidecar;
  sidecar={...identity,status:'unavailable',reason:'sidecar-byte-limit'};
 }
 return {sidecar,sidecarSha256:sha(nativeHintCanonical(sidecar))};
}
type Element={name:string;attributes:Record<string,string>;children:Array<Element|string>};
function xmlText(value:string):string{
 const decoded=value.replace(/&([^;]+);/g,(_entity,name:string)=>{
  const known:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};
  if(Object.hasOwn(known,name))return known[name];
  const number=/^#x[\da-f]+$/i.test(name)?parseInt(name.slice(2),16):/^#\d+$/.test(name)?Number(name.slice(1)):NaN;
  if(!Number.isInteger(number)||!(number===9||number===10||number===13||number>=32&&number<=0xd7ff||number>=0xe000&&number<=0xfffd||number>=0x10000&&number<=0x10ffff))
   throw new Error('unsupported-xml-entity');
  return String.fromCodePoint(number);
 });
 if(/&(?!(?:[^&]*;))/.test(value)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(decoded))throw new Error('invalid-xml-text');
 return decoded;
}
/** Closed Poppler XML grammar, no DOM/DTD/entity/network loader or HTML execution. */
function parseXml(xml:string):Element{
 if(Buffer.byteLength(xml)>XML_MAX_BYTES)throw new Error('xml-byte-limit');
 xml=xml.replace(/^\uFEFF?\s*<\?xml version="1\.0" encoding="UTF-8"\?>\s*/,'')
  .replace(/^\s*<!DOCTYPE pdf2xml SYSTEM "pdf2xml\.dtd">\s*/,'');
 if(/<!|<\?|\]\]>/.test(xml))throw new Error('unsupported-xml-declaration');
 const root:Element={name:'root',attributes:{},children:[]},stack=[root];
 let cursor=0,nodes=0;
 while(cursor<xml.length){
  if(xml[cursor]!=='<'){
   const end=xml.indexOf('<',cursor),next=end<0?xml.length:end,text=xmlText(xml.slice(cursor,next));
   if(text.trim()||stack.at(-1)!.name==='text'||['b','i'].includes(stack.at(-1)!.name))stack.at(-1)!.children.push(text);
   cursor=next;continue;
  }
  const token=xml.slice(cursor).match(/^<(\/?)([a-z][a-z\d]*)([^<>]*?)\s*(\/?)>/i);
  if(!token||++nodes>12000)throw new Error('unsupported-xml-element');
  cursor+=token[0].length;const [,closing,name,tail,selfClosing]=token;
  if(!['pdf2xml','page','fontspec','text','b','i'].includes(name))throw new Error('unsupported-xml-element');
  if(closing){if(tail.trim()||selfClosing||stack.length===1||stack.at(-1)!.name!==name)throw new Error('invalid-xml-nesting');stack.pop();continue;}
  const attributes:Record<string,string>={};let remaining=tail;
  while(remaining.trim()){
   const attribute=remaining.match(/^\s+([a-z][a-z\d_-]*)="([^"<>]*)"/i);
   if(!attribute||Object.hasOwn(attributes,attribute[1]))throw new Error('invalid-xml-attribute');
   attributes[attribute[1]]=xmlText(attribute[2]);remaining=remaining.slice(attribute[0].length);
  }
  const element:Element={name,attributes,children:[]};stack.at(-1)!.children.push(element);if(!selfClosing)stack.push(element);
 }
 if(stack.length!==1||root.children.length!==1||typeof root.children[0]==='string'||root.children[0].name!=='pdf2xml')throw new Error('invalid-xml-root');
 return root.children[0];
}
function number(value:string|undefined){
 if(value===undefined||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)||!Number.isFinite(Number(value))||Math.abs(Number(value))>1e7)throw new Error('invalid-xml-number');
 return Number(value);
}
function decode(xml:string,binding:Binding,version:string):PdfNativeHints{
 const base:PdfNativeHintSidecar={policy:PDF_NATIVE_HINT_POLICY,binding,producer:{name:'pdftohtml',version,
  argumentsPolicy:'xml-noroundcoord-fontfullname-zoom1-i-nomerge-physical-page-v1'},granularity:'text-run',status:'available',xmlSha256:sha(xml)};
 try{
  const root=parseXml(xml),children=root.children;
  if(root.attributes.producer!=='poppler'||root.attributes.version!==version||children.length!==1||typeof children[0]==='string'||children[0].name!=='page')throw new Error('producer-or-page-mismatch');
  const page=children[0],a=page.attributes,frame=binding.frame!;
  if(number(a.number)!==binding.physicalPage||number(a.left)!==0||number(a.top)!==0||
   Math.abs(number(a.width)-frame.mediaBox.width)>.01||Math.abs(number(a.height)-frame.mediaBox.height)>.01)throw new Error('page-frame-mismatch');
  const fonts:Font[]=[],mapping=new Map<string,string>(),runs:Run[]=[];
  for(const element of page.children){
   if(typeof element==='string')throw new Error('unsupported-page-text');
   if(element.name!=='fontspec')continue;
   const font=element.attributes;
   if(!font.id||mapping.has(font.id)||!font.family?.trim())throw new Error('unknown-font');
   const id=`f${fonts.length}`;mapping.set(font.id,id);
   if(element.children.length)throw new Error('unsupported-font-content');
   const size=number(font.size);if(size<=0)throw new Error('unknown-font');
   fonts.push({id,reportedFullName:font.family,reportedSize:size,color:font.color||null,sourceFontFile:null});
  }
  for(const element of page.children){
   if(typeof element==='string')throw new Error('unsupported-page-text');
   if(element.name==='fontspec')continue;
   if(element.name!=='text')throw new Error('unsupported-page-element');
   const fontId=mapping.get(element.attributes.font);if(!fontId)throw new Error('unknown-font');
   const spans:Run['observedSpans']=[];
   const visit=(node:Element|string,bold=false,italic=false):void=>{
    if(typeof node==='string'){if(node)spans.push({text:node,boldTagObserved:bold,italicTagObserved:italic});return;}
    if(!['text','b','i'].includes(node.name)||(node.name!=='text'&&Object.keys(node.attributes).length))throw new Error('unsupported-text-markup');
    for(const child of node.children)visit(child,bold||node.name==='b',italic||node.name==='i');
   };
   visit(element);const text=spans.map(span=>span.text).join('');
   const attrs=element.attributes,box={left:number(attrs.left),top:number(attrs.top),width:number(attrs.width),height:number(attrs.height)};
   if(box.width<0||box.height<0)throw new Error('invalid-run-box');
   runs.push({text,box,fontId,observedSpans:spans});
  }
  if(!runs.some(run=>run.text.trim()))throw new Error('no-native-text');
  return packet({...base,coordinateSystem:{origin:'top-left',unit:'point-at-zoom-1',width:frame.mediaBox.width,height:frame.mediaBox.height,
   pngScaleX:binding.png.width/frame.mediaBox.width,pngScaleY:binding.png.height/frame.mediaBox.height},fonts,runs});
 }catch(error){return packet({...base,status:'unavailable',reason:(error as Error).message});}
}
/** Pure fixture seam; the production collector supplies verified original PDF/page/PNG binding. */
export function decodePdfNativeHintXml(xml:string,binding:Binding,version:string){return decode(xml,binding,version);}
function pngIdentity(bytes:Uint8Array):Binding['png']{
 const buffer=Buffer.from(bytes);
 if(buffer.length<24||buffer.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||buffer.subarray(12,16).toString()!=='IHDR')throw new Error('Native PDF hints require the actual page PNG');
 const width=buffer.readUInt32BE(16),height=buffer.readUInt32BE(20);
 if(!width||!height||Math.max(width,height)>2500)throw new Error('Native PDF hint PNG dimensions invalid');
 return {sha256:sha(bytes),width,height};
}
/** One original PDF is loaded once per transcription, not once per text-run/page. */
export async function preparePdfNativeHintSource(bytes:Uint8Array,expectedSourceHash:string){
 bytes=Buffer.from(bytes);const sourcePdfSha256=sha(bytes);
 if(sourcePdfSha256!==expectedSourceHash)throw new Error('Native PDF hint source checksum mismatch');
 const pdf=await PDFDocument.load(bytes,{updateMetadata:false});
 return async(physicalPage:number,png:Uint8Array):Promise<PdfNativeHints>=>{
  if(!Number.isInteger(physicalPage)||physicalPage<1||physicalPage>pdf.getPageCount())throw new Error('Native PDF hint physical page invalid');
  const page=pdf.getPage(physicalPage-1),unit=page.node.get(PDFName.of('UserUnit'));
  const frame:Frame={mediaBox:page.getMediaBox(),cropBox:page.getCropBox(),rotationDegrees:page.getRotation().angle,
   userUnit:unit===undefined?1:unit instanceof PDFNumber?unit.asNumber():NaN};
  const binding:Binding={sourcePdfSha256,physicalPage,png:pngIdentity(png),frame:Number.isFinite(frame.userUnit)?frame:null};
  const unavailable=(reason:string,version:string|null=null)=>packet({policy:PDF_NATIVE_HINT_POLICY,binding,
   producer:{name:'pdftohtml',version,argumentsPolicy:'xml-noroundcoord-fontfullname-zoom1-i-nomerge-physical-page-v1'},granularity:'text-run',status:'unavailable',reason});
  // First version intentionally does not invent crop/rotation/UserUnit transforms.
  if(frame.rotationDegrees!==0||frame.userUnit!==1||frame.mediaBox.x!==0||frame.mediaBox.y!==0||
   nativeHintCanonical(frame.mediaBox)!==nativeHintCanonical(frame.cropBox)||frame.mediaBox.width<=0||frame.mediaBox.height<=0)
   return unavailable('unsupported-page-frame');
  if(Math.abs(binding.png.width-binding.png.height*frame.mediaBox.width/frame.mediaBox.height)>1.1)return unavailable('png-page-frame-mismatch');
  if(process.env.LOCAL_OCR!=='true')return unavailable('local-poppler-disabled');
  let directory:string|undefined,version:string|null=null;
  try{
   const probe=await execute('pdftohtml',['-v'],{timeout:5000,maxBuffer:8192});
   version=(probe.stderr+'\n'+probe.stdout).match(/pdftohtml version (\d+\.\d+\.\d+)/)?.[1]??null;
   if(!version)return unavailable('unknown-producer-version');
   directory=await mkdtemp(join(tmpdir(),'study-native-hints-'));const input=join(directory,'source.pdf');
   await writeFile(input,bytes,{mode:0o600});
   const result=await execute('pdftohtml',['-xml','-noroundcoord','-fontfullname','-zoom','1','-i','-stdout','-nomerge',
    '-f',String(physicalPage),'-l',String(physicalPage),input],{timeout:30000,maxBuffer:XML_MAX_BYTES,encoding:'utf8'});
   if(result.stderr.trim())return unavailable('poppler-warning',version);
   return decode(result.stdout,binding,version);
  }catch(error){return unavailable((error as NodeJS.ErrnoException).code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER'?'xml-byte-limit':'poppler-unavailable',version);}
  finally{if(directory)await rm(directory,{recursive:true,force:true});}
 };
}

