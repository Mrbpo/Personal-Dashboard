import {database as db} from './database.ts';
import {getIntegrationConnection,listCourseSettings} from './repository.ts';
import {gmailAttachment} from './gmail.ts';
import {saveDocument} from './library.ts';
import {validateAttachment} from './tutor.ts';
import {enqueue} from './jobs.ts';
export async function archiveMail(owner:string,id:string,course:string,attachment?:number){
 const connection=await getIntegrationConnection('gmail');if(connection?.metadata.owner!==owner)throw new Error('邮箱未连接');
 if(!course||!(await listCourseSettings()).some(c=>c.id===course&&c.enabled))throw new Error('请先选择归档课程');
 const m=await db.prepare('SELECT * FROM mail_messages WHERE id=? AND account=?').bind(id,String(connection.metadata.email)).first<any>();if(!m)throw new Error('邮件不存在');
 let bytes=Buffer.from(`${m.subject}\n${m.sender}\n${m.received_at}\n\n${m.body}`),name=m.subject.slice(0,120)+'.txt',mime='text/plain';
 if(attachment!==undefined){if(!Number.isInteger(attachment)||attachment<0)throw new Error('附件编号无效');const a=JSON.parse(m.attachments_json)[attachment];if(!a||a.size>8*1024*1024)throw new Error('附件不存在或超过 8 MB');bytes=await gmailAttachment(owner,id,attachment);const checked=validateAttachment(a.name,bytes);name=checked.name;mime=checked.mime;}
 const doc=await saveDocument(owner,course,'gmail',`${m.account}/${id}/${attachment??'body'}`,name,mime,bytes);await enqueue('index',{owner,id:doc},`index:${doc}`);return {id:doc};
}
