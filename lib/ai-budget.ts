import { database as db } from './database.ts';
import { serviceValue } from './service-vault.ts';
const baseRates: Record<string,{input:number;output:number;context:number}> = {
  'gpt-5-mini': {input:0.25,output:2,context:400000},
  'text-embedding-3-small': {input:0.02,output:0,context:8192},
};
export function budgetMonth(now = new Date()) { return now.toLocaleDateString('en-CA',{timeZone:'America/Toronto'}).slice(0,7); }
export async function budgetStatus() {
  const r = await db.prepare('SELECT COALESCE(SUM(COALESCE(charged,reserved)),0) used FROM ai_ledger WHERE month=?').bind(budgetMonth()).first<{used:number}>();
  return {limit: Math.max(0,Number(serviceValue('AI_MONTHLY_BUDGET') || 30)), used:Number(r?.used || 0), month:budgetMonth()};
}
export async function reserveBudget(amount:number,kind:string) {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('费用估算不可用');
  const id=crypto.randomUUID(), month=budgetMonth(), {limit}=await budgetStatus();
  const r=await db.prepare(`INSERT INTO ai_ledger SELECT ?, ?, ?, ?, NULL, 'reserved', ? WHERE
    (SELECT COALESCE(SUM(COALESCE(charged,reserved)),0) FROM ai_ledger WHERE month=?) + ? <= ?`).bind(id,month,kind,amount,Date.now(),month,amount,limit).run();
  if(!r.rowsAffected) throw new Error('本月 AI 预算不足；同步与已存资料仍可使用');
  return id;
}
export async function paidOpenAI(endpoint:'responses'|'embeddings',body:any,signal?:AbortSignal|null) {
  if(process.env.AI_BUDGET_TEST_BYPASS==='true' && process.env.NODE_ENV!=='production') return fetch(`https://api.openai.com/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${serviceValue('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const extra=JSON.parse(serviceValue('AI_MODEL_RATES') || '{}');
  const rate=extra[body.model] || baseRates[body.model];
  if(!rate || ![rate.input,rate.output,rate.context].every((n:unknown)=>typeof n==='number' && Number.isFinite(n) && n>=0) || rate.context===0) throw new Error('此模型尚未配置计费单价和上下文上限，请到接入设置配置');
  if(!serviceValue('OPENAI_API_KEY')) throw new Error('请先配置 OpenAI API Key');
  const maxOutput=endpoint==='embeddings'?0:Number(body.max_output_tokens);
  if(!Number.isFinite(maxOutput) || maxOutput<0 || maxOutput>128000) throw new Error('回答长度上限无效');
  const tokens=endpoint==='embeddings'?Buffer.byteLength(JSON.stringify(body.input)):rate.context;
  const toolMax=body.tools?.length ? Math.max(1,body.max_tool_calls || 1) * 0.02 : 0;
  const reserved=Math.max(0.000001,(tokens*rate.input+maxOutput*rate.output)/1e6+toolMax);
  const id=await reserveBudget(reserved,endpoint);
  // On an ambiguous timeout keep the reservation: provider may have already billed it.
  const response=await fetch(`https://api.openai.com/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${serviceValue('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal || AbortSignal.timeout(120000)});
  const p=await response.clone().json().catch(()=>null);
  if(response.ok && p?.usage) {
    const input=Number(p.usage.input_tokens ?? p.usage.prompt_tokens),output=Number(p.usage.output_tokens ?? 0);
    if(Number.isFinite(input)&&Number.isFinite(output)) await db.prepare("UPDATE ai_ledger SET charged=?,status='settled' WHERE id=?").bind((input*rate.input+output*rate.output)/1e6+toolMax,id).run();
  } else if(!response.ok && response.status<500) await db.prepare("UPDATE ai_ledger SET charged=0,status='rejected' WHERE id=?").bind(id).run();
  return response;
}
