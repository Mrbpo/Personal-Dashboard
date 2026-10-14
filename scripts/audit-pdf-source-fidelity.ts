import {readFile,writeFile,realpath,lstat,stat} from 'node:fs/promises';
import {resolve,dirname,basename,join} from 'node:path';
import {auditPdfSourceFidelity,stagePdfSourceFidelity,type PdfSourceMathEvidence} from '../lib/pdf-source-fidelity.ts';
const args=process.argv.slice(2);
const value=(name:string)=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
const original=value('--original'),evidence=value('--evidence'),text=value('--text'),report=value('--report');
if(!original||!evidence||!text||!report||args.includes('--apply'))throw new Error('Audit only: --original PDF --evidence JSON --text UTF8 --report JSON; no apply');
const staging=value('--stage'),inputs=[original,evidence,text],outputs=[report,...(staging?[staging]:[])];
const canonical=(path:string)=>process.platform==='win32'?path.toLowerCase():path;
const inputPaths=await Promise.all(inputs.map(async path=>canonical(await realpath(path))));
const inputStats=await Promise.all(inputs.map(path=>stat(path)));
const outputPaths:string[]=[];
for(const output of outputs){
 const absolute=resolve(output),target=canonical(join(await realpath(dirname(absolute)),basename(absolute)));
 if(inputPaths.includes(target)||outputPaths.includes(target))throw new Error('Output aliases an input or another output');
 outputPaths.push(target);
 let exists=false;
 try{
  await lstat(absolute);exists=true;
  const identity=await stat(absolute);
  if(inputStats.some(input=>input.dev===identity.dev&&input.ino===identity.ino))throw new Error('Output aliases an input inode');
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 if(exists)throw new Error('Output must be a new file; existing files and cache entries cannot be overwritten');
}
const bytes=await readFile(original),proof=JSON.parse(await readFile(evidence,'utf8')) as PdfSourceMathEvidence,raw=await readFile(text,'utf8');
const result=await auditPdfSourceFidelity(bytes,proof,raw);
const derived=staging?await stagePdfSourceFidelity(bytes,proof,raw):null;
await writeFile(report,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
if(staging)await writeFile(staging,JSON.stringify(derived,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({mode:result.mode,page:result.pageNumber,requiresReview:result.requiresReview,sourceSha256:result.sourceSha256}));
