import {apiOwner,apiError} from '@/lib/api-guard';
import {buildMailContext,searchRelatedMail} from '@/lib/mail-intelligence';

export async function GET(r:Request,{params}:{params:Promise<{id:string}>}){try{const owner=await apiOwner(r),id=(await params).id,context=await buildMailContext(owner,id),related=await searchRelatedMail(owner,id);return Response.json({senderProfile:context.senderProfile,thread:context.thread.map((item:{id:string;subject:string;sender:string;received_at:string})=>({id:item.id,subject:item.subject,sender:item.sender,received_at:item.received_at})),feedback:context.feedback,patterns:context.patterns,related},{headers:{'Cache-Control':'no-store'}});}catch(error){return apiError(error);}}
