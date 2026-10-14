import { database as db } from './database.ts';
import { serviceValue } from './service-vault.ts';
const baseRates: Record<string,{input:number;output:number;context:number}> = {
  'gpt-5-mini': {input:0.25,output:2,context:400000},
  'gpt-6-astra': {input:10,output:50,context:1050000},
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
export class AiBudgetDeferredError extends Error {
  readonly reason:'daily'|'monthly'|'reservation-race';
  readonly retryAt:Date;
  constructor(reason:'daily'|'monthly'|'reservation-race',retryAt:Date){
    super('AI 预算或每日请求上限已到；同步与已存资料仍可使用');
    this.name='AiBudgetDeferredError';this.reason=reason;this.retryAt=retryAt;
  }
}
export function nextBudgetMonth(now:Date):Date {
  const [year,month]=budgetMonth(now).split('-').map(Number);
  let lo=Date.UTC(year,month,1),hi=lo+36*3600000;
  const current=budgetMonth(now);
  // Find the actual Toronto month boundary, including its DST offset.
  while(hi-lo>1){const mid=Math.floor((lo+hi)/2);if(budgetMonth(new Date(mid))===current)lo=mid;else hi=mid;}
  return new Date(hi);
}
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
  if(!r.rowsAffected){
    const fresh=await budgetStatus();
    const daily=dailyLimit===undefined?0:Number((await db.prepare('SELECT count(*) n FROM ai_ledger WHERE kind=? AND created_at>=? AND created_at<?')
      .bind(kind,dayStart,dayStart+86400000).first<{n:number}>())?.n||0);
    const monthlyBlocked=fresh.used+amount>fresh.limit,dailyBlocked=dailyLimit!==undefined&&daily>=dailyLimit;
    const at=Math.max(monthlyBlocked?nextBudgetMonth(new Date(now)).getTime():0,dailyBlocked?dayStart+86400000:0,now+60000);
    throw new AiBudgetDeferredError(monthlyBlocked?'monthly':dailyBlocked?'daily':'reservation-race',new Date(at));
  }
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
  const astra=body.model==='gpt-6-astra';
  // Astra's UTF-8 byte bound includes schema/request overhead. Reserve all
  // input at the highest possible cache-write rate; cached reads settle lower.
  const tokens=endpoint==='embeddings'?inputBytes:astra?
    Math.min(rate.context,Buffer.byteLength(JSON.stringify(body))+4096):Math.min(rate.context,Math.max(1000,Math.ceil(inputBytes/2)));
  const longInput=astra&&tokens>272000;
  const toolMax=body.tools?.length ? Math.max(1,body.max_tool_calls || 1) * 0.02 : 0;
  const reserved=Math.max(0.000001,(tokens*rate.input*(astra?1.25:1)*(longInput?2:1)+maxOutput*rate.output*(longInput?1.5:1))/1e6+toolMax);
  const id=await reserveBudget(reserved,policy?.kind||endpoint,policy?.dailyLimit);
  // On an ambiguous timeout keep the reservation: provider may have already billed it.
  const response=await fetch(`https://api.openai.com/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${serviceValue('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:signal || AbortSignal.timeout(120000)});
  const p=await response.clone().json().catch(()=>null);
  if(response.ok && p?.usage) {
    const input=Number(p.usage.input_tokens ?? p.usage.prompt_tokens),output=Number(p.usage.output_tokens ?? 0);
    if(Number.isFinite(input)&&input>=0&&Number.isFinite(output)&&output>=0){
      let charged=(input*rate.input+output*rate.output)/1e6+toolMax;
      if(astra){
        const actualInput=p.usage.input_tokens,actualOutput=p.usage.output_tokens;
        const details=p.usage.input_tokens_details;
        const cached=details?.cached_tokens===undefined?0:details.cached_tokens,written=details?.cache_write_tokens===undefined?0:details.cache_write_tokens;
        // Malformed usage or an unexpected model cannot silently undercharge.
        // Keep the durable reservation pending a provider/operator reconciliation.
        if(p.model!==body.model||![actualInput,actualOutput,cached,written].every(n=>typeof n==='number'&&Number.isInteger(n)&&n>=0)||cached+written>input)return response;
        const long=input>272000;
        charged=((input-cached-written+cached*.1+written*1.25)*rate.input*(long?2:1)+output*rate.output*(long?1.5:1))/1e6+toolMax;
      }
      await db.prepare("UPDATE ai_ledger SET charged=?,status='settled' WHERE id=?").bind(charged,id).run();
    }
  } else if(!response.ok && response.status<500) await db.prepare("UPDATE ai_ledger SET charged=0,status='rejected' WHERE id=?").bind(id).run();
  return response;
}
