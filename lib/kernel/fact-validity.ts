/** Read-time validity is authoritative. Projection rows are only a disposable cache. */
export type FactValidityBasis = 'explicit'|'published'|'observed'|'unknown';
export type FactValidityInput = {
  validFrom?: string|null; validTo?: string|null; validityBasis?: FactValidityBasis;
  version?: number; currentVersion?: number; confirmation?: string; pendingConflict?: boolean;
  sourceMissing?: boolean; cancelled?: boolean; completed?: boolean; ignored?: boolean;
  sourceCheckedAt?:string|null;sourceStaleAfterMs?:number;courseTimezone?:string|null;sourceChanged?:boolean;
  due?: {date?:string|null;at?:string|null;timezone?:string|null;precision?:string|null}|null;
  eventEnd?:string|null; courseEndsAt?:string|null; termEndsOn?:string|null;
};
export type FactValidity = {
  time:'current'|'not_yet_valid'|'expired'|'unknown';
  version:'current'|'superseded'|'unknown';
  confirmation:'confirmed'|'conflict_pending'|'pending'|'unknown';
  source:'available'|'source_missing';
  sourceFreshness:'fresh'|'stale'|'unknown';
  sourceVerification:'current'|'pending_verification';
  action:'active'|'overdue'|'completed'|'cancelled'|'ignored'|'ended'|'unknown';
  validityBasis:FactValidityBasis; courseEnded:boolean; termEnded:boolean|null;
};
export function factInstant(value:unknown):number|null {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return null;
  if(!factCalendarDate(value.slice(0,10))||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||
    /^\d{2}/.test(value.slice(17,19))&&Number(value.slice(17,19))>59)return null;
  const at=Date.parse(value);return Number.isFinite(at)?at:null;
}
export function factCalendarDate(value:unknown):value is string {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(`${value}T00:00:00Z`);return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
export function factLocalDate(clock:Date,timezone:string|null|undefined):string|null {
  if(!timezone)return null;
  try {
    const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(clock);
    const part=(kind:string)=>parts.find(item=>item.type===kind)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }catch{return null;}
}
export function evaluateFactValidity(input:FactValidityInput,clock:Date|string):FactValidity {
  const now=typeof clock==='string'?factInstant(clock):clock.getTime();
  if(now===null||!Number.isFinite(now))throw new Error('Validity requires an explicit valid clock instant');
  const basis=input.validityBasis??'unknown',from=factInstant(input.validFrom),to=factInstant(input.validTo);
  const checked=factInstant(input.sourceCheckedAt),staleAfter=input.sourceStaleAfterMs??7*86400000;
  const termToday=factLocalDate(new Date(now),input.courseTimezone);
  // Observed/published timestamps never prove when a policy became effective.
  const time:FactValidity['time']=basis==='explicit'
    ? from!==null&&now<from?'not_yet_valid':to!==null&&now>=to?'expired':from!==null?'current':'unknown'
    : from!==null&&now<from?'not_yet_valid':'unknown';
  let action:FactValidity['action']='active';
  if(input.cancelled)action='cancelled';
  else if(input.completed)action='completed';
  else if(input.ignored)action='ignored';
  else if(input.eventEnd&&factInstant(input.eventEnd)!==null&&now>=factInstant(input.eventEnd)!)action='ended';
  else if(input.due){
    const due=input.due,at=factInstant(due.at);
    if(at!==null)action=now>at?'overdue':'active';
    else if(due.precision==='date'&&factCalendarDate(due.date)){
      const today=factLocalDate(new Date(now),due.timezone);
      action=today===null?'unknown':today>due.date?'overdue':'active';
    }else action='unknown';
  }
  return {time,version:input.version===undefined||input.currentVersion===undefined?'unknown':
    input.version===input.currentVersion?'current':'superseded',
    confirmation:input.pendingConflict?'conflict_pending':input.confirmation==='accepted'?'confirmed':
      input.confirmation==='pending'?'pending':'unknown',source:input.sourceMissing?'source_missing':'available',action,
    sourceFreshness:checked===null||checked>now||!Number.isFinite(staleAfter)||staleAfter<0?'unknown':now-checked>staleAfter?'stale':'fresh',
    sourceVerification:input.sourceChanged?'pending_verification':'current',
    validityBasis:basis,courseEnded:factInstant(input.courseEndsAt)!==null&&now>=factInstant(input.courseEndsAt)!,
    termEnded:factCalendarDate(input.termEndsOn)&&termToday!==null?termToday>input.termEndsOn:null};
}
