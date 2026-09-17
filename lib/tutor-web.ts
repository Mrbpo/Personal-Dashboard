import { paidOpenAI } from './ai-budget.ts';
import { serviceValue } from './service-vault.ts';
// Only predefined public academic queries are auto-searched. No email/file/history is sent to search.
const concepts:[RegExp,string][]=[[/摩尔|molar/i,'molarity molality chemistry explanation'],[/酸碱|\bpH\b/i,'pH acid base chemistry explanation'],[/滴定|titrat/i,'acid base titration equivalence point explanation'],[/标准差|standard deviation/i,'standard deviation statistics explanation'],[/概率|probability/i,'conditional probability statistics explanation'],[/导数|derivative/i,'derivative calculus explanation'],[/积分|integral/i,'integral calculus explanation'],[/细胞|cell biology/i,'cell biology introduction'],[/牛顿|newton/i,'Newton laws physics explanation'],[/有效数字|significant figures/i,'significant figures chemistry rules']];
export function publicAcademicQuery(question:string){return concepts.find(([pattern])=>pattern.test(question))?.[1] || '';}
export function validatedPublicQuery(query:string){const q=query.trim();if(q.length>180||/[\r\n@]|https?:|[A-Z]:[\\/]|\b(?:sk-|ghp_|Bearer\s)/i.test(q))throw new Error('公开搜索词最多 180 字，请勿包含邮箱、链接、文件路径或密钥');return q;}
export async function tutorWeb(question:string,enabled:boolean,publicQuery='') {
  const query=enabled?(validatedPublicQuery(publicQuery)||publicAcademicQuery(question)):'';if(!query)return {text:'',links:[] as {url:string;title:string}[],query:''};
  const r=await paidOpenAI('responses',{model:serviceValue('OPENAI_MODEL')||'gpt-5-mini',store:false,input:`Search authoritative educational sources for: ${query}. Briefly explain in Chinese and cite sources.`,tools:[{type:'web_search'}],max_tool_calls:1,max_output_tokens:1500});
  if(!r.ok)throw new Error('联网暂时不可用，可关闭联网后重试');
  const p=await r.json();const items=p.output?.flatMap((i:any)=>i.content||[])||[];
  return {query,text:items.map((i:any)=>i.text||'').join('\n'),links:items.flatMap((i:any)=>i.annotations||[]).filter((a:any)=>a.type==='url_citation'&&/^https?:\/\//.test(a.url)).map((a:any)=>({url:a.url,title:a.title||a.url}))};
}
