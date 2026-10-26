import { database as db } from './database.ts';
import { serviceValue } from './service-vault.ts';
import {createHash} from 'node:crypto';
const baseRates: Record<string,{input:number;output:number;context:number}> = {
  'gpt-5-mini': {input:0.25,output:2,context:400000},
  'gpt-5.4-mini': {input:0.75,output:4.5,context:400000},
  'gpt-6-astra': {input:10,output:50,context:1050000},
  'gpt-6.1-sol': {input:2,output:10,context:1050000},
  'text-embedding-3-small': {input:0.02,output:0,context:8192},
};
/** Explicit aliases/snapshots from the official model page, never a prefix match. */
export function isGpt54MiniProviderModel(model:unknown):boolean{
  return model==='gpt-5.4-mini'||model==='gpt-5.4-mini-2026-03-17';
}
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
function validateSolGeneration(body:any,allowImages=false):boolean{
  if(body.model!=='gpt-6.1-sol'||body.service_tier!=='default'||body.prompt_cache_retention!==undefined||
    body.prompt_cache_options?.mode!=='implicit'||body.prompt_cache_options?.ttl!=='30m'||
    Object.keys(body.prompt_cache_options).some(k=>!['mode','ttl'].includes(k))||body.tools?.length||
    !Number.isInteger(body.max_output_tokens)||body.max_output_tokens<1||body.max_output_tokens>6000||
    !Array.isArray(body.input)||body.input.some((m:any)=>typeof m?.content!=='string'&&
      (!Array.isArray(m?.content)||m.content.some((c:any)=>c?.type==='input_image'&&allowImages?
        c.detail!=='original'||typeof c.image_url!=='string'||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(c.image_url)||
          Object.keys(c).some(k=>!['type','detail','image_url'].includes(k)):
        c?.type!=='input_text'||typeof c.text!=='string'||c.prompt_cache_breakpoint!==undefined))))
    throw new Error('Sol candidate requires bounded Standard text-only or counted original-image generation with explicit 30m caching');
  const hasImages=body.input.some((m:any)=>Array.isArray(m.content)&&m.content.some((c:any)=>c.type==='input_image'));
  if(hasImages)assertSolCountProjection(body);
  return hasImages;
}
function assertSolCountProjection(body:any):void{
  if(Object.keys(body).some(k=>!['model','store','reasoning','max_output_tokens','input','text','service_tier','prompt_cache_options'].includes(k))||
    body.store!==false||body.input.some((m:any)=>Object.keys(m).some(k=>!['role','content'].includes(k))))
    throw new Error('Sol input counting does not support unmeasured request fields');
}
function solReservationForInput(inputUpper:number,maxOutput:number):number{
  const reserved=(inputUpper*5+maxOutput*10)/1e6;
  if(inputUpper>272000||reserved>.40)throw new Error('Sol candidate exceeds the verified per-request cost ceiling');
  return reserved;
}
/** Text has a conservative UTF-8 bound. Image bytes are never treated as tokens. */
export function solGenerationReservation(body:any):number{
  validateSolGeneration(body);
  return solReservationForInput(Buffer.byteLength(JSON.stringify(body))+4096,body.max_output_tokens);
}
async function countedSolReservation(body:any,wire:string,key:string,signal?:AbortSignal|null):Promise<number>{
  const hasImages=validateSolGeneration(body,true),byteUpper=Buffer.byteLength(wire)+4096;
  // A byte estimate may overstate a legitimate text input. Count that same
  // sealed request rather than dropping evidence or raising the cost ceiling.
  if(!hasImages&&byteUpper<=272000&&(byteUpper*5+body.max_output_tokens*10)/1e6<=.40)
    return solGenerationReservation(body);
  assertSolCountProjection(body);
  // A private projection of the sealed body includes every token-bearing field.
  // No client count, saved measurement, remote image or conversation is accepted.
  const countWire=JSON.stringify({model:body.model,input:body.input,reasoning:body.reasoning,text:body.text});
  const response=await fetch('https://api.openai.com/v1/responses/input_tokens',{method:'POST',
    headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:countWire,
    signal:signal||AbortSignal.timeout(120000)});
  const count=await response.json().catch(()=>null);
  if(!response.ok||count?.object!=='response.input_tokens'||!Number.isSafeInteger(count.input_tokens)||count.input_tokens<1)
    throw new Error('Sol input count failed; generation was not sent');
  const reserved=solReservationForInput(count.input_tokens+4096,body.max_output_tokens);
  // Log only count and hashes, never source text, image bytes or credentials.
  console.info('Sol counted generation budget',JSON.stringify({inputTokens:count.input_tokens,reserved,
    requestSha256:createHash('sha256').update(wire).digest('hex'),countRequestSha256:createHash('sha256').update(countWire).digest('hex')}));
  return reserved;
}
/** Unknown TTL splits/model/tier retain the reservation, including old responses. */
export function solGenerationCharge(payload:any):number|null{
  const u=payload?.usage,d=u?.input_tokens_details,w=d?.cache_write_tokens_details;
  const values=[u?.input_tokens,u?.output_tokens,d?.cached_tokens,d?.cache_write_tokens];
  if(payload?.model!=='gpt-6.1-sol'||payload.service_tier!=='default'||
    !values.every(n=>Number.isSafeInteger(n)&&n>=0)||u.input_tokens>272000||d.cached_tokens+d.cache_write_tokens>u.input_tokens)return null;
  let short=0,long=0;
  if(d.cache_write_tokens){
    if(![w?.ttl_30m_tokens,w?.ttl_12h_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)||
      w.ttl_30m_tokens+w.ttl_12h_tokens!==d.cache_write_tokens)return null;
    short=w.ttl_30m_tokens;long=w.ttl_12h_tokens;
  }else if(w&&(w.ttl_30m_tokens!==0||w.ttl_12h_tokens!==0))return null;
  return ((u.input_tokens-d.cached_tokens-d.cache_write_tokens)*2+d.cached_tokens*.1+short*2.5+long*5+u.output_tokens*10)/1e6;
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
  if(body.model!=='gpt-6.1-sol'&&process.env.AI_BUDGET_TEST_BYPASS==='true' && process.env.NODE_ENV!=='production') return fetch(`https://api.openai.com/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${serviceValue('OPENAI_API_KEY')}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  const rate=configuredRate(body.model);
  const sol=body.model==='gpt-6.1-sol';
  if(sol&&(endpoint!=='responses'||policy?.kind!=='document-answer'||
    (process.env.STUDY_ALLOW_CANDIDATE_GENERATION!=='true'&&process.env.KERNEL_ADMIN_DEVELOPMENT_RUN!=='true')))
    throw new Error('Sol generation requires explicit application configuration or isolated study development');
  // Seal before the first await: callers cannot mutate evidence/model/schema
  // between the count, budget reservation and generation transmission.
  const solWire=sol?JSON.stringify(body):undefined;
  if(sol)body=JSON.parse(solWire!);
  if(sol)validateSolGeneration(body,true);
  if(!serviceValue('OPENAI_API_KEY')) throw new Error('请先配置 OpenAI API Key');
  const key=serviceValue('OPENAI_API_KEY');
  const solReserved=sol?await countedSolReservation(body,solWire!,key,signal):undefined;
  const maxOutput=endpoint==='embeddings'?0:Number(body.max_output_tokens);
  if(!Number.isFinite(maxOutput) || maxOutput<0 || maxOutput>128000) throw new Error('回答长度上限无效');
  // Reserve against a conservative estimate of this request, not the model's
  // entire context window. Successful calls are settled with provider usage;
  // ambiguous timeouts retain this bounded reservation.
  const inputBytes=Buffer.byteLength(JSON.stringify(policy?.kind==='document-answer'?body:body.input??body));
  const astra=body.model==='gpt-6-astra';
  // Astra's UTF-8 byte bound includes schema/request overhead. Reserve all
  // input at the highest possible cache-write rate; cached reads settle lower.
  const tokens=endpoint==='embeddings'?inputBytes:astra?
    Math.min(rate.context,Buffer.byteLength(JSON.stringify(body))+4096):Math.min(rate.context,Math.max(1000,Math.ceil(inputBytes/2)));
  const longInput=astra&&tokens>272000;
  const toolMax=body.tools?.length ? Math.max(1,body.max_tool_calls || 1) * 0.02 : 0;
  const reserved=solReserved??Math.max(0.000001,(tokens*rate.input*(astra?1.25:1)*(longInput?2:1)+maxOutput*rate.output*(longInput?1.5:1))/1e6+toolMax);
  const id=await reserveBudget(reserved,policy?.kind||endpoint,policy?.dailyLimit);
  // On an ambiguous timeout keep the reservation: provider may have already billed it.
  const response=await fetch(`https://api.openai.com/v1/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:solWire??JSON.stringify(body),signal:signal || AbortSignal.timeout(120000)});
  const p=await response.clone().json().catch(()=>null);
  if(response.ok && p?.usage) {
    // An unverified model must not be settled at the requested mini rate.
    // Preserve its reservation for reconciliation; the answer layer rejects it.
    if(body.model==='gpt-5.4-mini'&&!isGpt54MiniProviderModel(p.model))return response;
    const input=Number(p.usage.input_tokens ?? p.usage.prompt_tokens),output=Number(p.usage.output_tokens ?? 0);
    if(Number.isFinite(input)&&input>=0&&Number.isFinite(output)&&output>=0){
      let charged=(input*rate.input+output*rate.output)/1e6+toolMax;
      if(sol){
        const verified=solGenerationCharge(p);
        if(verified===null||verified>reserved)return response;
        charged=verified;
      }
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
