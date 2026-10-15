import {createHash} from 'node:crypto';
import {nativeHintCanonical,type PdfNativeHints} from './pdf-native-hints.ts';
import {VISUAL_UNCERTAINTY_HEADER} from './pdf-visual-structure.ts';

const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const schema='pdf-visual-native-hint-cache-v1';
export function nativeHintCacheParser(sourceHash:string,model:string,hints:PdfNativeHints){
 return `${schema}:${sha(nativeHintCanonical({sourceHash,model,physicalPage:hints.sidecar.binding.physicalPage,
  sidecarSha256:hints.sidecarSha256,basePromptVersion:'selected-v3',imageInput:true,tiled:false}))}`;
}
/** Store the exact wire hash, sidecar and successful raw; never duplicate base64 PNGs in SQLite. */
export function encodeNativeHintCache(request:unknown,rawResponse:string,httpStatus:number,text:string,hints:PdfNativeHints){
 const requestWire=JSON.stringify(request);
 return JSON.stringify({schema,hints,requestSha256:sha(requestWire),httpStatus,
  rawResponse,rawResponseSha256:sha(rawResponse),text});
}
export function readNativeHintCache(body:string,request:unknown,hints:PdfNativeHints):string{
 let value,derivedText:string;
 try{
  value=JSON.parse(body);const response=JSON.parse(value.rawResponse);
  const raw=response.output_text||response.output?.flatMap((item:{content?:Array<{text?:string}>})=>item.content||[]).map((item:{text?:string})=>item.text||'').join('');
  const parsed=JSON.parse(raw||'{}'),notes=parsed.uncertain_spans;
  if(response.status!=='completed'||response.error||parsed.complete!==true||typeof parsed.text!=='string'||!Array.isArray(notes)||
   notes.some(note=>typeof note!=='string')||!['gpt-5.4-mini','gpt-5.4-mini-2026-03-17'].includes(response.model))throw new Error('invalid response');
  derivedText=(notes.length?VISUAL_UNCERTAINTY_HEADER+'\n'+notes.map((note:string)=>`[无法可靠辨认: ${note}]`).join('\n')+'\n':'')+parsed.text.trim();
 }catch{throw new Error('Native hint cache identity differs; preserved without automatic retry');}
 if(value.schema!==schema||nativeHintCanonical(value.hints)!==nativeHintCanonical(hints)||
  value.requestSha256!==sha(JSON.stringify(request))||
  !Number.isInteger(value.httpStatus)||value.httpStatus<200||value.httpStatus>=300||value.rawResponseSha256!==sha(value.rawResponse)||
  value.text!==derivedText)throw new Error('Native hint cache identity differs; preserved without automatic retry');
 return value.text;
}
