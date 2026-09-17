import {database as db} from './database.ts';
import {getIntegrationConnection} from './repository.ts';
import {digest} from './library.ts';

// Only an explicit, owner-confirmed time creates an event. AI text never supplies commands.
export async function confirmReview(owner:string,value:{source:string;id:string;title:string;start:string;minutes:number}) {
 if(!['mail','tutor'].includes(value.source)||!value.title?.trim()||value.title.length>200)throw new Error('日程内容无效');
 const start=new Date(value.start),minutes=Number(value.minutes);
 if(!Number.isFinite(start.getTime())||!Number.isInteger(minutes)||minutes<5||minutes>480)throw new Error('请确认开始时间及 5–480 分钟的时长');
 let text='';
 if(value.source==='tutor'){
  const row=await db.prepare("SELECT m.body FROM tutor_messages m JOIN tutor_threads t ON t.id=m.thread_id WHERE m.id=? AND t.owner_id=? AND m.role='assistant'").bind(value.id,owner).first<{body:string}>();
  if(!row)throw new Error('学习记录不存在');text=row.body;
 }else{
  const connection=await getIntegrationConnection('gmail');if(connection?.metadata.owner!==owner)throw new Error('邮件不存在');
  const row=await db.prepare('SELECT subject FROM mail_messages WHERE id=? AND account=?').bind(value.id,String(connection.metadata.email)).first<{subject:string}>();
  if(!row)throw new Error('邮件不存在');text=row.subject;
 }
 const end=new Date(start.getTime()+minutes*60000).toISOString(),at=start.toISOString();
 const id=digest([owner,value.source,value.id,value.title.trim(),at].join('\0'));
 const existing=await db.prepare('SELECT id FROM schedule_events WHERE id=?').bind(id).first();if(existing)return {id};
 const conflict=await db.prepare('SELECT id FROM schedule_events WHERE start_at<? AND end_at>? LIMIT 1').bind(end,at).first();
 if(conflict)throw new Error('这个时间与已有日程重叠，请调整时间；原日程未改变');
 await db.prepare('INSERT OR IGNORE INTO schedule_events (id,external_uid,source_name,title,description,start_at,end_at,all_day,updated_at) VALUES (?,?,?,?,?,?,?,0,?)').bind(id,id,'已确认学习建议',value.title.trim(),`来源：${value.source}/${value.id}\n${text.slice(0,2000)}`,at,end,new Date().toISOString()).run();
 return {id};
}
