import { database as db } from './database.ts';
import { serviceValue } from './service-vault.ts';
const baseRates: Record<string,{input:number;output:number;context:number}> = {
  'gpt-5-mini': {input:0.25,output:2,context:400000},
  'text-embedding-3-small': {input:0.02,output:0,context:8192},
};
function configuredRate(model:string){
  const extra=JSON.parse(serviceValue('AI_MODEL_RATES') || '{}');
  const rate=extra[model] || baseRates[model];
  if(!rate || ![rate.input,rate.output,rate.context].every((n:unknown)=>typeof n==='number' && Number.isFinite(n) && n>=0) || rate.context===0) throw new Error('此模型尚未配置计费单价和上下文上限，请到接入设置配置');
  return rate as {input:number;output:number;context:number};
}
export function estimateEmbeddingReservation(input:string[],model:string){
  const rate=configuredRate(model);
  return Math.max(0.000001,Buffer.byteLength(JSON.stringify(input))*rate.input/1e6);
}
export function budgetMonth(now = new Date()) { return now.toLocaleDateString('en-CA',{timeZone:'America/Toronto'}).slice(0,7); }
export async function budgetStatus() {
  const r = await db.prepare('SELECT COALESCE(SUM(COALESCE(charged,reserved)),0) used FROM ai_ledger WHERE month=?').bind(budgetMonth()).first<{used:number}>();
  return {limit: Math.max(0,Number(serviceValue('AI_MONTHLY_BUDGET') || 30)), used:Number(r?.used || 0), month:budgetMonth()};
}
export async function reserveBudget(amount:number,kind:string,dailyLimit?:number) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('费用估算不可用');
  if(dailyLimit!==undefined&&(!Number.isInteger(dailyLimit)||dailyLimit<1))throw new Error('每日请求上限无效');
  const id=crypto.randomUUID(), month=budgetMonth(), {limit}=await budgetStatus(),now=Date.now(),dayStart=Math.floor(now/86400000)*86400000;
  const r=await db.prepare(`INSERT INTO ai_ledger SELECT ?, ?, ?, ?, NULL, 'reserved', ? WHERE
    (SELECT COALESCE(SUM(COALESCE(charged,reserved)),0) FROM ai_ledger WHERE month=?) + ? <= ?
    AND (? IS NULL OR (SELECT COUNT(*) FROM ai_ledger WHERE kind=? AND created_at>=? AND created_at<?) < ?)`).bind(id,month,kind,amount,now,month,amount,limit,dailyLimit??null,kind,dayStart,dayStart+86400000,dailyLimit??0).run();
  if(!r.rowsAffected) throw new Error('AI 预算或每日请求上限已到；同步与已存资料仍可使用');
  return id;
}
export async function paidOpenAI(endpoint:'responses'|'embeddings',body:any,signal?:AbortSignal|null,policy?:{kind:string;dailyLimit:number}) {
  if(process.env.AI_BUDGET_TEST_BYPASS==='true' && process.env.NODE_ENV!=='production') return fetch(`https://api.openai.com/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${serviceValue('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const rate=configuredRate(body.model);
  if(!serviceValue('OPENAI_API_KEY')) throw new Error('请先配置 OpenAI API Key');
  const maxOutput=endpoint==='embeddings'?0:Number(body.max_output_tokens);
  if(!Number.isFinite(maxOutput) || maxOutput<0 || maxOutput>128000) throw new Error('回答长度上限无效');
  // Reserve against a conservative estimate of this request, not the model's
  // entire context window. Successful calls are settled with provider usage;
  // ambiguous timeouts retain this bounded reservation.
  const inputBytes=Buffer.byteLength(JSON.stringify(body.input??body));
  const tokens=endpoint==='embeddings'?inputBytes:Math.min(rate.context,Math.max(1000,Math.ceil(inputBytes/2)));
  const toolMax=body.tools?.length ? Math.max(1,body.max_tool_calls || 1) * 0.02 : 0;
  const reserved=Math.max(0.000001,(tokens*rate.input+maxOutput*rate.output)/1e6+toolMax);
  const id=await reserveBudget(reserved,policy?.kind||endpoint,policy?.dailyLimit);
  // On an ambiguous timeout keep the reservation: provider may have already billed it.
  const response=await fetch(`https://api.openai.com/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${serviceValue('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal || AbortSignal.timeout(120000)});
  const p=await response.clone().json().catch(()=>null);
  if(response.ok && p?.usage) {
    const input=Number(p.usage.input_tokens ?? p.usage.prompt_tokens),output=Number(p.usage.output_tokens ?? 0);
    if(Number.isFinite(input)&&Number.isFinite(output)) await db.prepare("UPDATE ai_ledger SET charged=?,status='settled' WHERE id=?").bind((input*rate.input+output*rate.output)/1e6+toolMax,id).run();
  } else if(!response.ok && response.status<500) await db.prepare("UPDATE ai_ledger SET charged=0,status='rejected' WHERE id=?").bind(id).run();
  return response;
}
