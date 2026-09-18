import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const execute=promisify(execFile);
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
