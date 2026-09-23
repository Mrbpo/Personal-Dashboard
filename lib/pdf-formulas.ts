// A text layer is the source of truth for prose. Formula recognition augments it;
// it must never replace selectable PDF text with a model's reconstruction.
export function mayContainPdfMath(text:string){
 return /[=≠≤≥≈∑∫√∞∂∇±×÷∈⊂∀∃∑∏∮∝∼⁰¹²³⁴⁵⁶⁷⁸⁹]/u.test(text)
  || /[A-Za-z0-9]\s*[+^]\s*[A-Za-z0-9]/u.test(text)
  || /\\(?:frac|sqrt|sum|int|alpha|beta|theta|lambda|pi|begin)\b/u.test(text)
  || /\b(?:equation|formula|theorem|integral|derivative|matrix|variance|probability|gradient)\b/iu.test(text);
}

export function appendPdfLatex(text:string,formulae:unknown,complete:unknown){
 if(!Array.isArray(formulae))return text;
 const latex=formulae.flatMap((item:unknown)=>{
  if(typeof item!=='string')return [];
  let value=item.trim();
  if(value.startsWith('$$')&&value.endsWith('$$'))value=value.slice(2,-2).trim();
  else if(value.startsWith('\\[')&&value.endsWith('\\]'))value=value.slice(2,-2).trim();
  else if(value.startsWith('$')&&value.endsWith('$'))value=value.slice(1,-1).trim();
  if(!value||value.length>2000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))return [];
  return [value];
 }).slice(0,80);
 if(!latex.length)return complete===false?`${text}\n\n[本页公式识别不完整，请核对原 PDF]`:text;
 return `${text}\n\n[以下 LaTeX 公式由 PDF 原页视觉识别，请核对原页]\n${latex.map(value=>`\\[${value}\\]`).join('\n')}${complete===false?'\n[部分公式无法可靠识别，请核对原 PDF]':''}`;
}
