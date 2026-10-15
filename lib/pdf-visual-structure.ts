/** A structural gate only: no TeX expansion, correction or fidelity claim. */
export const VISUAL_UNCERTAINTY_HEADER='[本页存在无法可靠辨认的片段，须核对原 PDF]';
export function visualTextControlIssue(text:string):string|null{
 const match=/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.exec(text);
 return match?`不允许的控制字符 U+${match[0].charCodeAt(0).toString(16).toUpperCase().padStart(4,'0')}（位置 ${match.index}）`:null;
}

export function visualMathStructureIssue(text:string):string|null{
 const stack:Array<{kind:'math'|'environment';name:string}>=[];
 let mathOpen=false;
 const environment=/\\(begin|end)(?![A-Za-z])\s*\{([^{}\\]*)\}/uy;
 for(let index=0;index<text.length;index++){
  if(text[index]!=='\\')continue;
  const next=text[index+1];
  // A literal escaped backslash or a matrix row break is not a math marker.
  if(next==='\\'){index++;continue;}
  if(next==='('||next==='['){
   if(mathOpen)return `数学边界不能嵌套（位置 ${index}）`;
   stack.push({kind:'math',name:next});mathOpen=true;index++;continue;
  }
  if(next===')'||next===']'){
   const current=stack.pop();
   if(current?.kind!=='math'||current.name!==(next===')'?'(':'['))return `数学边界不配对（位置 ${index}）`;
   mathOpen=false;index++;continue;
  }
  if(!/^\\(?:begin|end)(?![A-Za-z])/u.test(text.slice(index,index+7)))continue;
  environment.lastIndex=index;
  const token=environment.exec(text);
  if(!token||!token[2].trim())return `环境边界不完整（位置 ${index}）`;
  if(token[1]==='begin')stack.push({kind:'environment',name:token[2]});
  else{
   const current=stack.pop();
   if(current?.kind!=='environment'||current.name!==token[2])return `环境嵌套不配对（位置 ${index}）`;
  }
  index=environment.lastIndex-1;
 }
 return stack.length?'数学或环境缺少结束边界':null;
}

export class PdfVisualStructureError extends Error{
 readonly code:'PDF_VISUAL_TEXT_STRUCTURE_INVALID'|'PDF_VISUAL_CACHE_STRUCTURE_UNVERIFIED';
 declare readonly rawOutput:string;
 declare readonly rawFormat:'provider-output-json'|'cached-page-text';
 constructor(message:string,code:PdfVisualStructureError['code'],rawOutput:string,rawFormat:PdfVisualStructureError['rawFormat']){
  super(message);this.name='PdfVisualStructureError';this.code=code;
  // Explicitly accessible to an isolated diagnostic runner, absent from ordinary
  // JSON/log inspection. Never interpolate document contents into the message.
  Object.defineProperties(this,{rawOutput:{value:rawOutput},rawFormat:{value:rawFormat}});
 }
}

export function assertVisualCacheStructure(body:string,pageNumber:number):void{
 const controls=visualTextControlIssue(body);
 if(controls)throw new PdfVisualStructureError(`第 ${pageNumber} 页视觉缓存结构无效：${controls}；原值保留，未重新请求`,
  'PDF_VISUAL_TEXT_STRUCTURE_INVALID',body,'cached-page-text');
 // Multiline notes and page text have no unambiguous boundary in this legacy
 // flat body. Refuse reuse rather than guessing a split or interpreting notes.
 if(body.startsWith(VISUAL_UNCERTAINTY_HEADER))throw new PdfVisualStructureError(
  `第 ${pageNumber} 页带告警的视觉缓存正文边界未结构认证，须审核；原值保留，未重新请求`,
  'PDF_VISUAL_CACHE_STRUCTURE_UNVERIFIED',body,'cached-page-text');
 const math=visualMathStructureIssue(body);
 if(math)throw new PdfVisualStructureError(`第 ${pageNumber} 页视觉缓存结构无效：${math}；原值保留，未重新请求`,
  'PDF_VISUAL_TEXT_STRUCTURE_INVALID',body,'cached-page-text');
}
