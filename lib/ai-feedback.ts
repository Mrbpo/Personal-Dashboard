import {database as db} from './database.ts';

const sourceTypes=new Set(['mail','mail-thread','tutor','health','course-summary','library-extraction','course-analysis']);
export async function saveAiFeedback(owner:string,value:{sourceType:string;sourceId:string;rating:number;reason?:string;metadata?:Record<string,unknown>}){
 if(!sourceTypes.has(value.sourceType)||!value.sourceId||value.sourceId.length>500||![1,-1].includes(Number(value.rating)))throw new Error('反馈内容无效');
 const now=new Date().toISOString(),reason=String(value.reason||'').trim().slice(0,1000),metadata=JSON.stringify(value.metadata||{}).slice(0,4000);
 await db.prepare(`INSERT INTO ai_content_feedback (id,owner_id,source_type,source_id,rating,reason,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,source_type,source_id) DO UPDATE SET rating=excluded.rating,reason=excluded.reason,metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`).bind(crypto.randomUUID(),owner,value.sourceType,value.sourceId,Number(value.rating),reason,metadata,now,now).run();
 return {ok:true};
}
export async function aiFeedbackSummary(owner:string){const [totals,recent]=await Promise.all([db.prepare('SELECT source_type,rating,COUNT(*) count FROM ai_content_feedback WHERE owner_id=? GROUP BY source_type,rating ORDER BY source_type,rating').bind(owner).all(),db.prepare('SELECT source_type,source_id,rating,reason,metadata_json,updated_at FROM ai_content_feedback WHERE owner_id=? ORDER BY updated_at DESC LIMIT 100').bind(owner).all()]);return {totals:totals.results,recent:recent.results};}
