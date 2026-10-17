import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
const execute=promisify(execFile);
export const PDF_PAGE_IMAGE_MAX_EDGE=2500;
type OcrImage={sha256:string;width:number;height:number};
export type LocalImageOcrObservation={status:'available';image:OcrImage;tsv:string;tsvSha256:string;engine:'tesseract';language:'eng+chi_sim'}|
 {status:'unavailable';image:OcrImage|null;reason:string};
/** Reuse the already rendered full-page PNG. Raw observations are never corrected or treated as source truth. */
export async function localImageOcrTsv(bytes:Uint8Array|null):Promise<LocalImageOcrObservation>{
 const png=bytes?Buffer.from(bytes):null,sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
 const image=png&&png.length>=24&&png.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?
  {sha256:sha(png),width:png.readUInt32BE(16),height:png.readUInt32BE(20)}:null;
 const unavailable=(reason:string):LocalImageOcrObservation=>({status:'unavailable',image,reason});
 if(process.env.LOCAL_OCR!=='true')return unavailable('local-ocr-disabled');
 if(!image||image.width<1||image.height<1||Math.max(image.width,image.height)>PDF_PAGE_IMAGE_MAX_EDGE)return unavailable('full-page-png-unavailable');
 const directory=await mkdtemp(join(tmpdir(),'study-image-tsv-'));
 try{
  const input=join(directory,'page.png');await writeFile(input,png!,{mode:0o600});
  const {stdout}=await execute('tesseract',[input,'stdout','-l','eng+chi_sim','tsv'],{timeout:45000,maxBuffer:256*1024});
  if(!stdout.startsWith('level\tpage_num\t')||Buffer.byteLength(stdout)>256*1024)return unavailable('invalid-or-oversize-tsv');
  return {status:'available',image,tsv:stdout,tsvSha256:sha(stdout),engine:'tesseract',language:'eng+chi_sim'};
 }catch{return unavailable('tesseract-unavailable');}finally{await rm(directory,{recursive:true,force:true});}
}
export async function localPdfPageImage(bytes:Uint8Array):Promise<Buffer|null>{
 if(process.env.LOCAL_OCR!=='true')return null;
 const directory=await mkdtemp(join(tmpdir(),'study-pdf-image-'));
 try{
  await writeFile(join(directory,'page.pdf'),bytes,{mode:0o600});
  await execute('pdftoppm',['-f','1','-singlefile','-scale-to',String(PDF_PAGE_IMAGE_MAX_EDGE),'-png',join(directory,'page.pdf'),join(directory,'page')],{timeout:45000,maxBuffer:1024*1024});
  return await readFile(join(directory,'page.png'));
 }catch{return null;}finally{await rm(directory,{recursive:true,force:true});}
}
export async function localPdfTextPages(bytes:Uint8Array):Promise<string[]|null>{
 if(process.env.LOCAL_OCR!=='true')return null;
 const directory=await mkdtemp(join(tmpdir(),'study-pdf-text-'));
 try{
  const input=join(directory,'document.pdf');await writeFile(input,bytes,{mode:0o600});
  const {stdout}=await execute('pdftotext',['-layout','-enc','UTF-8',input,'-'],{timeout:30000,maxBuffer:32*1024*1024});
  const pages=stdout.split('\f');if(!pages.at(-1)?.trim())pages.pop();
  return pages.map(page=>page.trim());
 }catch{return null;}finally{await rm(directory,{recursive:true,force:true});}
}
// Prefer the embedded PDF text layer. It is faster, cheaper and usually more
// accurate than OCR; scanned pages fall through to Tesseract below.
export async function localPdfPageText(bytes:Uint8Array):Promise<string|null>{
 if(process.env.LOCAL_OCR!=='true')return null;
 const directory=await mkdtemp(join(tmpdir(),'study-pdf-text-'));
 try{
  const input=join(directory,'page.pdf');await writeFile(input,bytes,{mode:0o600});
  const {stdout}=await execute('pdftotext',['-f','1','-l','1','-layout','-nopgbrk','-enc','UTF-8',input,'-'],{timeout:30000,maxBuffer:8*1024*1024});
  const text=stdout.replace(/\f/g,'').trim();
  return (text.match(/[\p{L}\p{N}]/gu)?.length||0)>=6?text:null;
 }catch{return null;}finally{await rm(directory,{recursive:true,force:true});}
}
// Fixed binaries and arguments, never an uploaded filename or shell command.
export async function localPageOcr(bytes:Uint8Array):Promise<string|null>{
 if(process.env.LOCAL_OCR!=='true')return null;
 const directory=await mkdtemp(join(tmpdir(),'study-ocr-'));
 try{
  await writeFile(join(directory,'page.pdf'),bytes,{mode:0o600});
  await execute('pdftoppm',['-f','1','-singlefile','-scale-to','2200','-png',join(directory,'page.pdf'),join(directory,'page')],{timeout:45000,maxBuffer:1024*1024});
  const {stdout}=await execute('tesseract',[join(directory,'page.png'),'stdout','-l','eng+chi_sim'],{timeout:45000,maxBuffer:4*1024*1024});
  if(stdout.trim().length<30)return null;
  return '[本地 OCR 文字索引：公式、表格及图形可能识别不完整，涉及这些内容请核对原始 PDF 页。]\n'+stdout.trim();
 }catch{return null;}finally{await rm(directory,{recursive:true,force:true});}
}
